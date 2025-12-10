import { Hono } from "hono";
import { Env } from "../types";
import { geminiCliModels, getAllModelIds } from "../models";
import { AuthManager } from "../auth";
import { GeminiApiClient } from "../gemini-client";
import { createGeminiNativeStreamTransformer } from "../stream-transformer";
import {
    GeminiNativeRequest,
    GeminiNativeModelInfo,
    GeminiNativeModelsResponse
} from "../types/gemini-native";

/**
 * Gemini Native API routes.
 * Provides Gemini-compatible endpoints for LiteLLM integration with native thought_signature support.
 */
export const GeminiRoute = new Hono<{ Bindings: Env }>();

/**
 * List available models in Gemini format.
 * GET /models
 */
GeminiRoute.get("/models", async (c) => {
    const models: GeminiNativeModelInfo[] = getAllModelIds().map((modelId) => {
        const info = geminiCliModels[modelId];
        return {
            name: `models/${modelId}`,
            displayName: modelId,
            description: info.description,
            inputTokenLimit: info.contextWindow,
            outputTokenLimit: info.maxTokens,
            supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
        };
    });

    const response: GeminiNativeModelsResponse = { models };
    return c.json(response);
});

/**
 * Get specific model info.
 * GET /models/:model
 */
GeminiRoute.get("/models/:model", async (c) => {
    const modelParam = c.req.param("model");
    // Handle models/model-name format
    const modelId = modelParam.startsWith("models/") ? modelParam.slice(7) : modelParam;

    if (!(modelId in geminiCliModels)) {
        return c.json(
            {
                error: {
                    code: 404,
                    message: `Model not found: ${modelId}`,
                    status: "NOT_FOUND"
                }
            },
            404
        );
    }

    const info = geminiCliModels[modelId];
    const modelInfo: GeminiNativeModelInfo = {
        name: `models/${modelId}`,
        displayName: modelId,
        description: info.description,
        inputTokenLimit: info.contextWindow,
        outputTokenLimit: info.maxTokens,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"]
    };

    return c.json(modelInfo);
});

/**
 * Parse model and action from path like "gemini-2.5-flash:generateContent"
 */
function parseModelAction(pathParam: string): { model: string; action: string } | null {
    // Handle format: model:action (e.g., gemini-2.5-flash:generateContent)
    const colonIndex = pathParam.lastIndexOf(":");
    if (colonIndex === -1) {
        return null;
    }

    const model = pathParam.slice(0, colonIndex);
    const action = pathParam.slice(colonIndex + 1);

    return { model, action };
}

/**
 * Generate content (non-streaming).
 * POST /models/:model:generateContent
 */
