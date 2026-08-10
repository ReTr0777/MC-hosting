/**
 * Small 5-field cron evaluator: minute hour day-of-month month day-of-week.
 *
 * Supports a bare star, star-slash-step, `a-b`, `a-b/step`, and comma-separated lists
 * of those (the literal forms are avoided here because a star-slash would end this comment).
 * Day-of-week accepts 0 or 7 for Sunday. That covers every expression the schedule
 * editor can produce; anything it cannot parse is reported rather than silently
 * never matching, which is how the previous implementation failed.
 */

export interface CronParts {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
}

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

function parseField(field: string, min: number, max: number, isWeekday: boolean): Set<number> {
  const out = new Set<number>();

  for (const chunk of field.split(',')) {
    const piece = chunk.trim();
    if (!piece) throw new Error(`Empty value in "${field}"`);

    const [rangePart, stepPart] = piece.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step "/${stepPart}" in "${field}"`);
    }

    let from: number;
    let to: number;

    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => Number(n));
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Invalid range "${rangePart}" in "${field}"`);
      }
      from = a;
      to = b;
    } else {
      const value = Number(rangePart);
      if (!Number.isInteger(value)) throw new Error(`Invalid value "${rangePart}" in "${field}"`);
      from = value;
      to = value;
    }

    for (let v = from; v <= to; v += step) {
      // Cron allows 7 for Sunday alongside 0
      const normalized = isWeekday && v === 7 ? 0 : v;
      if (normalized < min || normalized > max) {
        throw new Error(`Value ${v} is outside ${min}-${max} in "${field}"`);
      }
      out.add(normalized);
    }
  }

  if (out.size === 0) throw new Error(`"${field}" matches nothing`);
  return out;
}

export function parseCron(expression: string): CronParts {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Expected 5 cron fields, got ${fields.length} in "${expression}"`);
  }

  const [minute, hour, day, month, weekday] = fields.map((f, i) =>
    parseField(f, RANGES[i][0], RANGES[i][1], i === 4)
  );

  return { minute, hour, day, month, weekday };
}

/** True when `date` falls on a minute the expression selects. */
export function cronMatches(parts: CronParts, date: Date): boolean {
  if (!parts.minute.has(date.getMinutes())) return false;
  if (!parts.hour.has(date.getHours())) return false;
  if (!parts.month.has(date.getMonth() + 1)) return false;

  // Standard cron quirk: when both day-of-month and day-of-week are restricted,
  // a match on *either* counts. Only when one is unrestricted does the other rule alone.
  const dayRestricted = parts.day.size < 31;
  const weekdayRestricted = parts.weekday.size < 7;
  const dayHit = parts.day.has(date.getDate());
  const weekdayHit = parts.weekday.has(date.getDay());

  if (dayRestricted && weekdayRestricted) return dayHit || weekdayHit;
  if (dayRestricted) return dayHit;
  if (weekdayRestricted) return weekdayHit;
  return true;
}

/** Scans forward a minute at a time. Returns null if nothing matches within a year. */
export function nextRun(expression: string, after: Date = new Date()): Date | null {
  let parts: CronParts;
  try {
    parts = parseCron(expression);
  } catch {
    return null;
  }

  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // 366 days of minutes — enough for any 5-field expression that matches at all
  for (let i = 0; i < 527_040; i++) {
    if (cronMatches(parts, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** Validation helper for the schedule editor — returns null when the expression is fine. */
export function cronError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err: any) {
    return err.message;
  }
}

/**
 * Whether a schedule is due now.
 *
 * The monitor loop runs more often than once a minute, so a schedule could otherwise
 * fire several times inside its matching minute. `lastRunAt` within the last 55 seconds
 * suppresses the repeat.
 */
export function isDue(expression: string, lastRunAt: Date | null, now: Date = new Date()): boolean {
  let parts: CronParts;
  try {
    parts = parseCron(expression);
  } catch {
    return false;
  }

  if (lastRunAt && now.getTime() - new Date(lastRunAt).getTime() < 55_000) return false;
  return cronMatches(parts, now);
}
