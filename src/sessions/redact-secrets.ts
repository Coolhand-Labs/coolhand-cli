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
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub personal access / OAuth / user-to-server / server-to-server / refresh token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g, // AWS access key id (long-lived and temporary)
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token (bot/user/app/refresh/config)
  /xapp-\d-[A-Za-z0-9-]{10,}/g, // Slack app-level token
  /SG\.[\w-]{16,}\.[\w-]{16,}/g, // SendGrid API key
  /\b(?:rk_live|rk_test)_[0-9A-Za-z]{16,}/g, // Stripe restricted key
  /whsec_[A-Za-z0-9]{24,}/g, // Stripe webhook signing secret
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /sk_live_[0-9A-Za-z]{16,}/g, // Stripe live secret key
  /sk_test_[0-9A-Za-z]{16,}/g, // Stripe test secret key
  /\beyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}/g, // JWT (three base64url segments)
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // Authorization: Bearer <token>
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, // Authorization: Basic <base64 user:pass>
  /https:\/\/hooks\.slack\.com\/services\/\S+/g, // Slack incoming webhook URL
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/g, // Discord webhook URL
  /npm_[A-Za-z0-9]{36}/g, // npm access token
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access token
  /hf_[A-Za-z0-9]{30,}/g, // Hugging Face token
  /ya29\.[A-Za-z0-9_-]+/g, // Google OAuth access token
  /pypi-[A-Za-z0-9_-]{20,}/g, // PyPI API token
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]*:[^\s/]+@/gi, // credentials embedded in a URL (scheme://user:pass@host, empty user allowed, `@` inside the password)
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs (generic tokens / hashes)
  // PEM-formatted private key blocks (SSH/RSA/EC/OpenSSH/PGP/encrypted) — no assignment keyword
  // sits next to the base64 body, so ASSIGNMENT_QUOTED/BARE never catch these; a `cat ~/.ssh/id_rsa`
  // in a tool output or a deploy key embedded in a config file would otherwise sail through whole.
  // The body is bounded and may end at the next BEGIN header or the end of the text, so a truncated key
  // (`head -5 id_rsa`) is still redacted and a long run of unterminated headers cannot go quadratic.
  // The header label runs are bounded too: unbounded runs made `-----BEGIN PRIVATE KEY PRIVATE KEY …` quadratic.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,40}-----[\s\S]{0,16384}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z0-9 ]{0,40}-----|(?=-----BEGIN )|$)/g,
];