GeminiRoute.post("/models/:modelAction", async (c) => {
    const modelAction = c.req.param("modelAction");
    const parsed = parseModelAction(modelAction);

    if (!parsed) {
        return c.json(
            {
                error: {
                    code: 400,
                    message: "Invalid request format. Expected: /models/{model}:{action}",
                    status: "INVALID_ARGUMENT"
                }
            },
            400
        );
    }

    const { model: modelId, action } = parsed;

    // Validate model
    if (!(modelId in geminiCliModels)) {
        return c.json(
            {
                error: {
                    code: 404,
                    message: `Model not found: ${modelId}. Available models: ${getAllModelIds().join(", ")}`,
                    status: "NOT_FOUND"
                }
            },
            404
        );
    }

    // Validate action
    if (action !== "generateContent" && action !== "streamGenerateContent") {
        return c.json(
            {
                error: {
                    code: 400,
                    message: `Invalid action: ${action}. Supported actions: generateContent, streamGenerateContent`,
                    status: "INVALID_ARGUMENT"
                }
            },
            400
        );
    }

    try {
        const body = await c.req.json<GeminiNativeRequest>();

        // Validate request
        if (!body.contents || !Array.isArray(body.contents) || body.contents.length === 0) {
            return c.json(
                {
                    error: {
                        code: 400,
                        message: "contents is required and must be a non-empty array",
                        status: "INVALID_ARGUMENT"
                    }
                },
                400
            );
        }

        // Validate and normalize roles to Gemini format (user/model only)
        for (const content of body.contents) {
            // If role is not specified, default to 'user' (common for single-turn requests)
            if (!content.role) {
                content.role = "user";
            } else if (content.role !== "user" && content.role !== "model") {
                // Convert assistant -> model, system -> user (first message)
                if (content.role === "assistant") {
                    content.role = "model";
                } else if (content.role === "system") {
                    content.role = "user";
                } else {
                    // Invalid role - log and reject
                    console.error(`Invalid role in contents: ${content.role}`);
                    return c.json(
                        {
                            error: {
                                code: 400,
                                message: `Invalid role: ${content.role}. Only 'user' and 'model' are allowed in Gemini native format.`,
                                status: "INVALID_ARGUMENT"
                            }
                        },
                        400
                    );
                }
            }
        }

        // Initialize services
        const authManager = new AuthManager(c.env);
        const geminiClient = new GeminiApiClient(c.env, authManager);

        // Authenticate
        try {
            await authManager.initializeAuth();
        } catch (authError: unknown) {
            const errorMessage = authError instanceof Error ? authError.message : String(authError);
            return c.json(
                {
                    error: {
                        code: 401,
                        message: `Authentication failed: ${errorMessage}`,
                        status: "UNAUTHENTICATED"
                    }
                },
                401
            );
        }

        const isStreaming = action === "streamGenerateContent";

        if (isStreaming) {
            // Streaming response
            try {
                const nativeStream = geminiClient.streamContentNative(modelId, body);
                const iterator = nativeStream[Symbol.asyncIterator]();

                // Await the first chunk to ensure the upstream request is successful
                // This prevents sending 200 OK when the upstream actually failed (e.g. 429, 401)
                const firstResult = await iterator.next();

                if (firstResult.done) {
                    return c.json(
                        {
                            error: {
                                code: 500,
                                message: "Empty response from Gemini API",
                                status: "INTERNAL"
                            }
                        },
                        500
                    );
                }

                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const geminiTransformer = createGeminiNativeStreamTransformer();
                const geminiStream = readable.pipeThrough(geminiTransformer);

                // Write the first chunk we already received
                await writer.write(firstResult.value);

                // Continue processing the rest of the stream in the background
                (async () => {
                    try {
                        let result = await iterator.next();
                        while (!result.done) {
                            await writer.write(result.value);
                            result = await iterator.next();
                        }
                        await writer.close();
                    } catch (streamError: unknown) {
                        const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
                        console.error("Gemini native stream error:", errorMessage);
                        // We can't change the status code anymore, but we can close the stream
                        await writer.close();
                    }
                })();

                // Return streaming response
                return new Response(geminiStream, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Access-Control-Allow-Origin": "*"
                    }
                });
            } catch (e: unknown) {
                // Handle errors that occurred during the initial connection/first chunk
                const errorMessage = e instanceof Error ? e.message : String(e);
                console.error("Gemini native initial stream error:", errorMessage);

                let status = 500;
                let statusText = "INTERNAL";

                if (errorMessage.includes("429")) {
                    status = 429;
                    statusText = "RESOURCE_EXHAUSTED";
                } else if (errorMessage.includes("401") || errorMessage.includes("403")) {
                    status = 401;
                    statusText = "UNAUTHENTICATED";
                } else if (errorMessage.includes("404")) {
                    status = 404;
                    statusText = "NOT_FOUND";
                }

                return c.json(
                    {
                        error: {
                            code: status,
                            message: errorMessage,
                            status: statusText
                        }
                    },
                    status as any
                );
            }
        } else {
            // Non-streaming response
            const completion = await geminiClient.getCompletionNative(modelId, body);
            return c.json(completion);
        }
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error("Gemini native endpoint error:", errorMessage);
        return c.json(
            {
                error: {
                    code: 500,
                    message: errorMessage,
                    status: "INTERNAL"
                }
            },
            500
        );
    }
});
