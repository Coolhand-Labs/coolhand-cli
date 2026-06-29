import { parseBody } from "coolhand-node";
import { PACKAGE_IDENTIFIER } from "../version.js";

export interface CapturedInteraction {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | undefined;
  };
  response: {
    statusCode: number;
    headers: Record<string, string>;
    body: string | undefined;
  };
  durationMs: number;
  timestamp: string;
}

interface SendOptions {
  apiKey: string;
  apiEndpoint?: string;
  silent?: boolean;
  debug?: boolean;
}

const DEFAULT_ENDPOINT = "https://coolhandlabs.com/api/v2/llm_request_logs";

/**
 * Forward a captured interaction to the Coolhand API.
 * Uses the same payload format as coolhand-node's LoggingService.
 */
export async function sendToCoolhand(
  captured: CapturedInteraction,
  options: SendOptions
): Promise<void> {
  const { apiKey, debug, silent } = options;
  const endpoint = options.apiEndpoint ?? DEFAULT_ENDPOINT;

  const payload = {
    llm_request_log: {
      raw_request: {
        id: 0,
        method: captured.request.method,
        url: captured.request.url,
        headers: captured.request.headers,
        request_body: parseBody(captured.request.body),
        response_body: parseBody(captured.response.body),
        response_headers: captured.response.headers,
        status_code: captured.response.statusCode,
        timestamp: captured.timestamp,
        protocol: "https",
      },
      collector: `${PACKAGE_IDENTIFIER}/claude`,
    },
  };

  if (debug) {
    console.log("[coolhand-proxy] Debug mode - would send:", JSON.stringify(payload, null, 2));
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      if (!silent) {
        const body = await response.text();
        console.error(
          `[coolhand-proxy] Failed to send to Coolhand (${response.status}): ${body}`
        );
      }
    } else if (!silent) {
      console.error(`[coolhand-proxy] Logged ${captured.request.method} ${captured.request.url}`);
    }
  } catch (error) {
    clearTimeout(timeout);
    if (!silent) {
      console.error(`[coolhand-proxy] Failed to send to Coolhand:`, error);
    }
  }
}
