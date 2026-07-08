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
  name: string;
  n: number;
  children: string[];
}
type Block = string | Rep;

interface Session {
  title: string;
  durationMin: number;
  blocks: Block[];
}

function rep(name: string, n: number, children: string[]): Rep {
  return { name, n, children };
}

// intervals.icu syntax (per the official quick guide):
//  - a step is "[name] duration|distance [target] [cadence]"; text before the
//    first duration is the step's name/cue.
//  - repeats are "Name Nx" then "- child" lines, with one empty line before AND
//    after the block. Joining every block with a blank line guarantees that.
//  - "m" means minutes; meters must be written "mtr".
function renderWorkout(blocks: Block[]): string {
  return blocks
    .map((b) =>
      typeof b === "string"
        ? `- ${b}` // top-level steps need the leading dash to parse
        : `${b.name} ${b.n}x\n${b.children.map((c) => `- ${c}`).join("\n")}`
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
      blocks: ["Recovery Jog 35m 60-70% LTHR"],
    };
  if (tier === "medium")
    return {
      title: "Aerobic Endurance + Strides",
      durationMin: 55,
      blocks: [
        "Warmup 10m 65-72% LTHR",
        "Endurance 35m 72-80% LTHR",
        rep("Strides", 4, ["Stride 20s 95% LTHR", "Easy 70s 60-68% LTHR"]),
        "Cooldown 4m 60-68% LTHR",
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Tempo Run",
        durationMin: 60,
        blocks: [
          "Warmup 15m 62-75% LTHR",
          rep("Tempo", 2, ["Tempo 15m 88-93% LTHR", "Float 5m 65% LTHR"]),
          "Cooldown 5m 60-68% LTHR",
        ],
      };
    case "build":
      return {
        title: "Threshold Intervals",
        durationMin: 62,
        blocks: [
          "Warmup 15m 62-78% LTHR",
          rep("Threshold", 4, ["Hard 8m 98-103% LTHR", "Jog 3m 62-70% LTHR"]),
          "Cooldown 5m 60-68% LTHR",
        ],
      };
    case "peak":
      return {
        title: "VO2 Intervals",
        durationMin: 55,
        blocks: [
          "Warmup 15m 62-80% LTHR",
          rep("VO2", 5, ["Hard 4m 104-110% LTHR", "Jog 3m 62% LTHR"]),
          "Cooldown 5m 60-68% LTHR",
        ],
      };
    case "taper":
      return {
        title: "Taper Openers",
        durationMin: 40,
        blocks: [
          "Warmup 12m 65-75% LTHR",
          rep("Openers", 4, ["Quick 90s 100-105% LTHR", "Jog 2m 62% LTHR"]),
          "Cooldown 8m 60-68% LTHR",
        ],
      };
    case "recovery":
      return {
        title: "Easy Aerobic Run",
        durationMin: 40,
        blocks: ["Easy Run 40m 62-72% LTHR"],
      };
  }
}

function trailSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Easy Trail Shakeout",
      durationMin: 40,
      blocks: ["Easy Trail 40m 60-72% LTHR"],
    };
  if (tier === "medium")
    return {
      title: "Rolling Trail Endurance",
      durationMin: 70,
      blocks: [
        "Warmup 10m 65-72% LTHR",
        "Rolling Endurance 55m 72-82% LTHR",
        "Cooldown 5m 60-68% LTHR",
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Hilly Steady State",
        durationMin: 75,
        blocks: [
          "Warmup 15m 65-75% LTHR",
          "Hilly Steady State 50m 78-86% LTHR",
          "Cooldown 10m 60-70% LTHR",
        ],
      };
    case "build":
      return {
        title: "Hill Repeats",
        durationMin: 65,
        blocks: [
          "Warmup 15m 62-78% LTHR",
          rep("Hill Repeats", 7, [
            "Uphill 3m 98-106% LTHR",
            "Down 3m 55-65% LTHR",
          ]),
          "Cooldown 8m 60-70% LTHR",
        ],
      };
    case "peak":
      return {
        title: "Rolling Surges",
        durationMin: 60,
        blocks: [
          "Warmup 15m 62-78% LTHR",
          rep("Surges", 6, [
            "Surge 45s 100-106% LTHR",
            "Steady 4m15s 80-88% LTHR",
          ]),
          "Cooldown 10m 60-70% LTHR",
        ],
      };
    case "taper":
      return {
        title: "Short Trail + Pickups",
        durationMin: 40,
        blocks: [
          "Warmup 15m 65-75% LTHR",
          rep("Pickups", 3, ["Pickup 60s 100% LTHR", "Easy 3m 60-68% LTHR"]),
          "Cooldown 8m 60-68% LTHR",
        ],
      };
    case "recovery":
      return {
        title: "Easy Trail Run",
        durationMin: 45,
        blocks: ["Easy Trail Run 45m 62-72% LTHR"],
      };
  }
}

function bikeSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Recovery Spin",
      durationMin: 40,
      blocks: ["Recovery Spin 40m 45-55%"],
    };
  if (tier === "medium")
    return {
      title: "Endurance + Tempo",
      durationMin: 75,
      blocks: [
        "Warmup 10m ramp 50%-65%",
        rep("Tempo", 2, ["Tempo 20m 76-84%", "Easy 5m 55%"]),
        "Cooldown 10m 50-60%",
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Sweet Spot Intervals",
        durationMin: 80,
        blocks: [
          "Warmup 15m ramp 50%-70%",
          rep("Sweet Spot", 3, ["Work 12m 88-93%", "Easy 5m 55%"]),
          "Cooldown 10m 50-60%",
        ],
      };
    case "build":
      return {
        title: "Threshold Intervals",
        durationMin: 78,
        blocks: [
          "Warmup 15m ramp 50%-75%",
          rep("Threshold", 4, ["Work 8m 98-104%", "Easy 4m 55%"]),
          "Cooldown 10m 50-60%",
        ],
      };
    case "peak":
      return {
        title: "VO2 Intervals",
        durationMin: 65,
        blocks: [
          "Warmup 15m ramp 50%-75%",
          rep("VO2", 5, ["Hard 3m 110-118%", "Easy 3m 50%"]),
          "Cooldown 10m 50-60%",
        ],
      };
    case "taper":
      return {
        title: "Taper Openers",
        durationMin: 45,
        blocks: [
          "Warmup 15m ramp 50%-70%",
          rep("Openers", 3, ["Crisp 2m 100-105%", "Easy 4m 55%"]),
          "Cooldown 10m 50-60%",
        ],
      };
    case "recovery":
      return {
        title: "Easy Endurance Spin",
        durationMin: 60,
        blocks: ["Easy Spin 60m 55-68%"],
      };
  }
}

function swimSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return {
      title: "Technique Swim",
      durationMin: 35,
      blocks: [
        "Warmup 300mtr",
        rep("Catch-Up Drill", 6, ["Drill 50mtr", "Rest 15s"]),
        "Smooth Free 400mtr",
        "Cooldown 100mtr",
      ],
    };
  if (tier === "medium")
    return {
      title: "Aerobic Endurance Swim",
      durationMin: 50,
      blocks: [
        "Warmup 300mtr",
        rep("Build", 4, ["Swim 50mtr", "Rest 15s"]),
        rep("Endurance", 4, ["Free 400mtr", "Rest 30s"]),
        "Cooldown 200mtr",
      ],
    };
  switch (block) {
    case "base":
      return {
        title: "Aerobic Intervals",
        durationMin: 55,
        blocks: [
          "Warmup 400mtr",
          rep("Drills", 4, ["Drill 50mtr", "Rest 15s"]),
          rep("Aerobic", 10, ["Free 100mtr", "Rest 15s"]),
          "Pull 300mtr",
          "Cooldown 200mtr",
        ],
      };
    case "build":
      return {
        title: "Threshold 200s",
        durationMin: 60,
        blocks: [
          "Warmup 400mtr",
          rep("Build", 4, ["Swim 50mtr", "Rest 15s"]),
          rep("Threshold", 5, ["Free 200mtr", "Rest 20s"]),
          rep("Sprints", 4, ["Fast 50mtr", "Rest 30s"]),
          "Cooldown 200mtr",
        ],
      };
    case "peak":
      return {
        title: "Race-Pace 100s",
        durationMin: 50,
        blocks: [
          "Warmup 400mtr",
          rep("Descend", 6, ["Swim 50mtr", "Rest 15s"]),
          rep("Race Pace", 8, ["Fast 100mtr", "Rest 20s"]),
          "Cooldown 200mtr",
        ],
      };
    case "taper":
      return {
        title: "Taper Tune-Up",
        durationMin: 35,
        blocks: [
          "Warmup 300mtr",
          rep("Race Pace", 6, ["Fast 50mtr", "Rest 20s"]),
          "Smooth Free 200mtr",
          "Cooldown 100mtr",
        ],
      };
    case "recovery":
      return {
        title: "Easy Swim",
        durationMin: 35,
        blocks: [
          "Warmup 300mtr",
          rep("Drills", 6, ["Drill 50mtr", "Rest 15s"]),
          "Smooth Free 400mtr",
          "Cooldown 100mtr",
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
