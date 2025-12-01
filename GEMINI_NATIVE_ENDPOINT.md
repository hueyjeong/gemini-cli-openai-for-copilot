# Gemini Native Endpoint 구현 계획

## 개요

LiteLLM에서 `gemini/` 접두사로 연결 시 Gemini API 형식을 그대로 유지하여 `thought_signature`와 `systemInstruction`을 네이티브로 처리합니다. 기존 OpenAI 라우트는 유지하고, Gemini 라우트는 독립적으로 구현합니다.

## 목표

- **thought_signature 네이티브 지원**: `skip_thought_signature_validator` 우회 없이 실제 signature 전달
- **systemInstruction 원본 유지**: Gemini API의 별도 필드로 시스템 프롬프트 전달
- **thinkingLevel 지원**: Gemini 2.5 (thinkingBudget) 및 Gemini 3+ (thinkingLevel) 모두 지원
- **LiteLLM 호환**: `gemini/` 접두사로 직접 연결 가능

## 구현 완료 상태

| 단계   | 상태 | 설명                                                        |
| ------ | ---- | ----------------------------------------------------------- |
| Step 1 | ✅   | Gemini 네이티브 타입 정의 (`src/types/gemini-native.ts`)    |
| Step 2 | ✅   | Gemini API 키 인증 미들웨어 (`src/middlewares/auth.ts`)     |
| Step 3 | ✅   | 환경변수 타입 업데이트 (`src/types.ts`)                     |
| Step 4 | ✅   | Gemini 네이티브 라우트 구현 (`src/routes/gemini.ts`)        |
| Step 5 | ✅   | Gemini 네이티브 스트림 변환기 (`src/stream-transformer.ts`) |
| Step 6 | ✅   | GeminiApiClient 수정 (`src/gemini-client.ts`)               |
| Step 7 | ✅   | 라우트 등록 (`src/index.ts`)                                |
| Step 8 | ✅   | .dev.vars 파일 업데이트 (`configs/.dev.vars.*`)             |
| Step 9 | ✅   | LiteLLM 설정 업데이트 (`litellm/config.yaml`)               |

```
LiteLLM (gemini/gemini-2.5-flash)
        │
        ▼
┌─────────────────────────────┐
│  /gemini/models/:model:...  │  ← Gemini 네이티브 형식 요청
│  (routes/gemini.ts)         │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│  GeminiApiClient            │  ← streamContentNative()
│  (gemini-client.ts)         │  ← thought_signature 포함 반환
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│  Code Assist API            │  ← Google Cloud
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│  GeminiNativeStreamTransformer │ ← Gemini SSE 형식 그대로 출력
└─────────────────────────────┘
        │
        ▼
LiteLLM (Gemini 네이티브 응답)
```

## 구현 단계

### Step 1: Gemini 네이티브 타입 정의 ✅

- [x] `src/types/gemini-native.ts` 생성
- [x] `GeminiNativeRequest`, `GeminiNativeResponse` 정의
- [x] `ThinkingConfig` (thinkingBudget + thinkingLevel) 정의
- [x] `GeminiContent`, `GeminiPart` 정의

### Step 2: Gemini API 키 인증 미들웨어 ✅

- [x] `src/middlewares/auth.ts`에 `geminiApiKeyAuth` 추가
- [x] `x-goog-api-key` 헤더 지원
- [x] `?key=` 쿼리 파라미터 지원
- [x] `GEMINI_API_KEY` 환경변수 검증

### Step 3: 환경변수 타입 업데이트 ✅

- [x] `src/types.ts`에 `GEMINI_API_KEY?: string` 추가

### Step 4: Gemini 네이티브 라우트 구현 ✅

- [x] `src/routes/gemini.ts` 생성
- [x] `GET /models` - 모델 목록 (Gemini 형식)
- [x] `POST /models/:model:generateContent` - 비스트리밍
- [x] `POST /models/:model:streamGenerateContent` - 스트리밍
- [x] `systemInstruction` 필드 그대로 전달
- [x] `thought_signature` 응답에 포함

### Step 5: Gemini 네이티브 스트림 변환기 ✅

- [x] `src/stream-transformer.ts`에 `createGeminiNativeStreamTransformer` 추가
- [x] Gemini SSE 형식 (`data: {...}`) 그대로 출력

### Step 6: GeminiApiClient 수정 ✅

- [x] `streamContentNative()` 메서드 추가
- [x] Gemini 형식 contents/systemInstruction 직접 수신
- [x] `thought_signature`를 part에 포함하여 반환
- [x] 새 청크 타입 `gemini_native` 추가

### Step 7: 라우트 등록 ✅

- [x] `src/index.ts`에 `/gemini` 경로 등록
- [x] `geminiApiKeyAuth` 미들웨어 적용

### Step 8: .dev.vars 파일 업데이트 ✅

- [x] `configs/.dev.vars.1` ~ `.dev.vars.5`에 `GEMINI_API_KEY` 추가

### Step 9: LiteLLM 설정 업데이트 ✅

- [x] `litellm/config.yaml`에 `gemini/` 접두사 모델 추가
- [x] `api_base: http://gemini-proxy-N:8787/gemini` 설정

## Gemini API 형식 참조

### 요청 형식

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "Hello" }]
    }
  ],
  "systemInstruction": {
    "parts": [{ "text": "You are a helpful assistant" }]
  },
  "generationConfig": {
    "temperature": 1.0,
    "maxOutputTokens": 8192,
    "thinkingConfig": {
      "thinkingBudget": 1024,
      "includeThoughts": true
    }
  },
  "tools": [...],
  "safetySettings": [...]
}
```

### 응답 형식 (스트리밍)

```
data: {"candidates":[{"content":{"parts":[{"text":"Hello!"}],"role":"model"}}],"usageMetadata":{...}}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{}},"thoughtSignature":"abc123"}]}}]}
```

## 인증 방식

### Gemini API 키 (Google 스타일)

- 헤더: `x-goog-api-key: AIza...`
- 쿼리: `?key=AIza...`
- 환경변수: `GEMINI_API_KEY=AIza...`

## LiteLLM 설정 예시

```yaml
model_list:
  - model_name: gemini-2.5-flash-native
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_base: http://gemini-proxy-1:8787/gemini
      api_key: "AIza..."
```

## 참고 문서

- [Vertex AI Gemini API Reference](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference)
- [LiteLLM Gemini 2.5 thought_signature](https://docs.litellm.ai/blog/gemini_3)
