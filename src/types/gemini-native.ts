/**
 * Gemini Native API Types
 *
 * Native Gemini API format types for direct LiteLLM integration.
 * These types match the official Gemini API specification.
 */

// --- Part Types ---

export interface GeminiNativeTextPart {
    text: string;
}

export interface GeminiNativeThoughtPart {
    text: string;
    thought: true;
}

export interface GeminiNativeFunctionCallPart {
    functionCall: {
        name: string;
        args: Record<string, unknown>;
    };
    thoughtSignature?: string;
}

export interface GeminiNativeFunctionResponsePart {
    functionResponse: {
        name: string;
        response: {
            result: string;
        };
    };
}

export interface GeminiNativeInlineDataPart {
    inlineData: {
        mimeType: string;
        data: string; // base64 encoded
    };
}

export interface GeminiNativeFileDataPart {
    fileData: {
        mimeType: string;
        fileUri: string;
    };
}

export type GeminiNativePart =
    | GeminiNativeTextPart
    | GeminiNativeThoughtPart
    | GeminiNativeFunctionCallPart
    | GeminiNativeFunctionResponsePart
    | GeminiNativeInlineDataPart
    | GeminiNativeFileDataPart;

// --- Content Types ---

export interface GeminiNativeContent {
    role: "user" | "model";
    parts: GeminiNativePart[];
}

export interface GeminiNativeSystemInstruction {
    parts: GeminiNativeTextPart[];
}

// --- Generation Config ---

export interface GeminiNativeThinkingConfig {
    /** Thinking token budget for Gemini 2.5 models. Use -1 for dynamic allocation. */
    thinkingBudget?: number;
    /** Whether to include thinking content in response */
    includeThoughts?: boolean;
    /** Thinking level for Gemini 3+ models */
    thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
}

export interface GeminiNativeGenerationConfig {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    responseMimeType?: string;
    thinkingConfig?: GeminiNativeThinkingConfig;
}

// --- Tool Types ---

export interface GeminiNativeFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export interface GeminiNativeTool {
    functionDeclarations?: GeminiNativeFunctionDeclaration[];
    google_search?: Record<string, unknown>;
    url_context?: Record<string, unknown>;
}

export interface GeminiNativeToolConfig {
    functionCallingConfig?: {
        mode: "AUTO" | "ANY" | "NONE";
        allowedFunctionNames?: string[];
    };
}

// --- Safety Settings ---

export interface GeminiNativeSafetySetting {
    category:
    | "HARM_CATEGORY_HARASSMENT"
    | "HARM_CATEGORY_HATE_SPEECH"
    | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
    | "HARM_CATEGORY_DANGEROUS_CONTENT";
    threshold:
    | "BLOCK_NONE"
    | "BLOCK_FEW"
    | "BLOCK_SOME"
    | "BLOCK_ONLY_HIGH"
    | "HARM_BLOCK_THRESHOLD_UNSPECIFIED";
}

// --- Request Types ---

export interface GeminiNativeRequest {
    contents: GeminiNativeContent[];
    systemInstruction?: GeminiNativeSystemInstruction;
    generationConfig?: GeminiNativeGenerationConfig;
    tools?: GeminiNativeTool[];
    toolConfig?: GeminiNativeToolConfig;
    safetySettings?: GeminiNativeSafetySetting[];
}

// --- Response Types ---

export interface GeminiNativeCandidate {
    content: {
        role: "model";
        parts: GeminiNativePart[];
    };
    finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
    safetyRatings?: Array<{
        category: string;
        probability: string;
    }>;
    groundingMetadata?: Record<string, unknown>;
}

export interface GeminiNativeUsageMetadata {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    thoughtsTokenCount?: number;
}

export interface GeminiNativeResponse {
    candidates: GeminiNativeCandidate[];
    usageMetadata?: GeminiNativeUsageMetadata;
    modelVersion?: string;
}

// --- Model Info Types ---

export interface GeminiNativeModelInfo {
    name: string;
    displayName: string;
    description: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
    supportedGenerationMethods: string[];
}

export interface GeminiNativeModelsResponse {
    models: GeminiNativeModelInfo[];
}

// --- Stream Chunk Types ---

export interface GeminiNativeStreamChunk {
    type: "gemini_native";
    data: GeminiNativeResponse;
}

// --- Type Guards ---

export function isGeminiNativeTextPart(part: GeminiNativePart): part is GeminiNativeTextPart {
    return "text" in part && !("thought" in part);
}

export function isGeminiNativeThoughtPart(part: GeminiNativePart): part is GeminiNativeThoughtPart {
    return "text" in part && "thought" in part && (part as GeminiNativeThoughtPart).thought === true;
}

export function isGeminiNativeFunctionCallPart(part: GeminiNativePart): part is GeminiNativeFunctionCallPart {
    return "functionCall" in part;
}

export function isGeminiNativeFunctionResponsePart(part: GeminiNativePart): part is GeminiNativeFunctionResponsePart {
    return "functionResponse" in part;
}

export function isGeminiNativeInlineDataPart(part: GeminiNativePart): part is GeminiNativeInlineDataPart {
    return "inlineData" in part;
}

export function isGeminiNativeFileDataPart(part: GeminiNativePart): part is GeminiNativeFileDataPart {
    return "fileData" in part;
}
