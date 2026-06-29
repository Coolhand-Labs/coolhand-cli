import * as mockttp from "mockttp";
import type { CompletedRequest, CompletedResponse, AbortedRequest } from "mockttp";
import { shouldCapture, sanitizeHeaders } from "./interceptor.js";
import { sendToCoolhand, type CapturedInteraction } from "./sender.js";
import type { CACredentials } from "./certs.js";

export interface ProxyOptions {
  port?: number;
  apiKey: string;
  apiEndpoint?: string;
  silent?: boolean;
  debug?: boolean;
}

export interface ProxyInstance {
  port: number;
  stop: () => Promise<void>;
}

interface PendingRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyPromise: Promise<string | undefined>;
  startTimestamp: number;
}

/**
 * Start an HTTPS MITM proxy that intercepts LLM API calls
 * and forwards them to the Coolhand platform.
 */
export async function startProxy(
  ca: CACredentials,
  options: ProxyOptions
): Promise<ProxyInstance> {
  const server = mockttp.getLocal({
    https: { key: ca.key, cert: ca.cert },
  });

  // Track pending requests by ID for pairing with responses
  const pendingRequests = new Map<string, PendingRequest>();
  // Track in-flight sendToCoolhand calls so stop() can drain them before halting
  const inFlightSends = new Set<Promise<void>>();

  await server.on("request", (req: CompletedRequest) => {
    if (!shouldCapture(req.url)) { return; }
    pendingRequests.set(req.id, {
      method: req.method,
      url: req.url,
      headers: req.headers as Record<string, string>,
      bodyPromise: req.body.getText(),
      startTimestamp: req.timingEvents?.startTimestamp ?? performance.now(),
    });
  });

  await server.on("abort", (req: AbortedRequest) => {
    pendingRequests.delete(req.id);
  });

  await server.on("response", (res: CompletedResponse) => {
    const req = pendingRequests.get(res.id);
    if (!req) { return; }
    pendingRequests.delete(res.id);

    const endTimestamp = res.timingEvents?.responseSentTimestamp ?? performance.now();
    const durationMs = endTimestamp - req.startTimestamp;

    // Get response body asynchronously, then forward
    const send = res.body.getText().then((responseBodyText) => {
      return req.bodyPromise.then((requestBodyText) => {
        const captured: CapturedInteraction = {
          request: {
            method: req.method,
            url: req.url,
            headers: sanitizeHeaders(req.headers),
            body: requestBodyText,
          },
          response: {
            statusCode: res.statusCode,
            headers: sanitizeHeaders(res.headers as Record<string, string>),
            body: responseBodyText,
          },
          durationMs: Math.round(durationMs),
          timestamp: new Date().toISOString(),
        };

        if (!options.silent) {
          console.error(
            `[coolhand-proxy] Captured ${req.method} ${req.url} -> ${res.statusCode} (${Math.round(durationMs)}ms)`
          );
        }

        return sendToCoolhand(captured, {
          apiKey: options.apiKey,
          apiEndpoint: options.apiEndpoint,
          silent: options.silent,
          debug: options.debug,
        });
      });
    }).catch((err) => {
      if (!options.silent) {
        console.error("[coolhand-proxy] Capture/send error:", err);
      }
    });

    inFlightSends.add(send);
    send.finally(() => inFlightSends.delete(send));
  });

  // Pass all requests through to their real destinations
  await server.forAnyRequest().thenPassThrough();
  await server.start(options.port ?? 0);

  const port = server.port;
  if (!options.silent) {
    console.error(`[coolhand-proxy] Proxy started on port ${port}`);
  }

  return {
    port,
    stop: async () => {
      await Promise.allSettled(inFlightSends);
      await server.stop();
      if (!options.silent) {
        console.error("[coolhand-proxy] Proxy stopped");
      }
    },
  };
}
