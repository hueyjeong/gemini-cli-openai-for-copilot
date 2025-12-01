import { Hono } from "hono";
import { Env } from "./types";
import { OpenAIRoute } from "./routes/openai";
import { GeminiRoute } from "./routes/gemini";
import { DebugRoute } from "./routes/debug";
import { openAIApiKeyAuth, geminiApiKeyAuth } from "./middlewares/auth";
import { loggingMiddleware } from "./middlewares/logging";

/**
 * Gemini CLI OpenAI Worker
 *
 * A Cloudflare Worker that provides OpenAI-compatible API endpoints
 * for Google's Gemini models via the Gemini CLI OAuth flow.
 *
 * Features:
 * - OpenAI-compatible chat completions and model listing
 * - Gemini-native API endpoints for LiteLLM gemini/ prefix support
 * - OAuth2 authentication with token caching via Cloudflare KV
 * - Support for multiple Gemini models (2.5 Pro, 2.0 Flash, 1.5 Pro, etc.)
 * - Streaming responses compatible with OpenAI SDK
 * - Debug and testing endpoints for troubleshooting
 */

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// Add logging middleware
app.use("*", loggingMiddleware);

// Add CORS headers for all requests
app.use("*", async (c, next) => {
	// Set CORS headers
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-goog-api-key");

	// Handle preflight requests
	if (c.req.method === "OPTIONS") {
		c.status(204);
		return c.body(null);
	}

	await next();
});

// Apply OpenAI API key authentication middleware to all /v1 routes
app.use("/v1/*", openAIApiKeyAuth);

// Apply Gemini API key authentication middleware to /gemini routes
app.use("/gemini/*", geminiApiKeyAuth);

// Setup route handlers
app.route("/v1", OpenAIRoute);
app.route("/v1/debug", DebugRoute);
app.route("/gemini", GeminiRoute);

// Add individual debug routes to main app for backward compatibility
app.route("/v1", DebugRoute);

// Root endpoint - basic info about the service
app.get("/", (c) => {
	const requiresOpenAIAuth = !!c.env.OPENAI_API_KEY;
	const requiresGeminiAuth = !!c.env.GEMINI_API_KEY;

	return c.json({
		name: "Gemini CLI OpenAI Worker",
		description: "OpenAI-compatible and Gemini-native API for Google Gemini models via OAuth",
		version: "1.1.0",
		authentication: {
			openai: {
				required: requiresOpenAIAuth,
				type: requiresOpenAIAuth ? "Bearer token in Authorization header" : "None"
			},
			gemini: {
				required: requiresGeminiAuth,
				type: requiresGeminiAuth ? "x-goog-api-key header or ?key= query parameter" : "None"
			}
		},
		endpoints: {
			openai_compatible: {
				chat_completions: "/v1/chat/completions",
				models: "/v1/models"
			},
			gemini_native: {
				models: "/gemini/models",
				generate_content: "/gemini/models/{model}:generateContent",
				stream_generate_content: "/gemini/models/{model}:streamGenerateContent"
			},
			debug: {
				cache: "/v1/debug/cache",
				token_test: "/v1/token-test",
				full_test: "/v1/test"
			}
		},
		documentation: "https://github.com/gewoonjaap/gemini-cli-openai"
	});
});

// Health check endpoint
app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// IP check endpoint - fetches public IP from ifconfig.me to verify proxy is working
app.get("/ip", async (c) => {
	try {
		const proxyUrl = c.env.HTTP_PROXY;

		// redsocks handles transparent proxying at network level
		// so we just do a normal fetch and the proxy will intercept it
		// Using HTTPS with Google API domain to test proxy for Gemini API calls
		const response = await fetch("https://api.ipify.org?format=json", {
			headers: { "User-Agent": "curl/7.64.1" }
		});

		if (!response.ok) {
			return c.json({
				error: "Failed to fetch IP",
				status: response.status,
				statusText: response.statusText
			}, 500);
		}

		const ip = (await response.text()).trim();

		return c.json({
			ip,
			timestamp: new Date().toISOString(),
			proxy: {
				configured: proxyUrl || "not set"
			}
		});
	} catch (error) {
		return c.json({
			error: "Failed to fetch IP",
			message: error instanceof Error ? error.message : String(error),
			timestamp: new Date().toISOString()
		}, 500);
	}
});

export default app;
