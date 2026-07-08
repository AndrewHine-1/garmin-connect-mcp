// Daily coaching — readiness-aware workout generation + intervals.icu export.
//
// The athlete picks which sport(s) they want to do today; we pull the morning's
// Garmin recovery stats (training readiness, sleep, HRV, resting HR), fold in
// the persistent training-block setting, and generate a session per sport in
// intervals.icu workout text (run targets as %LTHR, bike as %FTP, swim as
// distance steps, lifting as timed blocks). Export POSTs each workout to the
// intervals.icu calendar, where the text parses into structured steps.
//
// Settings (training block + intervals.icu credentials) persist in
// ~/.garmin-connect-mcp/coach-settings.json and are overwritten on each save.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSessionDir } from "./garmin-client.js";
import type { GarminClient } from "./garmin-client.js";
import { METRICS } from "./recovery-metrics.js";

// ── settings ────────────────────────────────────────────────────────────────

export type TrainingBlock = "base" | "build" | "peak" | "taper" | "recovery";
export const TRAINING_BLOCKS: TrainingBlock[] = [
  "base",
  "build",
  "peak",
  "taper",
  "recovery",
];

export interface CoachSettings {
  block: TrainingBlock;
  icuAthleteId: string;
  icuApiKey: string;
}

function settingsFile(): string {
  return join(getSessionDir(), "coach-settings.json");
}

export function loadCoachSettings(): CoachSettings {
  const file = settingsFile();
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf-8"));
      return {
        block: TRAINING_BLOCKS.includes(s.block) ? s.block : "base",
        icuAthleteId: s.icuAthleteId ?? "",
        icuApiKey: s.icuApiKey ?? "",
      };
    } catch {
      /* fall through to defaults */
    }
  }
  return { block: "base", icuAthleteId: "", icuApiKey: "" };
}

