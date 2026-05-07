import https from "https";
import http from "http";

export default function ({ options, log }) {
  const anthropicVersion = options.anthropicVersion || "2023-06-01";
  const anthropicBeta = options.anthropicBeta || "mcp-client-2025-11-20";

  const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  const transport = baseUrl.protocol === "http:" ? http : https;
  const hostname = baseUrl.hostname;
  const port = baseUrl.port || (baseUrl.protocol === "http:" ? 80 : 443);
  const basePath = baseUrl.pathname.replace(/\/$/, "");

  log.info(`[claude-proxy] Using Anthropic endpoint: ${baseUrl.origin}${basePath}`);

  return function claudeProxy(req, res, next) {
    if (!req.url.startsWith("/v1/")) {
      return next();
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey && !authToken) {
      log.warn("[claude-proxy] Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN environment variable is not set" }));
      return;
    }

    const authHeaders = apiKey
      ? { "x-api-key": apiKey }
      : { "authorization": `Bearer ${authToken}` };

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);

      const proxyReq = transport.request(
        {
          hostname,
          port,
          path: basePath + req.url,
          method: req.method,
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            ...authHeaders,
            "anthropic-version": anthropicVersion,
            'anthropic-beta': anthropicBeta
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on("error", (err) => {
        log.error("[claude-proxy] Request failed:", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Upstream request failed", detail: err.message }));
        }
      });

      proxyReq.end(body);
    });
  };
};
