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
            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();
            const geminiTransformer = createGeminiNativeStreamTransformer();
            const geminiStream = readable.pipeThrough(geminiTransformer);

            // Asynchronously pipe data from Gemini to transformer
            (async () => {
                try {
                    const nativeStream = geminiClient.streamContentNative(modelId, body);

                    for await (const chunk of nativeStream) {
                        await writer.write(chunk);
                    }
                    await writer.close();
                } catch (streamError: unknown) {
                    const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
                    console.error("Gemini native stream error:", errorMessage);
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
