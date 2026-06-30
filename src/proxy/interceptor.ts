import { PatternMatchingService } from "coolhand-node";

// Eagerly constructed at module load so patterns are loaded once and reused
// across all requests rather than on first call.
const patternService = new PatternMatchingService({ silent: true });

/**
 * Check if a URL matches a known AI API pattern.
 * Uses coolhand-node's PatternMatchingService which covers
 * OpenAI, Anthropic, Google AI, Cohere, Hugging Face, etc.
 */
export function shouldCapture(url: string): boolean {
  return patternService.matchesAPIPatternFromURL(url) !== null;
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

