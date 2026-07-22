// Confounder-adjusted habit analysis — the analytical core of the Whoop-style
// "what's moving my recovery" feature.
//
// For each habit × each of three outcomes (training readiness, sleep score,
// average stress) we fit an ordinary-least-squares model
//
//     outcome ~ habit + alcohol + weekend + dailyLoad
//
// and report the habit's ISOLATED effect (its own coefficient, holding the
// confounders fixed) as a signed percentage of the outcome's mean, together
// with a confidence tier. "+ = better" for all three outcomes (stress, where
// lower is better, is sign-flipped). This replaces the old univariate
// t-test/correlation, which couldn't separate a habit's effect from the effect
// of, say, drinking or a hard training day on the same date.
//
// The estimator and matrix builder are pure (no I/O): callers fetch the metric
// series and the daily-load map and pass them in. `fetchAdjustedInputs` is the
// one impure helper — the shared orchestration that pulls both from Garmin ONCE
// over the window so per-habit estimation is a pure fold over cached data.

import type { GarminClient } from "./garmin-client.js";
import {
  Habit,
  HabitType,
  HabitValue,
  JournalData,
  habitSeries,
} from "./journal.js";
import { mean, stddev, variance, confidenceLabel } from "./stats.js";
import { multipleRegression } from "./stats.js";
import {
  MetricDef,
  getMetric,
  shiftISODate,
  fetchMetricSeries,
  metricFetchDates,
} from "./recovery-metrics.js";
import { fetchDailyTrainingLoad } from "./confounders.js";

/** Journal id of the alcohol habit, which doubles as a universal confounder. */
const ALCOHOL_HABIT_ID = "alcohol_drinks";

/** Minimum usable behavior-days before any estimate is emitted. */
const MIN_USABLE_DAYS = 12;
/** A boolean habit needs at least this many days in EACH of yes / no. */
const MIN_GROUP = 5;
/** "Enough data" target used to phrase the "~N more days" nudges. */
const TARGET_DAYS = 40;

export type Tier = "ok" | "weak" | "none";
export type Confidence = "high" | "medium" | "low" | "inconclusive";

/** One habit × one outcome result. `percent` is omitted for tier "none". */
export interface OutcomeCell {
  tier: Tier;
  /** Signed percent effect on the outcome; + = better. Present for ok/weak. */
  percent?: number;
  /** Confidence label from the habit coefficient's p-value. Present for ok/weak. */
  confidence?: Confidence;
  /** Human explanation. Present for weak/none. */
  reason?: string;
  /** For numeric habits: SD of the habit over usable days (rounded); the
   *  reported percent is the effect of a +1 SD change. */
  sd?: number;
}

/** The habit's effect across all three outcomes. */
export interface HabitMatrixRow {
  habitId: string;
  habitName: string;
  type: HabitType;
  cells: {
    recovery: OutcomeCell; // training_readiness
    sleep: OutcomeCell; // sleep_score
    stress: OutcomeCell; // stress_avg
  };
}

/** The three outcomes, in display order, mapping metric key -> cell key. */
export const ADJUSTED_OUTCOMES = [
  { metricKey: "training_readiness", cellKey: "recovery" },
  { metricKey: "sleep_score", cellKey: "sleep" },
  { metricKey: "stress_avg", cellKey: "stress" },
] as const;

export type OutcomeCellKey = (typeof ADJUSTED_OUTCOMES)[number]["cellKey"];

/** Serializable metadata for one outcome column (label/unit for the UI). */
export interface OutcomeMeta {
  metricKey: string;
  cellKey: OutcomeCellKey;
  label: string;
  unit: string;
  higherIsBetter: boolean;
}

export function outcomeMeta(): OutcomeMeta[] {
  return ADJUSTED_OUTCOMES.map(({ metricKey, cellKey }) => {
    const m = getMetric(metricKey);
    return {
      metricKey,
      cellKey,
      label: m.label,
      unit: m.unit,
      higherIsBetter: m.higherIsBetter,
    };
  });
}

