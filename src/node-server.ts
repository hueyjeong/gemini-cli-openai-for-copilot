/**
 * Node.js HTTP Server wrapper for the Hono app
 * This allows running the app with HTTP proxy support via global-agent
 */

// Bootstrap global-agent for HTTP proxy support BEFORE any other imports
import "global-agent/bootstrap";

import { serve } from "@hono/node-server";
import app from "./index";

const port = parseInt(process.env.PORT || "8787", 10);

console.log(`[Node Server] Starting server on port ${port}...`);
console.log(`[Node Server] HTTP_PROXY: ${process.env.HTTP_PROXY || "not set"}`);
console.log(`[Node Server] HTTPS_PROXY: ${process.env.HTTPS_PROXY || "not set"}`);

serve({
    fetch: app.fetch,
    port
}, (info) => {
    console.log(`[Node Server] Server is running on http://localhost:${info.port}`);
});
