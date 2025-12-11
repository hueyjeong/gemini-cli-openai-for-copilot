import { StreamChunk, ReasoningData, GeminiFunctionCall, UsageData } from "./types";
import { NativeToolResponse } from "./types/native-tools";
import { GeminiNativeResponse, GeminiNativeStreamChunk } from "./types/gemini-native";
import { OPENAI_CHAT_COMPLETION_OBJECT } from "./config";

// OpenAI API interfaces
interface OpenAIToolCall {
	index: number;
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface OpenAIChoice {
	index: number;
	delta: OpenAIDelta;
	finish_reason: string | null;
	logprobs?: null;
	matched_stop?: null;
}

interface OpenAIDelta {
	role?: string;
	content?: string | null;
	reasoning?: string;
	reasoning_content?: string | null;
	tool_calls?: OpenAIToolCall[];
	native_tool_calls?: NativeToolResponse[];
	grounding?: unknown;
}

interface OpenAIChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: OpenAIChoice[];
	usage?: null;
}

interface OpenAIFinalChoice {
	index: number;
	delta: Record<string, never>;
	finish_reason: string;
}

interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

interface OpenAIFinalChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: OpenAIFinalChoice[];
	usage?: OpenAIUsage;
}

// Type guard functions
function isReasoningData(data: unknown): data is ReasoningData {
	return typeof data === "object" && data !== null && ("reasoning" in data || "toolCode" in data);
}

function isGeminiFunctionCall(data: unknown): data is GeminiFunctionCall {
	return typeof data === "object" && data !== null && "name" in data && "args" in data;
}

function isUsageData(data: unknown): data is UsageData {
	return typeof data === "object" && data !== null && "inputTokens" in data && "outputTokens" in data;
}
function isNativeToolResponse(data: unknown): data is NativeToolResponse {
	return typeof data === "object" && data !== null && "type" in data && "data" in data;
}

/**
 * Creates a TransformStream to convert Gemini's output chunks
 * into OpenAI-compatible server-sent events.
 */
export function createOpenAIStreamTransformer(model: string): TransformStream<StreamChunk, Uint8Array> {
	const chatID = `chatcmpl-${crypto.randomUUID()}`;
	const creationTime = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	let firstChunk = true;
	let toolCallId: string | null = null;
	let finishReason: string | null = null;
	let toolCallName: string | null = null;
	let toolCallIndex = 0;
	let usageData: UsageData | undefined;

	return new TransformStream({
		transform(chunk, controller) {
			const delta: OpenAIDelta = {};
			let openAIChunk: OpenAIChunk | null = null;

			switch (chunk.type) {
				case "text":
				case "thinking_content":
					if (typeof chunk.data === "string") {
						delta.content = chunk.data;
						if (firstChunk) {
							delta.role = "assistant";
							firstChunk = false;
						}
					}
					break;
				case "real_thinking":
					if (typeof chunk.data === "string") {
						delta.reasoning = chunk.data;
					}
					break;
				case "reasoning":
					if (isReasoningData(chunk.data)) {
						delta.reasoning = chunk.data.reasoning;
					}
					break;
				case "tool_code":
					if (isGeminiFunctionCall(chunk.data)) {
						const toolData = chunk.data;
						toolCallName = toolData.name;
						// Always generate a new ID for each tool call chunk as they are distinct calls
						toolCallId = `call_${crypto.randomUUID()}`;

						delta.tool_calls = [
							{
								index: toolCallIndex,
								id: toolCallId,
								type: "function",
								function: {
									name: toolCallName,
									arguments: JSON.stringify(toolData.args)
								}
							}
						];
						toolCallIndex++; // Increment index for potential subsequent tool calls

						if (firstChunk) {
							delta.role = "assistant";
							delta.content = null;
							firstChunk = false;
						}
					}
					break;
				case "native_tool":
					if (isNativeToolResponse(chunk.data)) {
						delta.native_tool_calls = [chunk.data];
					}
					break;
				case "grounding_metadata":
					if (chunk.data) {
						delta.grounding = chunk.data;
					}
					break;
				case "finish_reason":
					if (typeof chunk.data === "string") {
						finishReason = chunk.data;
					}
					return;
				case "usage":
					if (isUsageData(chunk.data)) {
						usageData = chunk.data;
					}
					return; // Don't send a chunk for usage data
			}

			if (Object.keys(delta).length > 0) {
				openAIChunk = {
					id: chatID,
					object: OPENAI_CHAT_COMPLETION_OBJECT,
					created: creationTime,
					model: model,
					choices: [
						{
							index: 0,
							delta: delta,
							finish_reason: null,
							logprobs: null,
							matched_stop: null
						}
					],
					usage: null
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
			}
		},
		flush(controller) {
			let finalFinishReason = "stop";
			if (finishReason) {
				if (finishReason === "STOP") finalFinishReason = "stop";
				else if (finishReason === "MAX_TOKENS") finalFinishReason = "length";
				else if (finishReason === "SAFETY") finalFinishReason = "content_filter";
				else if (finishReason === "RECITATION") finalFinishReason = "content_filter";
			}

			if (toolCallId) {
				finalFinishReason = "tool_calls";
			}

			const finalChunk: OpenAIFinalChunk = {
				id: chatID,
				object: OPENAI_CHAT_COMPLETION_OBJECT,
				created: creationTime,
				model: model,
				choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }]
			};

			if (usageData) {
				finalChunk.usage = {
					prompt_tokens: usageData.inputTokens,
					completion_tokens: usageData.outputTokens,
					total_tokens: usageData.inputTokens + usageData.outputTokens
				};
			}

			controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		}
	});
}

// Type guard for Gemini native stream chunk
function isGeminiNativeResponse(data: unknown): data is GeminiNativeResponse {
	return typeof data === "object" && data !== null && "candidates" in data;
}

/**
 * Creates a TransformStream to pass through Gemini native format
 * as server-sent events (SSE) for LiteLLM gemini/ prefix support.
 *
 * This transformer outputs Gemini API format directly without conversion,
 * preserving thought_signature and other native fields.
 */
export function createGeminiNativeStreamTransformer(): TransformStream<
	GeminiNativeStreamChunk,
	Uint8Array
> {
	const encoder = new TextEncoder();

	return new TransformStream({
		transform(chunk, controller) {
			if (chunk.type === "gemini_native" && isGeminiNativeResponse(chunk.data)) {
				// Output Gemini native format as SSE
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk.data)}\n\n`));
			}
		},
		flush(controller) {
			// Gemini API doesn't use [DONE] marker, but we can optionally add it
			// for compatibility with some clients
			// controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		}
	});
}
