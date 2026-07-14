import { CliError } from './errors.js';

/**
 * Parse a user-supplied point in time for --since/--until style flags.
 *
 * Accepted forms:
 * - `Nh` / `Nd` / `Nw` — N hours/days/weeks before `now` (e.g. `7d`).
 * - `YYYY-MM-DD` — a local calendar day; `boundary` picks its start (00:00:00.000)
 *   or end (23:59:59.999) so `--until 2026-06-30` includes the whole day.
 * - anything `new Date()` accepts, e.g. a full ISO datetime.
 *
 * `now` is injected rather than read from the clock so callers share one reference
 * instant per run and tests are deterministic.
 */
export function parseWhen(input: string, opts: { now: Date; boundary: 'start' | 'end' }): Date {
  const trimmed = input.trim();

  const duration = trimmed.match(/^(\d+)([hdw])$/);
  if (duration) {
    const count = Number(duration[1]);
    const unitMs = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2] as 'h' | 'd' | 'w'];
    return new Date(opts.now.getTime() - count * unitMs);
  }

  const day = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const [, year, month, dayOfMonth] = day;
    // Construct via local components (not the ISO string, which Date parses as UTC)
    // so the day boundary matches the user's timezone.
    const parsed =
      opts.boundary === 'start'
        ? new Date(Number(year), Number(month) - 1, Number(dayOfMonth), 0, 0, 0, 0)
        : new Date(Number(year), Number(month) - 1, Number(dayOfMonth), 23, 59, 59, 999);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  if (trimmed) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  throw new CliError(
    'INVALID_ARGS',
    `Invalid date "${input}". Use YYYY-MM-DD, an ISO datetime, or a duration like 12h, 7d, 2w.`
  );
}
