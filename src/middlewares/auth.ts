import { MiddlewareHandler } from "hono";
import { Env } from "../types";

/**
 * Middleware to enforce OpenAI-style API key authentication if OPENAI_API_KEY is set in the environment.
 * Checks for 'Authorization: Bearer <key>' header on protected routes.
 */
export const openAIApiKeyAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	// Skip authentication for public endpoints
	const publicEndpoints = ["/", "/health"];
	if (publicEndpoints.some((endpoint) => c.req.path === endpoint)) {
		await next();
		return;
	}

	// If OPENAI_API_KEY is set in environment, require authentication
	if (c.env.OPENAI_API_KEY) {
		const authHeader = c.req.header("Authorization");

		if (!authHeader) {
			return c.json(
				{
					error: {
						message: "Missing Authorization header",
						type: "authentication_error",
						code: "missing_authorization"
					}
				},
				401
			);
		}

		// Check for Bearer token format
		const match = authHeader.match(/^Bearer\s+(.+)$/);
		if (!match) {
			return c.json(
				{
					error: {
						message: "Invalid Authorization header format. Expected: Bearer <token>",
						type: "authentication_error",
						code: "invalid_authorization_format"
					}
				},
				401
			);
		}

		const providedKey = match[1];
		if (providedKey !== c.env.OPENAI_API_KEY) {
			return c.json(
				{
					error: {
						message: "Invalid API key",
						type: "authentication_error",
						code: "invalid_api_key"
					}
				},
				401
			);
		}

		// Optionally log successful authentication
		// console.log('API key authentication successful');
	}

	await next();
};

/**
 * Middleware to enforce Google-style API key authentication if GEMINI_API_KEY is set in the environment.
 * Supports both 'x-goog-api-key' header and '?key=' query parameter (Google API style).
 */
export const geminiApiKeyAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	// Skip authentication for public endpoints
	const publicEndpoints = ["/", "/health"];
	if (publicEndpoints.some((endpoint) => c.req.path === endpoint)) {
		await next();
		return;
	}

	// If GEMINI_API_KEY is set in environment, require authentication
	if (c.env.GEMINI_API_KEY) {
		// Check x-goog-api-key header first (primary method)
		let providedKey: string | undefined = c.req.header("x-goog-api-key");

		// Fallback to ?key= query parameter (Google API style)
		if (!providedKey) {
			providedKey = c.req.query("key") || undefined;
		}

		// Also support Authorization: Bearer for compatibility
		if (!providedKey) {
			const authHeader = c.req.header("Authorization");
			if (authHeader) {
				const match = authHeader.match(/^Bearer\s+(.+)$/);
				if (match) {
					providedKey = match[1];
				}
			}
		}

		if (!providedKey) {
			return c.json(
				{
					error: {
						message: "Missing API key. Provide via 'x-goog-api-key' header or '?key=' query parameter.",
						code: 401,
						status: "UNAUTHENTICATED"
					}
				},
				401
			);
		}

		if (providedKey !== c.env.GEMINI_API_KEY) {
			return c.json(
				{
					error: {
						message: "Invalid API key",
						code: 401,
						status: "UNAUTHENTICATED"
					}
				},
				401
			);
		}
	}

	await next();
};
