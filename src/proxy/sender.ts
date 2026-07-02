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
  timestamp: string;
}

interface SendOptions {
  apiKey: string;
  apiEndpoint?: string;
  silent?: boolean;
}

const DEFAULT_ENDPOINT = "https://coolhandlabs.com/api/v2/llm_request_logs";

let _nextId = 0;

/** @internal Reset the call ID counter. Exposed for test isolation only.
 *  Call in beforeEach in any test file that imports sendToCoolhand — Jest
 *  may share this module instance across test files in the same worker.
 */
export function resetCallIdForTesting(): void { _nextId = 0; }

/**
 * Forward a captured interaction to the Coolhand API.
 * Uses the same payload format as coolhand-node's LoggingService.
 */
export async function sendToCoolhand(
  captured: CapturedInteraction,
  options: SendOptions
): Promise<void> {
  const { apiKey, silent } = options;
  const endpoint = options.apiEndpoint ?? DEFAULT_ENDPOINT;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const payload = {
      llm_request_log: {
        raw_request: {
          id: ++_nextId,
          method: captured.request.method,
          url: captured.request.url,
          headers: captured.request.headers,
          request_body: parseBody(captured.request.body),
          response_body: parseBody(captured.response.body),
          response_headers: captured.response.headers,
          status_code: captured.response.statusCode,
          timestamp: captured.timestamp,
          protocol: new URL(captured.request.url).protocol.replace(":", ""),
        },
        collector: `${PACKAGE_IDENTIFIER}/claude`,
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Cancel the abort timer as soon as the response headers arrive so that
    // slow error-body reads (response.text() below) don't trigger it.
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