// Two variants: a QUOTED value may contain spaces ("my secret value"); a BARE value stops at
// whitespace. Splitting them closes the gap where a spaced quoted secret was only partly redacted.
// The optional `["']?` right after the keyword matches a JSON key's closing quote (`"api_key":
// "value"` — the key is itself quoted, unlike the YAML/shell-style `api_key: value`/`api_key=value`
// this was originally written for), so plain JSON — the dominant config format under
// `~/.claude` — is covered too, not just unquoted-key assignment syntax.
// The opening quote may be backslash-escaped (`\\"value\\"`): session payloads are JSON.stringify'd
// before redaction, so a quoted shell assignment inside a tool input arrives with escaped quotes. A BARE value
// never starts with such a backslash-quote, so it cannot re-match what the QUOTED pass just redacted.
// A keyword may carry a `_value`/`_header` suffix (`CLIENT_SECRET_VALUE=`). `pass` and `pwd` count only inside a compound name (`DB_PASS`, `MYSQL_PWD`), so `bypass:` and `Tests pass:` are not secrets.
const KEYWORDS = String.raw`(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|(?<=[_-])(?:pass|pwd)|passphrase|credentials?|auth[_-]?header|access[_-]?key|private[_-]?key|auth[_-]?key|signing[_-]?key|encryption[_-]?key)(?:[_-]?(?:value|header))?`;
// A value can be `Bearer <token>`: take the scheme word with it, or the token pattern below never sees `Bearer`.
// Values that are settings, not secrets (`credentials: "include"` in a fetch call, `"token": null`).
const NOT_A_SECRET = String.raw`(?!(?:include|omit|same-origin|true|false|null)\b)`;
// A bare value is a scalar: `{` or `[` opens a JSON object or array (`"token":{...}`), which it must not swallow.
const NOT_A_STRUCTURE = String.raw`(?![{\[])`;
const SCHEME = String.raw`(?:(?:bearer|basic|token|digest|negotiate)[ \t]+)?`;
const ASSIGNMENT_QUOTED = new RegExp(String.raw`((?:${KEYWORDS})\b["']?\s*[:=]\s*)(\\?['"])${NOT_A_SECRET}[^'"]*\2`, 'gi');
const ASSIGNMENT_BARE = new RegExp(String.raw`((?:${KEYWORDS})\b["']?\s*[:=]\s*)${NOT_A_SECRET}${NOT_A_STRUCTURE}${SCHEME}(?:\\\\|\\(?!['"])|[^\s'"\\])+`, 'gi');
// Cookie and authorization headers. Redacting JSON-stringified text (one line, the header inside a string) must
// leave it parseable, so a value stops at a quote, backslash or line end. A JSON-keyed header (`"Cookie":"sid=1"`)
// is a value whatever it looks like; in plain text only a `name=value` cookie or a scheme-word authorization
// (or one long opaque token) counts, so `const cookie: string` and "the Authorization: header" are left alone.
const HEADER_JSON = /((?<![\w-])(?:(?:set-)?cookie|(?:proxy-)?authorization)\\?["']?\s*[:=]\s*\\?["'])[^"'\\]+/gi;
const HEADER_COOKIE = /((?<![\w-])(?:set-)?cookie[ \t]*:[ \t]*)[\w.%+-]{1,200}=[^\r\n"'\\`}]*/gi;
const HEADER_AUTH =
  /((?<![\w-])(?:proxy-)?authorization[ \t]*[:=][ \t]*)(?:(?:bearer|basic|token|digest|negotiate|apikey|ntlm|hmac|oauth)[ \t]+[^\r\n"'\\`}]+|[^\s"'\\`}]{16,})/gi;

// A secret given as a command-line flag with its value after a space (`--password hunter2`, `-u admin:s3cr3t`):
// no `:` or `=` joins them, so the assignment patterns above never see it. The value may be quoted, or
// backslash-quoted when the text was JSON-stringified; the quoted forms are bounded so an unclosed quote is cheap.
const CLI_SECRET_FLAG =
  /((?<![\w-])--?(?:(?:[a-z]{1,20}-){0,3}(?:password|passwd|token|secret|api-?key|auth(?:orization)?|access-?key|private-?key)(?:-(?:key|value))?|pass|pwd)(?:[ \t]{1,10}|=))(?:(?:bearer|basic|token|digest|negotiate)[ \t]+)?(?:\\["'][^\\]{0,500}\\["']|'[^']{0,500}'|"[^"]{0,500}"|[^\s'"\\]+)/gi;
// `curl -u user:pass`, also `--user`, a flag cluster (`-su`), a quoted credential and a `\`-newline continuation.
// The separator and the user name share no characters, so a long run of `=` cannot backtrack quadratically.
const CLI_BASIC_AUTH =
  /((?<![\w-])curl\b(?:[^\n]|\\\r?\n){0,500}?\s(?:--user|-[a-zA-Z]{0,5}u)(?:[ \t]{1,10}|=)\\?["']?)[^\s:='"\\]+:[^\s'"\\]+/g;

const REDACTED = '[REDACTED]';

/** Return `text` with recognised secrets replaced by `[REDACTED]`. Safe on empty input. */
export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let out = text
    .replace(ASSIGNMENT_QUOTED, `$1$2${REDACTED}$2`)
    .replace(ASSIGNMENT_BARE, `$1${REDACTED}`)
    .replace(HEADER_JSON, `$1${REDACTED}`)
    .replace(HEADER_COOKIE, `$1${REDACTED}`)
    .replace(HEADER_AUTH, `$1${REDACTED}`)
    .replace(CLI_SECRET_FLAG, `$1${REDACTED}`)
    .replace(CLI_BASIC_AUTH, `$1${REDACTED}`);
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (_match: string, scheme: unknown) => (typeof scheme === 'string' ?`${scheme}${REDACTED}@` : REDACTED));
  }
  return out;
}
