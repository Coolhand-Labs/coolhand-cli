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
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, // Authorization: Basic <base64 user:pass>
  /https:\/\/hooks\.slack\.com\/services\/\S+/g, // Slack incoming webhook URL
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/g, // Discord webhook URL
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs (generic tokens / hashes)
  // PEM-formatted private key blocks (SSH/RSA/EC/OpenSSH/PGP/encrypted) — no assignment keyword
  // sits next to the base64 body, so ASSIGNMENT_QUOTED/BARE never catch these; a `cat ~/.ssh/id_rsa`
  // in a tool output or a deploy key embedded in a config file would otherwise sail through whole.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/g,
];

// Two variants: a QUOTED value may contain spaces ("my secret value"); a BARE value stops at
// whitespace. Splitting them closes the gap where a spaced quoted secret was only partly redacted.
// The optional `["']?` right after the keyword matches a JSON key's closing quote (`"api_key":
// "value"` — the key is itself quoted, unlike the YAML/shell-style `api_key: value`/`api_key=value`
// this was originally written for), so plain JSON — the dominant config format under
// `~/.claude` — is covered too, not just unquoted-key assignment syntax.
const ASSIGNMENT_QUOTED =
  /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*)(['"])[^'"]*\2/gi;
const ASSIGNMENT_BARE =
  /((?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*)[^\s'"]+/gi;

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
