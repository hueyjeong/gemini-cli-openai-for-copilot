import {
	Env,
	StreamChunk,
	ReasoningData,
	UsageData,
	ChatMessage,
	MessageContent,
	Tool,
	ToolChoice,
	GeminiFunctionCall
} from "./types";
import { AuthManager } from "./auth";
import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_API_VERSION } from "./config";
import { REASONING_MESSAGES, REASONING_CHUNK_DELAY, THINKING_CONTENT_CHUNK_SIZE } from "./constants";
import { geminiCliModels } from "./models";
import { validateImageUrl } from "./utils/image-utils";
import { GenerationConfigValidator } from "./helpers/generation-config-validator";
import { AutoModelSwitchingHelper } from "./helpers/auto-model-switching";
import { NativeToolsManager } from "./helpers/native-tools-manager";
import { CitationsProcessor } from "./helpers/citations-processor";
import { GeminiUrlContextMetadata, GroundingMetadata, NativeToolsRequestParams } from "./types/native-tools";
import {
	GeminiNativeRequest,
	GeminiNativeResponse,
	GeminiNativeStreamChunk,
	GeminiNativePart
} from "./types/gemini-native";

// Gemini API response types
interface GeminiCandidate {
	content?: {
		parts?: Array<{ text?: string }>;
	};
	groundingMetadata?: GroundingMetadata;
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
}

interface GeminiResponse {
	response?: {
		candidates?: GeminiCandidate[];
		usageMetadata?: GeminiUsageMetadata;
	};
}

export interface GeminiPart {
	text?: string;
	thought?: boolean; // For real thinking chunks from Gemini
	thoughtSignature?: string; // For thought signature validation (Gemini 3 Pro requirement)
	functionCall?: {
		name: string;
		args: object;
	};
	functionResponse?: {
		name: string;
		response: {
			result: string;
		};
	};
	inlineData?: {
		mimeType: string;
		data: string;
	};
	fileData?: {
		mimeType: string;
		fileUri: string;
	};
	url_context_metadata?: GeminiUrlContextMetadata;
}

// Message content types - keeping only the local ones needed
interface TextContent {
	type: "text";
	text: string;
}

interface GeminiFormattedMessage {
	role: string;
	parts: GeminiPart[];
}

interface ProjectDiscoveryResponse {
	cloudaicompanionProject?: string;
}

// Type guard functions
function isTextContent(content: MessageContent): content is TextContent {
	return content.type === "text" && typeof content.text === "string";
}

/**
 * Handles communication with Google's Gemini API through the Code Assist endpoint.
 * Manages project discovery, streaming, and response parsing.
 */
export class GeminiApiClient {
	private env: Env;
	private authManager: AuthManager;
	private projectId: string | null = null;
	private autoSwitchHelper: AutoModelSwitchingHelper;

	constructor(env: Env, authManager: AuthManager) {
		this.env = env;
		this.authManager = authManager;
		this.autoSwitchHelper = new AutoModelSwitchingHelper(env);
	}

	/**
	 * Discovers the Google Cloud project ID. Uses the environment variable if provided.
	 */
	public async discoverProjectId(): Promise<string> {
		if (this.env.GEMINI_PROJECT_ID) {
			return this.env.GEMINI_PROJECT_ID;
		}
		if (this.projectId) {
			return this.projectId;
		}

		try {
			const initialProjectId = "default-project";
			const loadResponse = (await this.authManager.callEndpoint("loadCodeAssist", {
				cloudaicompanionProject: initialProjectId,
				metadata: { duetProject: initialProjectId }
			})) as ProjectDiscoveryResponse;

			if (loadResponse.cloudaicompanionProject) {
				this.projectId = loadResponse.cloudaicompanionProject;
				return loadResponse.cloudaicompanionProject;
			}
			throw new Error("Project ID discovery failed. Please set the GEMINI_PROJECT_ID environment variable.");
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error("Failed to discover project ID:", errorMessage);
			throw new Error(
				"Could not discover project ID. Make sure you're authenticated and consider setting GEMINI_PROJECT_ID."
			);
		}
	}

	/**
	 * Parses a server-sent event (SSE) stream from the Gemini API.
	 */
	private async *parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<GeminiResponse> {
		const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		let objectBuffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (objectBuffer) {
					try {
						yield JSON.parse(objectBuffer);
					} catch (e) {
						console.error("Error parsing final SSE JSON object:", e);
					}
				}
				break;
			}

