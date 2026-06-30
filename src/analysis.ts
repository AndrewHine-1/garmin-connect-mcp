// Joins a habit's daily log with a recovery-metric series and produces a
// Whoop-style insight: "on days you did X, your <metric> was Y% better/worse
// (confidence: high/medium/low)".

import { Habit, HabitType, JournalData, habitSeries } from "./journal.js";
import {
  compareGroups,
  correlate,
  GroupComparison,
  Correlation,
} from "./stats.js";
import { MetricDef, shiftISODate } from "./recovery-metrics.js";

export interface HabitAnalysis {
  habitId: string;
  habitName: string;
  type: HabitType;
  metricKey: string;
  metricLabel: string;
  daysAnalyzed: number;
  group?: GroupComparison; // boolean habits
  correlation?: Correlation; // numeric habits
  /** -1 worse recovery, 0 negligible/unknown, +1 better recovery. */
  recoveryDirection: number;
  note?: string; // populated when there isn't enough data
}

function round(x: number, dp = 1): number {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

/** Format a p-value, collapsing very small values to "<0.001". */
function fmtP(p: number): string {
  if (!isFinite(p) || isNaN(p)) return "n/a";
  if (p < 0.001) return "<0.001";
  return String(round(p, 3));
}

export function analyzeHabit(
  data: JournalData,
  habit: Habit,
  metric: MetricDef,
  metricSeries: Map<string, number | null>,
  startDate: string,
  endDate: string
): HabitAnalysis {
  const base: HabitAnalysis = {
    habitId: habit.id,
    habitName: habit.name,
    type: habit.type,
    metricKey: metric.key,
    metricLabel: metric.label,
    daysAnalyzed: 0,
    recoveryDirection: 0,
  };

  const series = habitSeries(data, habit.id, startDate, endDate);
  // Pair each logged habit-day D with the metric that reflects it. Overnight
  // metrics land on D+lag (Garmin's wake-date stamping), so look up the shifted
  // date. Days with no metric data are dropped.
  const paired: { value: boolean | number; metric: number }[] = [];
  for (const { date, value } of series) {
    const m = metricSeries.get(shiftISODate(date, metric.lagDays));
    if (m == null) continue;
    paired.push({ value, metric: m });
  }
  base.daysAnalyzed = paired.length;

  if (habit.type === "boolean") {
    const withHabit = paired
      .filter((p) => p.value === true)
      .map((p) => p.metric);
    const without = paired
      .filter((p) => p.value === false)
      .map((p) => p.metric);
    const cmp = compareGroups(withHabit, without);
    if (!cmp) {
      base.note = `Not enough data: need at least 2 "yes" days and 2 "no" days with ${metric.label} (have ${withHabit.length} yes / ${without.length} no).`;
      return base;
    }
    base.group = cmp;
    // Translate the raw metric delta into a recovery direction.
    const better = metric.higherIsBetter ? cmp.delta : -cmp.delta;
    base.recoveryDirection =
      cmp.confidence === "inconclusive" ? 0 : Math.sign(better);
    return base;
  }

  // numeric
  const xs = paired.map((p) => p.value as number);
  const ys = paired.map((p) => p.metric);
  const corr = correlate(xs, ys);
  if (!corr) {
    base.note = `Not enough data: need at least 3 logged days (with ${metric.label}) and some variation in the habit value (have ${paired.length}).`;
    return base;
  }
  base.correlation = corr;
  const recoveryR = metric.higherIsBetter ? corr.r : -corr.r;
  base.recoveryDirection =
    corr.confidence === "inconclusive" ? 0 : Math.sign(recoveryR);
  return base;
}

/** Detailed multi-line report for a single habit. */
export function formatDetailed(a: HabitAnalysis, metric: MetricDef): string {
  const lines: string[] = [];
  lines.push(`# ${a.habitName} → ${a.metricLabel}`);
  lines.push("");
  lines.push(`Days analyzed: ${a.daysAnalyzed}`);
  if (a.note) {
    lines.push("");
    lines.push(`⚠️  ${a.note}`);
    return lines.join("\n");
  }

  if (a.group) {
    const g = a.group;
    const dirWord =
      a.recoveryDirection > 0
        ? "BETTER"
        : a.recoveryDirection < 0
          ? "WORSE"
          : "no clear effect on";
    const pctOfMetric =
      isFinite(g.percentChange) && g.meanWithout !== 0
        ? `${g.percentChange >= 0 ? "+" : ""}${round(g.percentChange)}%`
        : "n/a";
    lines.push("");
    lines.push(
      `On days you did **${a.habitName}**, your ${metric.label} was **${dirWord}**.`
    );
    lines.push("");
    lines.push(
      `- With habit:    ${round(g.meanWith)} ${metric.unit}  (n=${g.nWith})`
    );
    lines.push(
      `- Without habit: ${round(g.meanWithout)} ${metric.unit}  (n=${g.nWithout})`
    );
    lines.push(
      `- Difference:    ${g.delta >= 0 ? "+" : ""}${round(g.delta)} ${metric.unit}  (${pctOfMetric} vs. without)`
    );
    lines.push(
      `- Confidence:    ${g.confidence}  (p=${fmtP(g.pValue)}, Cohen's d=${round(g.cohensD, 2)})`
    );
    lines.push("");
    lines.push(confidenceCaveat(g.confidence, metric.higherIsBetter));
    return lines.join("\n");
  }

  if (a.correlation) {
    const c = a.correlation;
    const strength = correlationStrength(c.r);
    const dirWord =
      a.recoveryDirection > 0
        ? "BETTER recovery"
        : a.recoveryDirection < 0
          ? "WORSE recovery"
          : "no clear effect";
    lines.push("");
    lines.push(`More **${a.habitName}** is associated with **${dirWord}**.`);
    lines.push("");
    lines.push(`- Pearson r:  ${round(c.r, 2)} (${strength})`);
    lines.push(
      `- Confidence: ${c.confidence}  (p=${fmtP(c.pValue)}, n=${c.n})`
    );
    lines.push("");
    lines.push(confidenceCaveat(c.confidence, metric.higherIsBetter));
    return lines.join("\n");
  }

  return lines.join("\n");
}

/** One-line summary used in the all-habits overview table. */
export function formatRow(a: HabitAnalysis): string {
  if (a.note) {
    return `| ${a.habitName} | ${a.daysAnalyzed} | — | — | not enough data |`;
  }
  if (a.group) {
    const g = a.group;
    const effect =
      a.recoveryDirection > 0
        ? "↑ better"
        : a.recoveryDirection < 0
          ? "↓ worse"
          : "~ none";
    const pct =
      isFinite(g.percentChange) && g.meanWithout !== 0
        ? `${g.percentChange >= 0 ? "+" : ""}${round(g.percentChange)}%`
        : `${g.delta >= 0 ? "+" : ""}${round(g.delta)}`;
    return `| ${a.habitName} | ${a.daysAnalyzed} | ${effect} | ${pct} | ${g.confidence} |`;
  }
  if (a.correlation) {
    const c = a.correlation;
    const effect =
      a.recoveryDirection > 0
        ? "↑ better"
        : a.recoveryDirection < 0
          ? "↓ worse"
          : "~ none";
    return `| ${a.habitName} | ${a.daysAnalyzed} | ${effect} | r=${round(c.r, 2)} | ${c.confidence} |`;
  }
  return `| ${a.habitName} | ${a.daysAnalyzed} | — | — | — |`;
}

function correlationStrength(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.5) return "strong";
  if (a >= 0.3) return "moderate";
  if (a >= 0.1) return "weak";
  return "negligible";
}

function confidenceCaveat(
  confidence: string,
  _higherIsBetter: boolean
): string {
  if (confidence === "high")
    return "This is a statistically strong signal, but correlation isn't causation — keep logging to confirm.";
  if (confidence === "medium")
    return "Suggestive but not conclusive. More logged days will sharpen this.";
  if (confidence === "low")
    return "Weak signal — treat as a hint only. Needs more data.";
  return "No reliable signal yet. Log more days (especially both with- and without-habit days).";
}
