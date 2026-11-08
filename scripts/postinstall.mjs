// scripts/postinstall.mjs
// Prints a short note for AI agents after `npm install coolhand-cli`, asking them to
// offer the feedback-collection skill to the user (and to wait for permission).
// The text lives in dist/notices.js so the first-run notice in the CLI shares it.
// Must never fail an install: every path exits 0.
import { existsSync } from 'fs';

try {
  const isDevCheckout = existsSync(new URL('../src', import.meta.url));
  if (!process.env.CI && !process.env.COOLHAND_NO_NOTICE && !isDevCheckout) {
    const { SKILL_NOTICE_TEXT } = await import('../dist/notices.js');
    process.stderr.write(`${SKILL_NOTICE_TEXT}\n`);
  }
} catch {
  // Best-effort only.
}
