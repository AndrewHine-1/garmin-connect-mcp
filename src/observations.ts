// Aligned observations — the one place the habit feature's date-keying contract
// lives.
//
// A habit is logged on a behavior-day D. Its confounders (alcohol, weekend,
// training load) are read at D too, but the recovery metric it drives is stamped
// by Garmin at D+lag (overnight metrics wake-date to D+1; same-day stress at D).
// Joining those correctly used to be reconstructed inside the estimator; it now
// happens here, once, so a keying mistake surfaces in one module with tests
// rather than as silently-dropped days.
//
// Pure: callers pass in the fetched maps; nothing here touches Garmin or disk.

import { DatedValue, HabitValue } from "./journal.js";
import { shiftISODate } from "./recovery-metrics.js";

/** One behavior-day joined to its confounders (at D) and its outcome (at D+lag). */
export interface Observation {
  habit: number;
  alcohol: number;
  weekend: number;
  load: number;
  y: number;
}

/** boolean -> 0/1, numeric -> itself. Turns a logged value into a regressor. */
export function toNum(v: HabitValue): number {
  return typeof v === "number" ? v : v ? 1 : 0;
}

/** 1 if the ISO date is a Saturday or Sunday, else 0 (UTC-anchored). */
export function isWeekend(date: string): number {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6 ? 1 : 0;
}

/** The outcome metric to join: its series keyed by D+lag, and that lag. */
export interface OutcomeSource {
  series: Map<string, number | null>;
  lag: number;
}

/** The confounder values, keyed by behavior-day D. */
export interface ConfounderSources {
  /**
   * Alcohol drinks by behavior-day. Supply ONLY when adjusting for alcohol:
   * when present, a day missing an alcohol value is dropped; when omitted, every
   * observation's `alcohol` is 0 and no day is dropped on its account.
   */
  alcohol?: Map<string, number>;
  /** Summed training load by behavior-day; a missing day is a rest day (0). */
  load: Map<string, number>;
}

/**
 * Join each behavior-day to its outcome and confounders under one keying rule.
 *
 * Listwise-deletion contract (kept explicit, in one place):
 *   - outcome y at D+lag is REQUIRED — a day missing it is dropped;
 *   - alcohol at D is REQUIRED only when `conf.alcohol` is supplied;
 *   - load at D defaults to 0 (rest day) and never drops a day;
 *   - weekend is derived from D and is always present.
 */
export function alignObservations(
  days: DatedValue[],
  outcome: OutcomeSource,
  conf: ConfounderSources
): Observation[] {
  const rows: Observation[] = [];
  for (const { date, value } of days) {
    const y = outcome.series.get(shiftISODate(date, outcome.lag));
    if (y == null) continue; // outcome required

    let alcohol = 0;
    if (conf.alcohol) {
      const a = conf.alcohol.get(date);
      if (a == null) continue; // alcohol required when adjusting for it
      alcohol = a;
    }

    rows.push({
      habit: toNum(value),
      alcohol,
      weekend: isWeekend(date),
      load: conf.load.get(date) ?? 0,
      y,
    });
  }
  return rows;
}