function round(x: number, dp = 1): number {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

/** boolean -> 0/1, numeric -> itself. */
function toNum(v: HabitValue): number {
  return typeof v === "number" ? v : v ? 1 : 0;
}

/** 1 if the ISO date is a Saturday or Sunday, else 0 (UTC-anchored). */
function isWeekend(date: string): number {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return day === 0 || day === 6 ? 1 : 0;
}

interface UsableRow {
  habit: number;
  alcohol: number;
  weekend: number;
  load: number;
  y: number;
}

/**
 * Fit `outcome ~ habit + alcohol + weekend + dailyLoad` for one habit and one
 * outcome and return the tiered, confounder-adjusted cell. Pure; the metric
 * series and load map are supplied by the caller.
 *
 * @param metricSeries date -> outcome value (already lag-shifted keys, i.e.
 *   keyed by D+lag), null where Garmin had no data.
 * @param loadMap date -> summed daily training load; absent means a rest day (0).
 */
export function estimateOutcome(
  data: JournalData,
  habit: Habit,
  metric: MetricDef,
  metricSeries: Map<string, number | null>,
  loadMap: Map<string, number>,
  startDate: string,
  endDate: string
): OutcomeCell {
  const isAlcohol = habit.id === ALCOHOL_HABIT_ID;
  // Only adjust for alcohol when it's actually logged AND isn't the habit under
  // test (a confounder is dropped from its own model). A journal with no alcohol
  // habit still gets estimates — it just omits that covariate.
  const useAlcohol =
    !isAlcohol && data.habits.some((h) => h.id === ALCOHOL_HABIT_ID);

  // Listwise deletion: keep a day only if habit and outcome (at D+lag) are
  // present — plus alcohol when we're adjusting for it. Load is 0 when absent;
  // weekend is always known.
  const rows: UsableRow[] = [];
  for (const { date, value } of habitSeries(
    data,
    habit.id,
    startDate,
    endDate
  )) {
    const y = metricSeries.get(shiftISODate(date, metric.lagDays));
    if (y == null) continue;
    let alcohol = 0;
    if (useAlcohol) {
      const alcRaw = data.entries[date]?.[ALCOHOL_HABIT_ID];
      if (alcRaw == null) continue;
      alcohol = toNum(alcRaw);
    }
    rows.push({
      habit: toNum(value),
      alcohol,
      weekend: isWeekend(date),
      load: loadMap.get(date) ?? 0,
      y,
    });
  }

  const n = rows.length;
  const habitVals = rows.map((r) => r.habit);

  // ── tier "none" gates ───────────────────────────────────────────────
  if (n < MIN_USABLE_DAYS) {
    return { tier: "none", reason: `need ~${MIN_USABLE_DAYS - n} more days` };
  }
  if (habit.type === "numeric" && variance(habitVals) === 0) {
    return { tier: "none", reason: "no variation yet" };
  }
  if (habit.type === "boolean") {
    const yes = habitVals.filter((v) => v === 1).length;
    const no = n - yes;
    if (yes === 0 || no === 0) {
      return { tier: "none", reason: "no variation yet" };
    }
    if (yes < MIN_GROUP) {
      return { tier: "none", reason: `need >=${MIN_GROUP} yes-days` };
    }
    if (no < MIN_GROUP) {
      return { tier: "none", reason: `need >=${MIN_GROUP} no-days` };
    }
  }

  // ── build the design matrix (predictors, no intercept) ───────────────
  // Habit is column 0 and is guaranteed non-constant by the gates above, so it
  // survives the constant-column drop and stays first — its coefficient is
  // therefore coefficients[1] (intercept is coefficients[0]).
  const columns: { name: string; vals: number[] }[] = [
    { name: "habit", vals: habitVals },
  ];
  if (useAlcohol) {
    columns.push({ name: "alcohol", vals: rows.map((r) => r.alcohol) });
  }
  columns.push({ name: "weekend", vals: rows.map((r) => r.weekend) });
  columns.push({ name: "load", vals: rows.map((r) => r.load) });
  const kept = columns.filter((c) => variance(c.vals) > 0);

  const X = rows.map((_, i) => kept.map((c) => c.vals[i]));
  const y = rows.map((r) => r.y);
  const reg = multipleRegression(X, y);
  if (!reg) {
    return { tier: "none", reason: "not enough data" };
  }

  // Habit coefficient: intercept is [0], habit is the first predictor -> [1].
  const habitCoef = reg.coefficients[1];
  const meanOutcome = mean(y);
  if (!habitCoef || meanOutcome === 0) {
    return { tier: "none", reason: "not enough data" };
  }

  const beta = habitCoef.coefficient;
  const sd = habit.type === "numeric" ? stddev(habitVals) : undefined;
  const effect = habit.type === "numeric" ? beta * (sd ?? 0) : beta;
  let percent = (100 * effect) / meanOutcome;
  if (!isFinite(percent)) {
    return { tier: "none", reason: "not enough data" };
  }
  // Sign convention: + = better recovery. Stress is "lower is better", so flip.
  if (!metric.higherIsBetter) percent = -percent;

  const confidence = confidenceLabel(habitCoef.pValue) as Confidence;
  const cell: OutcomeCell = { tier: "ok", percent: round(percent) };
  if (sd !== undefined) cell.sd = round(sd);

  if (confidence === "high" || confidence === "medium") {
    cell.confidence = confidence;
    cell.tier = "ok";
  } else {
    cell.confidence = confidence;
    cell.tier = "weak";
    const more = TARGET_DAYS - n;
    cell.reason =
      more > 0
        ? `low confidence · ~${more} more days`
        : "low confidence · signal still too weak to call";
  }
  return cell;
}

/** Compute the full three-outcome row for a single habit. */
export function analyzeHabitRow(
  data: JournalData,
  habit: Habit,
  seriesByOutcome: Record<string, Map<string, number | null>>,
  loadMap: Map<string, number>,
  startDate: string,
  endDate: string
): HabitMatrixRow {
  const cell = (metricKey: string): OutcomeCell =>
    estimateOutcome(
      data,
      habit,
      getMetric(metricKey),
      seriesByOutcome[metricKey] ?? new Map(),
      loadMap,
      startDate,
      endDate
    );

  return {
    habitId: habit.id,
    habitName: habit.name,
    type: habit.type,
    cells: {
      recovery: cell("training_readiness"),
      sleep: cell("sleep_score"),
      stress: cell("stress_avg"),
    },
  };
}

/** The fetched, cached inputs the adjusted estimator needs. */
export interface AdjustedInputs {
  loadMap: Map<string, number>;
  seriesByOutcome: Record<string, Map<string, number | null>>;
}

/**
 * Fetch — ONCE over the window — everything the adjusted matrix needs: the daily
 * training-load map and each outcome's metric series (over the union of dates
 * implied by `behaviorDates` and each outcome's lag). Impure; the rest of this
 * module is pure over the result.
 */
export async function fetchAdjustedInputs(
  client: GarminClient,
  behaviorDates: string[],
  startDate: string,
  endDate: string
): Promise<AdjustedInputs> {
  const loadDates: string[] = [];
  for (let d = startDate; d <= endDate; d = shiftISODate(d, 1)) {
    loadDates.push(d);
  }
  const loadMap = await fetchDailyTrainingLoad(client, loadDates);
  const seriesByOutcome: Record<string, Map<string, number | null>> = {};
  for (const { metricKey } of ADJUSTED_OUTCOMES) {
    seriesByOutcome[metricKey] = await fetchMetricSeries(
      client,
      metricKey,
      metricFetchDates(metricKey, behaviorDates)
    );
  }
  return { loadMap, seriesByOutcome };
}

/** Compute the adjusted matrix over every habit. */
export function buildHabitMatrix(
  data: JournalData,
  habits: Habit[],
  seriesByOutcome: Record<string, Map<string, number | null>>,
  loadMap: Map<string, number>,
  startDate: string,
  endDate: string
): HabitMatrixRow[] {
  return habits.map((h) =>
    analyzeHabitRow(data, h, seriesByOutcome, loadMap, startDate, endDate)
  );
}
