import * as net from "node:net";
import * as mockttp from "mockttp";
import type { CompletedRequest, CompletedResponse, AbortedRequest, Mockttp } from "mockttp";
import { shouldCapture, sanitizeHeaders, sanitizeURL, flattenHeaders } from "./interceptor.js";
import { sendToCoolhand, type CapturedInteraction } from "./sender.js";
import type { CACredentials } from "./certs.js";
import { redactSecrets } from "../sessions/redact-secrets.js";

const LOOPBACK = "127.0.0.1";

/**
 * mockttp has no host/bind-address option anywhere in its public API (checked
 * every published 4.x release, including latest) — Mockttp#start(port) always
 * calls its internal combo server's .listen(port) with no host, which binds
 * the wildcard address and turns this MITM proxy into an unauthenticated open
 * forward proxy reachable from the local network (coolhand-cli#119).
 *
 * mockttp's combo server is built via httpolyglot, whose `Server` class
 * `extends net.Server` without overriding `listen()`, so it inherits
 * `net.Server.prototype.listen` directly — same as http.Server/https.Server.
 * We exploit that to force a real loopback bind, identical in effect to
 * callback-server.ts's own `server.listen(0, LOOPBACK, ...)`, by scope-patching
 * the prototype for the exact duration of the start() call. Do not remove this
 * without confirming upstream mockttp has added a real host option.
 */
// Guards against two overlapping startMockttpOnLoopback() calls stepping on
// each other's prototype patch — startProxy() only ever runs once per CLI
// process, so this should never trip in practice; it exists so a future
// concurrent caller fails loudly instead of silently reverting to a wildcard
// bind for whichever call restores the prototype first.
let patchInFlight = false;

async function startMockttpOnLoopback(server: Mockttp, port: number | undefined): Promise<void> {
  if (patchInFlight) {
    throw new Error("[coolhand-proxy] a proxy is already starting — concurrent startProxy() calls are not supported");
  }
  patchInFlight = true;

  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
    // Only the (port[, callback]) shape needs a host injected — leave any
    // other call shape (e.g. one that already specifies a host) untouched.
    if (typeof args[0] === "number" && (args.length === 1 || typeof args[1] === "function")) {
      args.splice(1, 0, LOOPBACK);
    }
    return originalListen.apply(this, args as Parameters<typeof originalListen>);
  } as typeof originalListen;

  try {
    await server.start(port ?? 0);
  } finally {
    net.Server.prototype.listen = originalListen;
    patchInFlight = false;
  }

  // Defense in depth: if a future mockttp release changes its internals such
  // that the patch above silently no-ops, fail loudly here rather than run an
  // open proxy unnoticed. Verification itself is best-effort — if it can't
  // determine the bound host (e.g. the private field was renamed), skip the
  // check rather than fail the whole command over an inability to double-check.
  let boundHost: string | undefined;
  try {
    const internal = (server as unknown as { server?: net.Server }).server;
    const address = internal?.address();
    boundHost = address && typeof address === "object" ? address.address : undefined;
  } catch {
    return;
  }
  if (boundHost !== undefined && boundHost !== LOOPBACK) {
    await server.stop().catch(() => undefined);
    throw new Error(
      `[coolhand-proxy] refused to start: proxy bound to ${boundHost}, expected ${LOOPBACK}. ` +
      `This likely means mockttp's internals changed in a way that broke the loopback-only fix — see coolhand-cli#119.`
    );
  }
}

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

function redactBodyText(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactSecrets(text);
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
          body: redactBodyText(requestBodyText),
        },
        response: {
          statusCode: res.statusCode,
          headers: sanitizeHeaders(flattenHeaders(res.headers as Record<string, string | string[] | undefined>)),
          body: redactBodyText(responseBodyText),
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
  await startMockttpOnLoopback(server, options.port);

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