			buffer += value;
			const lines = buffer.split("\n");
			buffer = lines.pop() || ""; // Keep the last, possibly incomplete, line.

			for (const line of lines) {
				if (line.trim() === "") {
					if (objectBuffer) {
						try {
							yield JSON.parse(objectBuffer);
						} catch (e) {
							console.error("Error parsing SSE JSON object:", e);
						}
						objectBuffer = "";
					}
				} else if (line.startsWith("data: ")) {
					objectBuffer += line.substring(6);
				}
			}
		}
	}

	/**
	 * Converts a message to Gemini format, handling both text and image content.
	 */
	private messageToGeminiFormat(msg: ChatMessage): GeminiFormattedMessage {
		const role = msg.role === "assistant" ? "model" : "user";

		// Handle tool call results (tool role in OpenAI format)
		if (msg.role === "tool") {
			return {
				role: "user",
				parts: [
					{
						functionResponse: {
							name: msg.tool_call_id || "unknown_function",
							response: {
								result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
							}
						}
					}
				]
			};
		}

		// Handle assistant messages with tool calls - REQUIRES thought_signature
		if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
			const parts: GeminiPart[] = [];

			// Add text content if present
			if (typeof msg.content === "string" && msg.content.trim()) {
				parts.push({ text: msg.content });
			}

			// Add function calls with thought_signature skip validator
			// Gemini 3 Pro requires thought_signature for function calls in multi-turn conversations
			// Since we don't have the original signature from external sources (LiteLLM/OpenAI format),
			// we use skip_thought_signature_validator as recommended by Google docs
			for (const toolCall of msg.tool_calls) {
				if (toolCall.type === "function") {
					const part: GeminiPart = {
						functionCall: {
							name: toolCall.function.name,
							args: JSON.parse(toolCall.function.arguments)
						},
						thoughtSignature: "skip_thought_signature_validator"
					};
					parts.push(part);
				}
			}

			return { role: "model", parts };
		}

		// Simple text message - NO thought_signature needed (per Google docs)
		if (typeof msg.content === "string") {
			return {
				role,
				parts: [{ text: msg.content }]
			};
		}

		if (Array.isArray(msg.content)) {
			// Multimodal message with text and/or images
			const parts: GeminiPart[] = [];

			for (const content of msg.content) {
				if (content.type === "text") {
					parts.push({ text: content.text });
				} else if (content.type === "image_url" && content.image_url) {
					const imageUrl = content.image_url.url;

					// Validate image URL
					const validation = validateImageUrl(imageUrl);
					if (!validation.isValid) {
						throw new Error(`Invalid image: ${validation.error}`);
					}

					if (imageUrl.startsWith("data:")) {
						// Handle base64 encoded images
						const [mimeType, base64Data] = imageUrl.split(",");
						const mediaType = mimeType.split(":")[1].split(";")[0];

						parts.push({
							inlineData: {
								mimeType: mediaType,
								data: base64Data
							}
						});
					} else {
						// Handle URL images
						// Note: For better reliability, you might want to fetch the image
						// and convert it to base64, as Gemini API might have limitations with external URLs
						parts.push({
							fileData: {
								mimeType: validation.mimeType || "image/jpeg",
								fileUri: imageUrl
							}
						});
					}
				}
			}

			return { role, parts };
		}

		// Fallback for unexpected content format
		return {
			role,
			parts: [{ text: String(msg.content) }]
		};
	}

	/**
	 * Validates if the model supports images.
	 */
	private validateImageSupport(modelId: string): boolean {
		return geminiCliModels[modelId]?.supportsImages || false;
	}

	/**
	 * Validates image content and format using the shared validation utility.
	 */
	private validateImageContent(imageUrl: string): boolean {
		const validation = validateImageUrl(imageUrl);
		return validation.isValid;
	}

	/**
	 * Converts OpenAI messages to Gemini format and merges consecutive tool responses.
	 * Gemini requires that function call and function response counts match exactly.
	 */
	private convertAndMergeMessages(messages: ChatMessage[]): GeminiFormattedMessage[] {
		const result: GeminiFormattedMessage[] = [];
		let i = 0;

		while (i < messages.length) {
			const msg = messages[i];

			// Check if this is a tool response message
			if (msg.role === "tool") {
				// Collect all consecutive tool responses into one user message
				const toolResponseParts: GeminiPart[] = [];

				while (i < messages.length && messages[i].role === "tool") {
					const toolMsg = messages[i];
					toolResponseParts.push({
						functionResponse: {
							name: toolMsg.tool_call_id || "unknown_function",
							response: {
								result: typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content)
							}
						}
					});
					i++;
				}

				// Add merged tool responses as a single user message
				result.push({
					role: "user",
					parts: toolResponseParts
				});
			} else {
				// Regular message - convert normally
				result.push(this.messageToGeminiFormat(msg));
				i++;
			}
		}

		return result;
	}

	/**
	 * Stream content from Gemini API.
	 */
	async *streamContent(
		modelId: string,
		systemPrompt: string,
		messages: ChatMessage[],
		options?: {
			includeReasoning?: boolean;
			thinkingBudget?: number;
			tools?: Tool[];
			tool_choice?: ToolChoice;
			max_tokens?: number;
			temperature?: number;
			top_p?: number;
			stop?: string | string[];
			presence_penalty?: number;
			frequency_penalty?: number;
			seed?: number;
			response_format?: {
				type: "text" | "json_object";
			};
		} & NativeToolsRequestParams
	): AsyncGenerator<StreamChunk> {
		await this.authManager.initializeAuth();
		const projectId = await this.discoverProjectId();

		// Convert messages and merge consecutive tool responses
		const contents = this.convertAndMergeMessages(messages);

		if (systemPrompt) {
			contents.unshift({ role: "user", parts: [{ text: systemPrompt }] });
		}

		// Check if this is a thinking model and which thinking mode to use
		const isThinkingModel = geminiCliModels[modelId]?.thinking || false;
		const isRealThinkingEnabled = this.env.ENABLE_REAL_THINKING === "true";
		const isFakeThinkingEnabled = this.env.ENABLE_FAKE_THINKING === "true";
		const streamThinkingAsContent = this.env.STREAM_THINKING_AS_CONTENT === "true";
		const includeReasoning = options?.includeReasoning || false;

		const req = {
			thinking_budget: options?.thinkingBudget,
			tools: options?.tools,
			tool_choice: options?.tool_choice,
			max_tokens: options?.max_tokens,
			temperature: options?.temperature,
			top_p: options?.top_p,
			stop: options?.stop,
			presence_penalty: options?.presence_penalty,
			frequency_penalty: options?.frequency_penalty,
			seed: options?.seed,
			response_format: options?.response_format
		};

		// Use the validation helper to create a proper generation config
		const generationConfig = GenerationConfigValidator.createValidatedConfig(
			modelId,
			req,
			isRealThinkingEnabled,
			includeReasoning
		);

		// Native tools integration
		const nativeToolsManager = new NativeToolsManager(this.env);
		const nativeToolsParams = this.extractNativeToolsParams(options as Record<string, unknown>);
		const toolConfig = nativeToolsManager.determineToolConfiguration(options?.tools || [], nativeToolsParams, modelId);

		// Configure request based on tool strategy
		const { tools, toolConfig: finalToolConfig } = GenerationConfigValidator.createFinalToolConfiguration(
			toolConfig,
			options
		);

		// For thinking models with fake thinking (fallback when real thinking is not enabled or not requested)
		let needsThinkingClose = false;
		if (isThinkingModel && isFakeThinkingEnabled && !includeReasoning) {
			yield* this.generateReasoningOutput(messages, streamThinkingAsContent);
			needsThinkingClose = streamThinkingAsContent; // Only need to close if we streamed as content
		}

		const streamRequest: {
			model: string;
			project: string;
			request: {
				contents: unknown;
				generationConfig: unknown;
				tools: unknown;
				toolConfig: unknown;
				safetySettings?: unknown;
			};
		} = {
			model: modelId,
			project: projectId,
			request: {
				contents: contents,
				generationConfig,
				tools: tools,
				toolConfig: finalToolConfig
			}
		};

		const safetySettings = GenerationConfigValidator.createSafetySettings(this.env);
		if (safetySettings.length > 0) {
			streamRequest.request.safetySettings = safetySettings;
		}

		yield* this.performStreamRequest(
			streamRequest,
			needsThinkingClose,
			false,
			includeReasoning && streamThinkingAsContent,
			modelId,
			nativeToolsManager
		);
	}

	/**
	 * Generates reasoning output for thinking models.
	 */
	private async *generateReasoningOutput(
		messages: ChatMessage[],
		streamAsContent: boolean = false
	): AsyncGenerator<StreamChunk> {
		// Get the last user message to understand what the model should think about
		const lastUserMessage = messages.filter((msg) => msg.role === "user").pop();
		let userContent = "";

		if (lastUserMessage) {
			if (typeof lastUserMessage.content === "string") {
				userContent = lastUserMessage.content;
			} else if (Array.isArray(lastUserMessage.content)) {
				userContent = lastUserMessage.content
					.filter(isTextContent)
					.map((c) => c.text)
					.join(" ");
			}
		}

		// Generate reasoning text based on the user's question using constants
		const requestPreview = userContent.substring(0, 100) + (userContent.length > 100 ? "..." : "");

		if (streamAsContent) {
			// DeepSeek R1 style: stream thinking as content with <thinking> tags
			yield {
				type: "thinking_content",
				data: "<thinking>\n"
			};

			// Add a small delay after opening tag
			await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY)); // Stream reasoning content in smaller chunks for more realistic streaming
			const reasoningTexts = REASONING_MESSAGES.map((msg) => msg.replace("{requestPreview}", requestPreview));
			const fullReasoningText = reasoningTexts.join("");

			// Split into smaller chunks for more realistic streaming
			// Try to split on word boundaries when possible for better readability
			const chunks: string[] = [];
			let remainingText = fullReasoningText;

			while (remainingText.length > 0) {
				if (remainingText.length <= THINKING_CONTENT_CHUNK_SIZE) {
					chunks.push(remainingText);
					break;
				}

				// Try to find a good break point (space, newline, punctuation)
				let chunkEnd = THINKING_CONTENT_CHUNK_SIZE;
				const searchSpace = remainingText.substring(0, chunkEnd + 10); // Look a bit ahead
				const goodBreaks = [" ", "\n", ".", ",", "!", "?", ";", ":"];

				for (const breakChar of goodBreaks) {
					const lastBreak = searchSpace.lastIndexOf(breakChar);
					if (lastBreak > THINKING_CONTENT_CHUNK_SIZE * 0.7) {
						// Don't make chunks too small
						chunkEnd = lastBreak + 1;
						break;
					}
				}

				chunks.push(remainingText.substring(0, chunkEnd));
				remainingText = remainingText.substring(chunkEnd);
			}

			for (const chunk of chunks) {
				yield {
					type: "thinking_content",
					data: chunk
				};

				// Add small delay between chunks
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			// Note: We don't close the thinking tag here - it will be closed when real content starts
		} else {
			// Original mode: stream as reasoning field
			const reasoningTexts = REASONING_MESSAGES.map((msg) => msg.replace("{requestPreview}", requestPreview));

			// Stream the reasoning text in chunks
			for (const reasoningText of reasoningTexts) {
				const reasoningData: ReasoningData = { reasoning: reasoningText };
				yield {
					type: "reasoning",
					data: reasoningData
				};

				// Add a small delay to simulate thinking time
				await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY));
			}
		}
	}

	/**
	 * Performs the actual stream request with retry logic for 401 errors and auto model switching for rate limits.
	 */
	private async *performStreamRequest(
		streamRequest: unknown,
		needsThinkingClose: boolean = false,
		isRetry: boolean = false,
		realThinkingAsContent: boolean = false,
		originalModel?: string,
		nativeToolsManager?: NativeToolsManager
	): AsyncGenerator<StreamChunk> {
		const citationsProcessor = new CitationsProcessor(this.env);
		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.authManager.getAccessToken()}`
			},
			body: JSON.stringify(streamRequest)
		});

		if (!response.ok) {
			if (response.status === 401 && !isRetry) {
				console.log("Got 401 error in stream request, clearing token cache and retrying...");
				await this.authManager.clearTokenCache();
				await this.authManager.initializeAuth();
				yield* this.performStreamRequest(
					streamRequest,
					needsThinkingClose,
					true,
					realThinkingAsContent,
					originalModel,
					nativeToolsManager
				); // Retry once
				return;
			}

			// Handle rate limiting with auto model switching
			if (this.autoSwitchHelper.isRateLimitStatus(response.status) && !isRetry && originalModel) {
				const fallbackModel = this.autoSwitchHelper.getFallbackModel(originalModel);
				if (fallbackModel && this.autoSwitchHelper.isEnabled()) {
					console.log(
						`Got ${response.status} error for model ${originalModel}, switching to fallback model: ${fallbackModel}`
					);

					// Create new request with fallback model
					const fallbackRequest = {
						...(streamRequest as Record<string, unknown>),
						model: fallbackModel
					};

					// Add a notification chunk about the model switch
					yield {
						type: "text",
						data: this.autoSwitchHelper.createSwitchNotification(originalModel, fallbackModel)
					};

					yield* this.performStreamRequest(
						fallbackRequest,
						needsThinkingClose,
						true,
						realThinkingAsContent,
						originalModel,
						nativeToolsManager
					);
					return;
				}
			}

			const errorText = await response.text();
			console.error(`[GeminiAPI] Stream request failed: ${response.status}`, errorText);
			throw new Error(`Stream request failed: ${response.status}`);
		}

		if (!response.body) {
			throw new Error("Response has no body");
		}

		let hasClosedThinking = false;
		let hasStartedThinking = false;

		for await (const jsonData of this.parseSSEStream(response.body)) {
			const candidate = jsonData.response?.candidates?.[0];

			if (candidate?.content?.parts) {
				for (const part of candidate.content.parts as GeminiPart[]) {
					// Handle real thinking content from Gemini
					if (part.thought === true && part.text) {
						const thinkingText = part.text;

						if (realThinkingAsContent) {
							// Stream as content with <thinking> tags (DeepSeek R1 style)
							if (!hasStartedThinking) {
								yield {
									type: "thinking_content",
									data: "<thinking>\n"
								};
								hasStartedThinking = true;
							}

							yield {
								type: "thinking_content",
								data: thinkingText
							};
						} else {
							// Stream as separate reasoning field
							yield {
								type: "real_thinking",
								data: thinkingText
							};
						}
					}
					// Check if text content contains <think> tags (based on your original example)
					else if (part.text && part.text.includes("<think>")) {
						if (realThinkingAsContent) {
							// Extract thinking content and convert to our format
							const thinkingMatch = part.text.match(/<think>(.*?)<\/think>/s);
							if (thinkingMatch) {
								if (!hasStartedThinking) {
									yield {
										type: "thinking_content",
										data: "<thinking>\n"
									};
									hasStartedThinking = true;
								}

								yield {
									type: "thinking_content",
									data: thinkingMatch[1]
								};
							}

							// Extract any non-thinking coRecentent
							const nonThinkingContent = part.text.replace(/<think>.*?<\/think>/gs, "").trim();
							if (nonThinkingContent) {
								if (hasStartedThinking && !hasClosedThinking) {
									yield {
										type: "thinking_content",
										data: "\n</thinking>\n\n"
									};
									hasClosedThinking = true;
								}
								yield { type: "text", data: nonThinkingContent };
							}
						} else {
							// Stream thinking as separate reasoning field
							const thinkingMatch = part.text.match(/<think>(.*?)<\/think>/s);
							if (thinkingMatch) {
								yield {
									type: "real_thinking",
									data: thinkingMatch[1]
								};
							}

							// Stream non-thinking content as regular text
							const nonThinkingContent = part.text.replace(/<think>.*?<\/think>/gs, "").trim();
							if (nonThinkingContent) {
								yield { type: "text", data: nonThinkingContent };
							}
						}
					}
					// Handle regular content - only if it's not a thinking part and doesn't contain <think> tags
					else if (part.text && !part.thought && !part.text.includes("<think>")) {
						// Close thinking tag before first real content if needed
						if ((needsThinkingClose || (realThinkingAsContent && hasStartedThinking)) && !hasClosedThinking) {
							yield {
								type: "thinking_content",
								data: "\n</thinking>\n\n"
							};
							hasClosedThinking = true;
						}

						let processedText = part.text;
						if (nativeToolsManager) {
							processedText = citationsProcessor.processChunk(
								part.text,
								jsonData.response?.candidates?.[0]?.groundingMetadata
							);
						}
						yield { type: "text", data: processedText };
					}
					// Handle function calls from Gemini
					else if (part.functionCall) {
						// Close thinking tag before function call if needed
						if ((needsThinkingClose || (realThinkingAsContent && hasStartedThinking)) && !hasClosedThinking) {
							yield {
								type: "thinking_content",
								data: "\n</thinking>\n\n"
							};
							hasClosedThinking = true;
						}

						const functionCallData: GeminiFunctionCall = {
							name: part.functionCall.name,
							args: part.functionCall.args
						};

						yield {
							type: "tool_code",
							data: functionCallData
						};
					}
					// Note: Skipping unknown part structures
				}
			}

			if (jsonData.response?.usageMetadata) {
				const usage = jsonData.response.usageMetadata;
				const usageData: UsageData = {
					inputTokens: usage.promptTokenCount || 0,
					outputTokens: usage.candidatesTokenCount || 0
				};
				yield {
					type: "usage",
					data: usageData
				};
			}
		}
	}

	/**
	 * Get a complete response from Gemini API (non-streaming).
	 */
	async getCompletion(
		modelId: string,
		systemPrompt: string,
		messages: ChatMessage[],
		options?: {
			includeReasoning?: boolean;
			thinkingBudget?: number;
			tools?: Tool[];
			tool_choice?: ToolChoice;
			max_tokens?: number;
			temperature?: number;
			top_p?: number;
			stop?: string | string[];
			presence_penalty?: number;
			frequency_penalty?: number;
			seed?: number;
			response_format?: {
				type: "text" | "json_object";
			};
		} & NativeToolsRequestParams
	): Promise<{
		content: string;
		usage?: UsageData;
		tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	}> {
		try {
			let content = "";
			let usage: UsageData | undefined;
			const tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

			// Collect all chunks from the stream
			for await (const chunk of this.streamContent(modelId, systemPrompt, messages, options)) {
				if ((chunk.type === "text" || chunk.type === "thinking_content") && typeof chunk.data === "string") {
					content += chunk.data;
				} else if (chunk.type === "usage" && typeof chunk.data === "object") {
					usage = chunk.data as UsageData;
				} else if (chunk.type === "tool_code" && typeof chunk.data === "object") {
					const toolData = chunk.data as GeminiFunctionCall;
					tool_calls.push({
						id: `call_${crypto.randomUUID()}`,
						type: "function",
						function: {
							name: toolData.name,
							arguments: JSON.stringify(toolData.args)
						}
					});
				}
				// Skip reasoning chunks for non-streaming responses
			}

			return {
				content,
				usage,
				tool_calls: tool_calls.length > 0 ? tool_calls : undefined
			};
		} catch (error: unknown) {
			// Handle rate limiting for non-streaming requests
			if (this.autoSwitchHelper.isRateLimitError(error)) {
				const fallbackResult = await this.autoSwitchHelper.handleNonStreamingFallback(
					modelId,
					systemPrompt,
					messages,
					options,
					this.streamContent.bind(this)
				);
				if (fallbackResult) {
					return fallbackResult;
				}
			}

			// Re-throw if not a rate limit error or fallback not available
			throw error;
		}
	}

	private extractNativeToolsParams(options?: Record<string, unknown>): NativeToolsRequestParams {
		return {
			enableSearch: this.extractBooleanParam(options, "enable_search"),
			enableUrlContext: this.extractBooleanParam(options, "enable_url_context"),
			enableNativeTools: this.extractBooleanParam(options, "enable_native_tools"),
			nativeToolsPriority: this.extractStringParam(
				options,
				"native_tools_priority",
				(v): v is "native" | "custom" | "mixed" => ["native", "custom", "mixed"].includes(v)
			)
		};
	}

	private extractBooleanParam(options: Record<string, unknown> | undefined, key: string): boolean | undefined {
		const value =
			options?.[key] ??
			(options?.extra_body as Record<string, unknown>)?.[key] ??
			(options?.model_params as Record<string, unknown>)?.[key];
		return typeof value === "boolean" ? value : undefined;
	}

	private extractStringParam<T extends string>(
		options: Record<string, unknown> | undefined,
		key: string,
		guard: (v: string) => v is T
	): T | undefined {
		const value =
			options?.[key] ??
			(options?.extra_body as Record<string, unknown>)?.[key] ??
			(options?.model_params as Record<string, unknown>)?.[key];
		if (typeof value === "string" && guard(value)) {
			return value;
		}
		return undefined;
	}

	// =====================================================
	// Gemini Native API Methods (for LiteLLM gemini/ prefix)
	// =====================================================

	/**
	 * Stream content from Gemini API using native Gemini format.
	 * This method accepts Gemini-native request format directly and returns
	 * Gemini-native response format, preserving thought_signature and other fields.
	 */
	async *streamContentNative(
		modelId: string,
		request: GeminiNativeRequest
	): AsyncGenerator<GeminiNativeStreamChunk> {
		await this.authManager.initializeAuth();
		const projectId = await this.discoverProjectId();

		// Build the request in Code Assist format
		const streamRequest = this.buildNativeStreamRequest(modelId, projectId, request);

		yield* this.performNativeStreamRequest(streamRequest, modelId);
	}

	/**
	 * Get a complete response from Gemini API using native format (non-streaming).
	 */
	async getCompletionNative(
		modelId: string,
		request: GeminiNativeRequest
	): Promise<GeminiNativeResponse> {
		await this.authManager.initializeAuth();
		const projectId = await this.discoverProjectId();

		// Build the request
		const streamRequest = this.buildNativeStreamRequest(modelId, projectId, request);

		// Collect all chunks and merge into single response
		const candidates: GeminiNativeResponse["candidates"] = [];
		let usageMetadata: GeminiNativeResponse["usageMetadata"] | undefined;

		for await (const chunk of this.performNativeStreamRequest(streamRequest, modelId)) {
			if (chunk.type === "gemini_native" && chunk.data.candidates) {
				// Merge parts from streaming chunks
				for (const candidate of chunk.data.candidates) {
					if (candidates.length === 0) {
						candidates.push({
							content: {
								role: "model",
								parts: []
							}
						});
					}
					if (candidate.content?.parts) {
						candidates[0].content.parts.push(...(candidate.content.parts as GeminiNativePart[]));
					}
					if (candidate.finishReason) {
						candidates[0].finishReason = candidate.finishReason;
					}
					if (candidate.groundingMetadata) {
						candidates[0].groundingMetadata = candidate.groundingMetadata;
					}
				}
				if (chunk.data.usageMetadata) {
					usageMetadata = chunk.data.usageMetadata;
				}
			}
		}

		return {
			candidates,
			usageMetadata,
			modelVersion: modelId
		};
	}

	/**
	 * Builds the stream request for native Gemini API format.
	 */
	private buildNativeStreamRequest(
		modelId: string,
		projectId: string,
		request: GeminiNativeRequest
	): Record<string, unknown> {
		// Build generation config from native format
		const generationConfig: Record<string, unknown> = {};

		if (request.generationConfig) {
			const gc = request.generationConfig;
			if (gc.temperature !== undefined) generationConfig.temperature = gc.temperature;
			if (gc.topP !== undefined) generationConfig.topP = gc.topP;
			if (gc.topK !== undefined) generationConfig.topK = gc.topK;
			if (gc.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = gc.maxOutputTokens;
			if (gc.stopSequences !== undefined) generationConfig.stopSequences = gc.stopSequences;
			if (gc.presencePenalty !== undefined) generationConfig.presencePenalty = gc.presencePenalty;
			if (gc.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = gc.frequencyPenalty;
			if (gc.seed !== undefined) generationConfig.seed = gc.seed;
			if (gc.responseMimeType !== undefined) generationConfig.responseMimeType = gc.responseMimeType;
		}

		// Force thinkingConfig for thinking models (Gemini 3 Pro, Gemini 2.5 Pro/Flash)
		// Always use HIGH thinking level to ensure thought: true parts are returned
		const isThinkingModel = modelId.includes("gemini-3") || modelId.includes("gemini-2.5");
		if (isThinkingModel) {
			if (modelId.includes("gemini-3")) {
				// Gemini 3 uses thinkingLevel
				generationConfig.thinkingConfig = {
					thinkingLevel: "HIGH",
					includeThoughts: true
				};
				// console.log(`[buildNativeStreamRequest] Forcing thinkingConfig for ${modelId}:`, JSON.stringify(generationConfig.thinkingConfig));
			} else if (modelId.includes("gemini-2.5")) {
				// Gemini 2.5 uses thinkingBudget (-1 = dynamic)
				generationConfig.thinkingConfig = {
					thinkingBudget: -1,
					includeThoughts: true
				};
				// console.log(`[buildNativeStreamRequest] Forcing thinkingConfig for ${modelId}:`, JSON.stringify(generationConfig.thinkingConfig));
			}
		}

		// Build contents - pass through directly (native format)
		const contents = request.contents;

		// Build the request
		const streamRequest: Record<string, unknown> = {
			model: modelId,
			project: projectId,
			request: {
				contents
			}
		};

		// Add systemInstruction if present (Gemini native format uses separate field)
		if (request.systemInstruction) {
			(streamRequest.request as Record<string, unknown>).systemInstruction = request.systemInstruction;
		}

		// Add generation config if not empty
		if (Object.keys(generationConfig).length > 0) {
			(streamRequest.request as Record<string, unknown>).generationConfig = generationConfig;
		}

		// Add tools if present
		if (request.tools && request.tools.length > 0) {
			(streamRequest.request as Record<string, unknown>).tools = request.tools;
		}

		// Add tool config if present
		if (request.toolConfig) {
			(streamRequest.request as Record<string, unknown>).toolConfig = request.toolConfig;
		}

		// Add safety settings if present, or use env defaults
		if (request.safetySettings && request.safetySettings.length > 0) {
			(streamRequest.request as Record<string, unknown>).safetySettings = request.safetySettings;
		} else {
			const safetySettings = GenerationConfigValidator.createSafetySettings(this.env);
			if (safetySettings.length > 0) {
				(streamRequest.request as Record<string, unknown>).safetySettings = safetySettings;
			}
		}

		return streamRequest;
	}

	/**
	 * Performs the native stream request and yields Gemini-native format chunks.
	 * Preserves thought_signature and all other native fields.
	 */
	private async *performNativeStreamRequest(
		streamRequest: Record<string, unknown>,
		modelId: string,
		isRetry: boolean = false
	): AsyncGenerator<GeminiNativeStreamChunk> {
		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.authManager.getAccessToken()}`
			},
			body: JSON.stringify(streamRequest)
		});

		if (!response.ok) {
			if (response.status === 401 && !isRetry) {
				console.log("Got 401 error in native stream request, clearing token cache and retrying...");
				await this.authManager.clearTokenCache();
				await this.authManager.initializeAuth();
				yield* this.performNativeStreamRequest(streamRequest, modelId, true);
				return;
			}

			// Handle rate limiting with auto model switching
			if (this.autoSwitchHelper.isRateLimitStatus(response.status) && !isRetry) {
				const fallbackModel = this.autoSwitchHelper.getFallbackModel(modelId);
				if (fallbackModel && this.autoSwitchHelper.isEnabled()) {
					console.log(
						`Got ${response.status} error for model ${modelId}, switching to fallback model: ${fallbackModel}`
					);

					const fallbackRequest = {
						...streamRequest,
						model: fallbackModel
					};

					yield* this.performNativeStreamRequest(fallbackRequest, fallbackModel, true);
					return;
				}
			}

			const errorText = await response.text();
			console.error(`[GeminiAPI Native] Stream request failed: ${response.status}`, errorText);
			throw new Error(`Stream request failed: ${response.status}`);
		}

		if (!response.body) {
			throw new Error("Response has no body");
		}

		// Parse SSE stream and yield native format chunks
		for await (const jsonData of this.parseSSEStream(response.body)) {
			// Convert from Code Assist response format to native Gemini format
			if (jsonData.response?.candidates) {
				const nativeResponse: GeminiNativeResponse = {
					candidates: jsonData.response.candidates.map((candidate) => ({
						content: {
							role: "model" as const,
							parts: (candidate.content?.parts || []) as GeminiNativePart[]
						},
						groundingMetadata: candidate.groundingMetadata as Record<string, unknown> | undefined
					})),
					usageMetadata: jsonData.response.usageMetadata
						? {
							promptTokenCount: jsonData.response.usageMetadata.promptTokenCount || 0,
							candidatesTokenCount: jsonData.response.usageMetadata.candidatesTokenCount || 0,
							totalTokenCount:
								(jsonData.response.usageMetadata.promptTokenCount || 0) +
								(jsonData.response.usageMetadata.candidatesTokenCount || 0)
						}
						: undefined,
					modelVersion: modelId
				};

				yield {
					type: "gemini_native",
					data: nativeResponse
				};
			}
		}
	}
}
