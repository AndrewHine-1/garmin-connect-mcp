// Recovery-metric registry — the Garmin half of the habit-correlation feature.
//
// Each metric knows how to fetch one scalar value for a given date and pull it
// out of Garmin's (sometimes deeply nested) JSON. Extractors are deliberately
// defensive: they probe a few candidate paths and unwrap single-element arrays,
// so they keep working if Garmin tweaks a field name. If a metric ever returns
// null for dates you know have data, the path list below is the thing to edit.

import type { GarminClient } from "./garmin-client.js";

export interface MetricDef {
  key: string;
  label: string;
  unit: string;
  /** true = a higher value means better recovery (readiness); false = lower is better (resting HR, stress). */
  higherIsBetter: boolean;
  /**
   * Days between when a habit happens and when this metric reflects it.
   * Garmin stamps overnight-recovery metrics (readiness, sleep, HRV, resting HR)
   * with the WAKE date, so a behavior on day D shows up in metric[D+1] — lag 1.
   * Same-day daytime metrics (stress) use lag 0.
   */
  lagDays: number;
  /** Fetch the raw JSON for one date. */
  fetch: (client: GarminClient, date: string) => Promise<unknown>;
  /** Pull the scalar value out of the raw JSON; null if unavailable. */
  extract: (raw: unknown) => number | null;
}

/** First finite number found by walking each dotted path; unwraps lead arrays. */
function pickNumber(raw: unknown, paths: string[]): number | null {
  let root = raw;
  if (Array.isArray(root)) root = root[0];
  if (root == null || typeof root !== "object") {
    return typeof raw === "number" && isFinite(raw) ? raw : null;
  }
  for (const path of paths) {
    let cur: unknown = root;
    let ok = true;
    for (const part of path.split(".")) {
      if (cur != null && typeof cur === "object" && part in cur) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === "number" && isFinite(cur)) return cur;
  }
  return null;
}

export const METRICS: Record<string, MetricDef> = {
  training_readiness: {
    key: "training_readiness",
    label: "Training Readiness",
    unit: "score (0-100)",
    higherIsBetter: true,
    lagDays: 1,
    fetch: (c, d) => c.get(`metrics-service/metrics/trainingreadiness/${d}`),
    extract: (raw) => pickNumber(raw, ["score", "trainingReadinessScore"]),
  },
  sleep_score: {
    key: "sleep_score",
    label: "Sleep Score",
    unit: "score (0-100)",
    higherIsBetter: true,
    lagDays: 1,
    fetch: (c, d) =>
      c.get("sleep-service/sleep/dailySleepData", {
        date: d,
        nonSleepBufferMinutes: 60,
      }),
    extract: (raw) =>
      pickNumber(raw, [
        "dailySleepDTO.sleepScores.overall.value",
        "sleepScores.overall.value",
      ]),
  },
  hrv: {
    key: "hrv",
    label: "HRV (overnight avg)",
    unit: "ms",
    higherIsBetter: true,
    lagDays: 1,
    fetch: (c, d) => c.get(`hrv-service/hrv/${d}`),
    extract: (raw) =>
      pickNumber(raw, [
        "hrvSummary.lastNightAvg",
        "hrvSummary.weeklyAvg",
        "lastNightAvg",
      ]),
  },
  resting_hr: {
    key: "resting_hr",
    label: "Resting Heart Rate",
    unit: "bpm",
    higherIsBetter: false,
    lagDays: 1,
    fetch: (c, d) =>
      c.get("wellness-service/wellness/dailyHeartRate", { date: d }),
    extract: (raw) =>
      pickNumber(raw, ["restingHeartRate", "restingHeartRateTimestamp.value"]),
  },
  stress_avg: {
    key: "stress_avg",
    label: "Average Stress",
    unit: "stress (0-100)",
    higherIsBetter: false,
    lagDays: 0,
    fetch: (c, d) => c.get(`wellness-service/wellness/dailyStress/${d}`),
    extract: (raw) => pickNumber(raw, ["avgStressLevel", "overallStressLevel"]),
  },
};

export const DEFAULT_METRIC = "training_readiness";

export function metricKeys(): string[] {
  return Object.keys(METRICS);
}

export function getMetric(key: string): MetricDef {
  const m = METRICS[key];
  if (!m) {
    throw new Error(
      `Unknown metric "${key}". Valid metrics: ${metricKeys().join(", ")}.`
    );
  }
  return m;
}

/** Calendar-day arithmetic on a YYYY-MM-DD string (UTC-anchored, whole days). */
export function shiftISODate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The set of dates to fetch a metric for, given the dates habits were logged.
 * Applies the metric's lag (e.g. a habit on D is matched to readiness on D+1),
 * de-duplicated. Pair this with analyzeHabit, which shifts by the same lag.
 */
export function metricFetchDates(
  metricKey: string,
  habitDates: string[]
): string[] {
  const lag = getMetric(metricKey).lagDays;
  const set = new Set(habitDates.map((d) => shiftISODate(d, lag)));
  return [...set].sort();
}

/**
 * Fetch one metric for each date, sequentially (the client shares a single
 * browser page, so concurrent requests would race). Returns date -> value|null.
 */
export async function fetchMetricSeries(
  client: GarminClient,
  metricKey: string,
  dates: string[]
): Promise<Map<string, number | null>> {
  const metric = getMetric(metricKey);
  const out = new Map<string, number | null>();
  for (const date of dates) {
    try {
      const raw = await metric.fetch(client, date);
      out.set(date, metric.extract(raw));
    } catch {
      // A failed/empty date just contributes no data point.
      out.set(date, null);
    }
  }
  return out;
}
