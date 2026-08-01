import { PatternMatchingService } from "coolhand-node";

// Lazily instantiated so a constructor error surfaces at shouldCapture() call
// time rather than at module load time. The proxy request handler wraps
// shouldCapture() in a try/catch so the error degrades gracefully (skip
// capture) rather than crashing mockttp's event dispatch.
let _patternService: PatternMatchingService | undefined;
function getPatternService(): PatternMatchingService {
  if (!_patternService) { _patternService = new PatternMatchingService({ silent: true }); }
  return _patternService;
}

/**
 * Check if a URL matches a known AI API pattern.
 * Uses coolhand-node's PatternMatchingService which covers
 * OpenAI, Anthropic, Google AI, Cohere, Hugging Face, etc.
 */
export function shouldCapture(url: string): boolean {
  return getPatternService().matchesAPIPatternFromURL(url) !== null;
}

/**
 * Flatten a raw header map (values may be string[], string, or undefined)
 * into Record<string, string>, joining multi-value headers with ", ".
 */
export function flattenHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) { continue; }
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

/**
 * Sanitize headers by redacting sensitive values (API keys, auth tokens).
 */
export function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const sensitiveKeys = new Set([
    "authorization",
    "proxy-authorization",
    "x-goog-api-key",
    "x-api-key",
    "api-key",
    "cookie",
    "set-cookie",
    "openai-api-key",
  ]);

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = sensitiveKeys.has(key.toLowerCase())
      ? "[REDACTED]"
      : value;
  }
  return sanitized;
}

const SENSITIVE_QUERY_PARAMS = new Set([
  "key",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "secret",
]);

/**
 * Sanitize a URL by redacting sensitive query parameter values
 * (API keys, tokens) while leaving the rest of the URL intact.
 */
export function sanitizeURL(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.set(key, "[REDACTED]");
    }
  }

  return parsed.href;
}

