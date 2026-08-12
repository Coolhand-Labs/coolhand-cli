/**
 * Scrub likely secrets out of captured session text before it leaves the machine.
 *
 * Session transcripts now carry tool inputs (file contents from Edit/Write) and tool outputs
 * (command output, `cat .env`, printed environment), so the upload body can contain credentials.
 * `logger.redact` only covers stderr and only Coolhand's own token shape, so this is a separate,
 * broader scrubber applied to every message's content string in `parseTranscript`.
 *
 * This is best-effort defence in depth, not a guarantee: it targets common, well-shaped secret
 * formats. It deliberately errs toward over-redaction (e.g. long hex strings) rather than leaking.
 */

/** Well-known token shapes replaced wholesale wherever they appear. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /ch_pub_[A-Za-z0-9_-]{8,}/g, // Coolhand public token
  /ch_priv_[A-Za-z0-9_-]{8,}/g, // Coolhand private token
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style secret key
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal access token
  /gho_[A-Za-z0-9]{20,}/g, // GitHub OAuth token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token (bot/user/app/refresh/config)
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /sk_live_[0-9A-Za-z]{16,}/g, // Stripe live secret key
  /sk_test_[0-9A-Za-z]{16,}/g, // Stripe test secret key
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT (three base64url segments)
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // Authorization: Bearer <token>
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs (generic tokens / hashes)
];

// Two variants: a QUOTED value may contain spaces ("my secret value"); a BARE value stops at
// whitespace. Splitting them closes the gap where a spaced quoted secret was only partly redacted.
const ASSIGNMENT_QUOTED =
  /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key)\b\s*[:=]\s*)(['"])[^'"]*\2/gi;
const ASSIGNMENT_BARE =
  /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key)\b\s*[:=]\s*)[^\s'"]+/gi;

const REDACTED = '[REDACTED]';

/** Return `text` with recognised secrets replaced by `[REDACTED]`. Safe on empty input. */
export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let out = text
    .replace(ASSIGNMENT_QUOTED, `$1$2${REDACTED}$2`)
    .replace(ASSIGNMENT_BARE, `$1${REDACTED}`);
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
