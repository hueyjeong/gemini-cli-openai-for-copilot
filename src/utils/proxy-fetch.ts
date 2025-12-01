/**
 * Proxy Fetch Utility for Cloudflare Workers
 * 
 * Uses Cloudflare's TCP Socket API (connect()) to establish
 * HTTP CONNECT tunnels through a proxy server for HTTPS requests.
 */

/**
 * Parse a URL into its components
 */
function parseUrl(url: string): { protocol: string; hostname: string; port: number; path: string } {
    const urlObj = new URL(url);
    const defaultPort = urlObj.protocol === "https:" ? 443 : 80;
    return {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port ? parseInt(urlObj.port, 10) : defaultPort,
        path: urlObj.pathname + urlObj.search
    };
}

/**
 * Fetch through an HTTP proxy using Cloudflare's connect() API
 * for establishing TCP connections to the proxy server.
 */
export async function proxyFetch(
    url: string,
    init: RequestInit = {},
    proxyUrl?: string
): Promise<Response> {
    if (!proxyUrl) {
        // No proxy configured, use regular fetch
        return fetch(url, init);
    }

    const target = parseUrl(url);
    const proxy = parseUrl(proxyUrl);

    try {
        // Use Cloudflare's connect() API to establish TCP connection to proxy
        // @ts-expect-error - connect is available in Cloudflare Workers runtime
        const socket = connect({
            hostname: proxy.hostname,
            port: proxy.port
        });

        const writer = socket.writable.getWriter();
        const reader = socket.readable.getReader();

        // Send HTTP CONNECT request to establish tunnel
        const connectRequest = `CONNECT ${target.hostname}:${target.port} HTTP/1.1\r\nHost: ${target.hostname}:${target.port}\r\n\r\n`;
        await writer.write(new TextEncoder().encode(connectRequest));

        // Read CONNECT response
        let responseText = "";
        const decoder = new TextDecoder();

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            responseText += decoder.decode(value, { stream: true });
            if (responseText.includes("\r\n\r\n")) break;
        }

        // Check if CONNECT was successful
        if (!responseText.startsWith("HTTP/1.1 200") && !responseText.startsWith("HTTP/1.0 200")) {
            throw new Error(`Proxy CONNECT failed: ${responseText.split("\r\n")[0]}`);
        }

        // Now we have a tunnel - upgrade to TLS and make the actual request
        // @ts-expect-error - startTls is available on socket
        const secureSocket = await socket.startTls({ hostname: target.hostname });

        // Build HTTP request
        const method = init.method || "GET";
        const headers = new Headers(init.headers);
        headers.set("Host", target.hostname);

        let httpRequest = `${method} ${target.path || "/"} HTTP/1.1\r\n`;
        headers.forEach((value, key) => {
            httpRequest += `${key}: ${value}\r\n`;
        });

        if (init.body) {
            const bodyStr = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
            headers.set("Content-Length", String(new TextEncoder().encode(bodyStr).length));
            httpRequest += `Content-Length: ${new TextEncoder().encode(bodyStr).length}\r\n`;
            httpRequest += "\r\n";
            httpRequest += bodyStr;
        } else {
            httpRequest += "\r\n";
        }

        const secureWriter = secureSocket.writable.getWriter();
        await secureWriter.write(new TextEncoder().encode(httpRequest));

        // Read response
        const secureReader = secureSocket.readable.getReader();
        let fullResponse = "";

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            fullResponse += decoder.decode(value, { stream: true });
        }

        // Parse response (simplified - in production, properly parse HTTP response)
        const [headersPart, ...bodyParts] = fullResponse.split("\r\n\r\n");
        const statusLine = headersPart.split("\r\n")[0];
        const statusCode = parseInt(statusLine.split(" ")[1], 10);
        const body = bodyParts.join("\r\n\r\n");

        return new Response(body, {
            status: statusCode,
            headers: new Headers()
        });

    } catch (error) {
        console.error("[ProxyFetch] Proxy connection failed:", error);
        // Fallback to direct fetch
        console.log("[ProxyFetch] Falling back to direct fetch");
        return fetch(url, init);
    }
}

/**
 * Create a fetch function bound to a specific proxy
 */
export function createProxyFetch(proxyUrl?: string) {
    return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        return proxyFetch(urlString, init, proxyUrl);
    };
}