/** Merge-and-overwrite: only provided fields change, then the file is rewritten. */
export function saveCoachSettings(
  patch: Partial<CoachSettings>
): CoachSettings {
  const cur = loadCoachSettings();
  const next: CoachSettings = {
    block:
      patch.block && TRAINING_BLOCKS.includes(patch.block)
        ? patch.block
        : cur.block,
    icuAthleteId: patch.icuAthleteId ?? cur.icuAthleteId,
    icuApiKey: patch.icuApiKey ?? cur.icuApiKey,
  };
  mkdirSync(getSessionDir(), { recursive: true, mode: 0o700 });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// ── readiness ───────────────────────────────────────────────────────────────

export type ReadinessTier = "high" | "medium" | "low";

export interface ReadinessContext {
  tier: ReadinessTier;
  readiness: number | null;
  sleepScore: number | null;
  hrv: number | null;
  restingHr: number | null;
  summary: string;
}

/**
 * Pull the morning recovery stats for `date` and reduce them to a tier.
 * Training readiness drives it when present; otherwise fall back to sleep score.
 */
export async function assessReadiness(
  client: GarminClient,
  date: string
): Promise<ReadinessContext> {
  const grab = async (key: string): Promise<number | null> => {
    try {
      const def = METRICS[key];
      return def.extract(await def.fetch(client, date));
    } catch {
      return null;
    }
  };
  const readiness = await grab("training_readiness");
  const sleepScore = await grab("sleep_score");
  const hrv = await grab("hrv");
  const restingHr = await grab("resting_hr");

  const driver = readiness ?? sleepScore;
  let tier: ReadinessTier;
  if (driver == null) tier = "medium";
  else if (driver >= 67) tier = "high";
  else if (driver >= 34) tier = "medium";
  else tier = "low";

  const parts: string[] = [];
  if (readiness != null) parts.push(`Readiness ${readiness}`);
  if (sleepScore != null) parts.push(`Sleep ${sleepScore}`);
  if (hrv != null) parts.push(`HRV ${hrv}ms`);
  if (restingHr != null) parts.push(`RHR ${restingHr}bpm`);
  const stats = parts.length ? parts.join(" · ") : "No overnight data synced";
  const verdict =
    tier === "high"
      ? "primed for quality work"
      : tier === "medium"
        ? "steady work is the right call"
        : "recovery emphasis today";
  return {
    tier,
    readiness,
    sleepScore,
    hrv,
    restingHr,
    summary: `${stats} — ${verdict}`,
  };
}

// ── workout generation ──────────────────────────────────────────────────────

export type Sport =
  | "running"
  | "trail_running"
  | "biking"
  | "swimming"
  | "weightlifting";
export const SPORTS: Sport[] = [
  "running",
  "trail_running",
  "biking",
  "swimming",
  "weightlifting",
];

const SPORT_META: Record<Sport, { label: string; icuType: string }> = {
  running: { label: "Run", icuType: "Run" },
  trail_running: { label: "Trail Run", icuType: "TrailRun" },
  biking: { label: "Bike", icuType: "Ride" },
  swimming: { label: "Swim", icuType: "Swim" },
  weightlifting: { label: "Lift", icuType: "WeightTraining" },
};

export interface GeneratedWorkout {
  sport: Sport;
  icuType: string;
  name: string;
  durationMin: number;
  description: string; // intervals.icu workout text
  rationale: string;
}

// A workout is a list of blocks. A block is either a single named step line
// (e.g. "Warmup 15m 65-75% LTHR") or a repeat (rendered as "Name Nx" + `- child`
// lines). The set name is the ONLY text on a step besides the structured
// duration/target — no prose notes.
interface Rep {
  n: number;
  children: string[];
}
type Block = string | Rep;

interface Session {
  title: string;
  durationMin: number;
  blocks: Block[];
}

function rep(n: number, children: string[]): Rep {
  return { n, children };
}

// Build one step in the intervals.icu order the athlete confirmed works:
// "<duration|distance> [name] <zone> hr". Zone is "z1" or "z2-z4"; the HR zone
// is the actual target. "m" = minutes, meters are "mtr".
function step(dd: string, name: string, zone: string): string {
  const parts = [dd];
  if (name) parts.push(name);
  if (zone) parts.push(`${zone} hr`);
  return parts.join(" ");
}

function rest(dd: string): string {
  return `${dd} rest`;
}

// Render to intervals.icu workout-builder text: top-level steps take a leading
// "- "; repeats are a bare "Nx" header + "- child" lines. Every block is
// blank-line separated so repeats keep the required empty line before and after.
function renderWorkout(blocks: Block[]): string {
  return blocks
    .map((b) =>
      typeof b === "string"
        ? `- ${b}`
        : `${b.n}x\n${b.children.map((c) => `- ${c}`).join("\n")}`
    )
    .join("\n\n");
}

/** The tier each sport actually trains at, given day position + readiness. */
function effectiveTier(tier: ReadinessTier, slot: number): ReadinessTier {
  if (slot === 0) return tier;
  // Second/third sessions of the day step down one intensity level.
  return tier === "high" ? "medium" : "low";
}

function runSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Recovery Jog",
      durationMin: 35,
      blocks: [step("35m", "recovery jog", "z1")],
    };
  if (tier === "medium")
    return {
      title: "Aerobic Endurance + Strides",
      durationMin: 55,
      blocks: [
        step("10m", "warm up", "z1-z2"),
        step("35m", "endurance", "z2"),
        rep(4, [step("20s", "stride", "z4"), step("70s", "easy", "z1")]),
        step("4m", "cool down", "z1"),
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Tempo Run",
        durationMin: 60,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(2, [step("15m", "tempo", "z3"), step("5m", "float", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      };
    case "build":
      return {
        title: "Threshold Intervals",
        durationMin: 62,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(4, [step("8m", "hard", "z4"), step("3m", "easy", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      };
    case "peak":
      return {
        title: "VO2 Intervals",
        durationMin: 55,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(5, [step("4m", "hard", "z5"), step("3m", "easy", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      };
    case "taper":
      return {
        title: "Taper Openers",
        durationMin: 40,
        blocks: [
          step("12m", "warm up", "z1-z2"),
          rep(4, [step("90s", "quick", "z4-z5"), step("2m", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      };
    case "recovery":
      return {
        title: "Easy Aerobic Run",
        durationMin: 40,
        blocks: [step("40m", "easy run", "z1-z2")],
      };
  }
}

function trailSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Easy Trail Shakeout",
      durationMin: 40,
      blocks: [step("40m", "easy trail", "z1-z2")],
    };
  if (tier === "medium")
    return {
      title: "Rolling Trail Endurance",
      durationMin: 70,
      blocks: [
        step("10m", "warm up", "z1-z2"),
        step("55m", "rolling endurance", "z2"),
        step("5m", "cool down", "z1"),
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Hilly Steady State",
        durationMin: 75,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          step("50m", "hilly steady state", "z2-z3"),
          step("10m", "cool down", "z1"),
        ],
      };
    case "build":
      return {
        title: "Hill Repeats",
        durationMin: 65,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(7, [step("3m", "uphill", "z5"), step("3m", "down", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      };
    case "peak":
      return {
        title: "Rolling Surges",
        durationMin: 60,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(6, [step("45s", "surge", "z5"), step("4m15s", "steady", "z3")]),
          step("10m", "cool down", "z1"),
        ],
      };
    case "taper":
      return {
        title: "Short Trail + Pickups",
        durationMin: 40,
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(3, [step("60s", "pickup", "z4"), step("3m", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      };
    case "recovery":
      return {
        title: "Easy Trail Run",
        durationMin: 45,
        blocks: [step("45m", "easy trail run", "z1-z2")],
      };
  }
}

function bikeSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Recovery Spin",
      durationMin: 40,
      blocks: [step("40m", "recovery spin", "z1")],
    };
  if (tier === "medium")
    return {
      title: "Endurance + Tempo",
      durationMin: 75,
      blocks: [
        step("10m", "warm up", "z1"),
        rep(2, [step("20m", "tempo", "z2-z3"), step("5m", "easy", "z1")]),
        step("10m", "cool down", "z1"),
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Sweet Spot Intervals",
        durationMin: 80,
        blocks: [
          step("15m", "warm up", "z1"),
          rep(3, [step("12m", "sweet spot", "z3"), step("5m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      };
    case "build":
      return {
        title: "Threshold Intervals",
        durationMin: 78,
        blocks: [
          step("15m", "warm up", "z1"),
          rep(4, [step("8m", "threshold", "z4"), step("4m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      };
    case "peak":
      return {
        title: "VO2 Intervals",
        durationMin: 65,
        blocks: [
          step("15m", "warm up", "z1"),
          rep(5, [step("3m", "hard", "z5"), step("3m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      };
    case "taper":
      return {
        title: "Taper Openers",
        durationMin: 45,
        blocks: [
          step("15m", "warm up", "z1"),
          rep(3, [step("2m", "crisp", "z4"), step("4m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      };
    case "recovery":
      return {
        title: "Easy Endurance Spin",
        durationMin: 60,
        blocks: [step("60m", "easy spin", "z1-z2")],
      };
  }
}

function swimSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Technique Swim",
      durationMin: 35,
      blocks: [
        step("300mtr", "warm up", "z1"),
        rep(6, [step("50mtr", "drill", "z1"), rest("15s")]),
        step("400mtr", "smooth free", "z2"),
        step("100mtr", "cool down", "z1"),
      ],
    };
  if (tier === "medium")
    return {
      title: "Aerobic Endurance Swim",
      durationMin: 50,
      blocks: [
        step("300mtr", "warm up", "z1-z2"),
        rep(4, [step("50mtr", "build", "z2"), rest("15s")]),
        rep(4, [step("400mtr", "endurance", "z2-z3"), rest("30s")]),
        step("200mtr", "cool down", "z1"),
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Aerobic Intervals",
        durationMin: 55,
        blocks: [
          step("400mtr", "warm up", "z1-z2"),
          rep(4, [step("50mtr", "drill", "z1"), rest("15s")]),
          rep(10, [step("100mtr", "aerobic", "z3"), rest("15s")]),
          step("300mtr", "pull", "z2"),
          step("200mtr", "cool down", "z1"),
        ],
      };
    case "build":
      return {
        title: "Threshold 200s",
        durationMin: 60,
        blocks: [
          step("400mtr", "warm up", "z1-z2"),
          rep(4, [step("50mtr", "build", "z2"), rest("15s")]),
          rep(5, [step("200mtr", "threshold", "z4"), rest("20s")]),
          rep(4, [step("50mtr", "sprint", "z5"), rest("30s")]),
          step("200mtr", "cool down", "z1"),
        ],
      };
    case "peak":
      return {
        title: "Race-Pace 100s",
        durationMin: 50,
        blocks: [
          step("400mtr", "warm up", "z1-z2"),
          rep(6, [step("50mtr", "descend", "z2-z3"), rest("15s")]),
          rep(8, [step("100mtr", "race pace", "z4-z5"), rest("20s")]),
          step("200mtr", "cool down", "z1"),
        ],
      };
    case "taper":
      return {
        title: "Taper Tune-Up",
        durationMin: 35,
        blocks: [
          step("300mtr", "warm up", "z1-z2"),
          rep(6, [step("50mtr", "race pace", "z4"), rest("20s")]),
          step("200mtr", "smooth free", "z2"),
          step("100mtr", "cool down", "z1"),
        ],
      };
    case "recovery":
      return {
        title: "Easy Swim",
        durationMin: 35,
        blocks: [
          step("300mtr", "warm up", "z1-z2"),
          rep(6, [step("50mtr", "drill", "z1"), rest("15s")]),
          step("400mtr", "smooth free", "z2"),
          step("100mtr", "cool down", "z1"),
        ],
      };
  }
}

// Strength has no HR/power target, so each set is a named time block; the
// rep scheme lives in the name using "×" (not "x", which would trip the
// repeat parser).
function liftSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Mobility + Core",
      durationMin: 30,
      blocks: ["Mobility Flow 10m", "Core Circuit 15m", "Stretch 5m"],
    };
  if (tier === "medium")
    return {
      title: "Full-Body Strength",
      durationMin: 45,
      blocks: [
        "Warmup 10m",
        "Squat 3×8 12m",
        "Bench 3×8 10m",
        "Row 3×10 10m",
        "Core 8m",
        "Stretch 5m",
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Strength Endurance",
        durationMin: 50,
        blocks: [
          "Warmup 10m",
          "Goblet Squat 3×12 12m",
          "Romanian Deadlift 3×10 10m",
          "Push-Up + Row 3×12 10m",
          "Walking Lunge 3×10 8m",
          "Core + Stretch 10m",
        ],
      };
    case "build":
      return {
        title: "Max Strength",
        durationMin: 55,
        blocks: [
          "Warmup 12m",
          "Back Squat 4×5 15m",
          "Deadlift 3×5 12m",
          "Bench Press 4×5 10m",
          "Pull-Up + Hip Thrust 3×8 10m",
          "Stretch 6m",
        ],
      };
    case "peak":
      return {
        title: "Power",
        durationMin: 40,
        blocks: [
          "Warmup 12m",
          "Trap-Bar Jump 4×3 10m",
          "Push Press 4×3 10m",
          "Kettlebell Swing 4×8 8m",
          "Mobility 10m",
        ],
      };
    case "taper":
      return {
        title: "Maintenance",
        durationMin: 30,
        blocks: [
          "Warmup 8m",
          "Squat 2×5 8m",
          "Push 2×8 6m",
          "Pull 2×8 6m",
          "Stretch 2m",
        ],
      };
    case "recovery":
      return {
        title: "Mobility Session",
        durationMin: 30,
        blocks: ["Mobility Flow 15m", "Light Core 10m", "Breathing 5m"],
      };
  }
}

const GENERATORS: Record<
  Sport,
  (block: TrainingBlock, tier: ReadinessTier) => Session
> = {
  running: runSession,
  trail_running: trailSession,
  biking: bikeSession,
  swimming: swimSession,
  weightlifting: liftSession,
};

const TIER_WORD: Record<ReadinessTier, string> = {
  high: "quality",
  medium: "steady",
  low: "recovery",
};

/**
 * Generate one workout per requested sport. Selection order matters: the first
 * sport gets the readiness-driven session; later ones step down an intensity
 * level so the combined day stays absorbable.
 */
export function generateWorkouts(
  sports: Sport[],
  block: TrainingBlock,
  ctx: ReadinessContext
): GeneratedWorkout[] {
  return sports.map((sport, slot) => {
    const tier = effectiveTier(ctx.tier, slot);
    const s = GENERATORS[sport](block, tier);
    const meta = SPORT_META[sport];
    const slotNote =
      slot > 0
        ? ` Second session of the day — intensity stepped down to ${TIER_WORD[tier]}.`
        : "";
    const rationale = `${ctx.summary}. ${meta.label} set to ${TIER_WORD[tier]} for your ${block} block.${slotNote}`;
    // description is the pure intervals.icu workout text — no notes beyond set
    // names. The rationale is returned separately for the dashboard card only.
    const description = renderWorkout(s.blocks);
    return {
      sport,
      icuType: meta.icuType,
      name: `${meta.label} — ${s.title} (${cap(block)})`,
      durationMin: s.durationMin,
      description,
      rationale,
    };
  });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function parseSports(input: string): Sport[] {
  const wanted = input
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: Sport[] = [];
  for (const w of wanted) {
    const match = SPORTS.find(
      (sp) =>
        sp === w ||
        sp.replace("_", "") === w.replace(/[_-]/g, "") ||
        SPORT_META[sp].label.toLowerCase() === w
    );
    if (!match) {
      throw new Error(`Unknown sport "${w}". Valid: ${SPORTS.join(", ")}.`);
    }
    if (!out.includes(match)) out.push(match);
  }
  if (out.length === 0) throw new Error("No sports selected.");
  return out;
}

// ── intervals.icu export ────────────────────────────────────────────────────

export interface IcuPushResult {
  sport: Sport;
  name: string;
  eventId: number | null;
  parsedSteps: number;
  ok: boolean;
  error?: string;
}

/** POST one workout to the intervals.icu calendar for `date` (YYYY-MM-DD). */
export async function pushWorkoutToIcu(
  settings: CoachSettings,
  date: string,
  w: GeneratedWorkout
): Promise<IcuPushResult> {
  if (!settings.icuAthleteId || !settings.icuApiKey) {
    throw new Error(
      "intervals.icu is not configured. Save your athlete ID and API key in coach settings first."
    );
  }
  const auth =
    "Basic " + Buffer.from(`API_KEY:${settings.icuApiKey}`).toString("base64");
  const resp = await fetch(
    `https://intervals.icu/api/v1/athlete/${settings.icuAthleteId}/events`,
    {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "WORKOUT",
        type: w.icuType,
        name: w.name,
        start_date_local: `${date}T00:00:00`,
        description: w.description,
      }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      sport: w.sport,
      name: w.name,
      eventId: null,
      parsedSteps: 0,
      ok: false,
      error: `intervals.icu ${resp.status}: ${text.slice(0, 200)}`,
    };
  }
  const ev = (await resp.json()) as {
    id?: number;
    workout_doc?: { steps?: unknown[] };
  };
  return {
    sport: w.sport,
    name: w.name,
    eventId: ev.id ?? null,
    parsedSteps: ev.workout_doc?.steps?.length ?? 0,
    ok: true,
  };
}
