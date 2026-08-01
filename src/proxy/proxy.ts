import * as mockttp from "mockttp";
import type { CompletedRequest, CompletedResponse, AbortedRequest } from "mockttp";
import { shouldCapture, sanitizeHeaders, sanitizeURL, flattenHeaders } from "./interceptor.js";
import { sendToCoolhand, type CapturedInteraction } from "./sender.js";
import type { CACredentials } from "./certs.js";

export interface ProxyOptions {
  /** The port to bind to. Omit or pass 0 to let the OS pick a free ephemeral port. */
  port?: number;
  apiKey: string;
  apiEndpoint?: string;
  silent?: boolean;
  /** Overrides the default `<package>/claude` collector label sent with each captured request. */
  collector?: string;
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
  timestamp: string;
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
    // Guard against a PatternMatchingService constructor failure — if shouldCapture
    // throws, skip capture for this request rather than crashing the event handler.
    let capture: boolean;
    try { capture = shouldCapture(req.url); } catch { return; }
    if (!capture) { return; }
    pendingRequests.set(req.id, {
      method: req.method,
      url: req.url,
      headers: flattenHeaders(req.headers as Record<string, string | string[] | undefined>),
      bodyPromise: Promise.resolve().then(() => req.body.getText()),
      startTimestamp: req.timingEvents?.startTimestamp ?? performance.now(),
      timestamp: new Date().toISOString(),
    });
  });

  await server.on("abort", (req: AbortedRequest) => {
    // The stored bodyPromise continues running and resolves normally; its
    // result is simply discarded. This is intentional — no cleanup needed.
    pendingRequests.delete(req.id);
  });

  await server.on("response", (res: CompletedResponse) => {
    const req = pendingRequests.get(res.id);
    if (!req) { return; }
    pendingRequests.delete(res.id);

    const endTimestamp = res.timingEvents?.responseSentTimestamp ?? performance.now();
    const durationMs = endTimestamp - req.startTimestamp;

    // Read request and response bodies concurrently — req.bodyPromise started
    // when the request arrived and is likely already settled by the time the
    // response handler fires, so Promise.all adds no extra latency.
    const send = Promise.all([res.body.getText(), req.bodyPromise]).then(([responseBodyText, requestBodyText]) => {
      const sanitizedUrl = sanitizeURL(req.url);
      const captured: CapturedInteraction = {
        request: {
          method: req.method,
          url: sanitizedUrl,
          headers: sanitizeHeaders(req.headers),
          body: requestBodyText,
        },
        response: {
          statusCode: res.statusCode,
          headers: sanitizeHeaders(flattenHeaders(res.headers as Record<string, string | string[] | undefined>)),
          body: responseBodyText,
        },
        timestamp: req.timestamp,
      };

      if (!options.silent) {
        console.error(
          `[coolhand-proxy] Captured ${req.method} ${sanitizedUrl} -> ${res.statusCode} (${Math.round(durationMs)}ms)`
        );
      }

      return sendToCoolhand(captured, {
        apiKey: options.apiKey,
        apiEndpoint: options.apiEndpoint,
        silent: options.silent,
        collector: options.collector,
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
      // Stop the server first so no new response events can fire and add to
      // inFlightSends after we snapshot it for draining. This relies on
      // mockttp's server.stop() completing all queued event callbacks before
      // resolving — a 15 s hard deadline guards against any future change to
      // that guarantee or a pathological send that never settles.
      await server.stop();
      // Each in-flight send has a 10 s AbortController timeout so all sends
      // settle within that window; the 15 s deadline is a safety net.
      const drainDeadline = Date.now() + 15_000;
      while (inFlightSends.size > 0 && Date.now() < drainDeadline) {
        await Promise.allSettled([...inFlightSends]);
      }
      if (!options.silent) {
        console.error("[coolhand-proxy] Proxy stopped");
      }
    },
  };
}
