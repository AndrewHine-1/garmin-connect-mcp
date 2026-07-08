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

interface Session {
  title: string;
  durationMin: number;
  body: string; // step text, no trailing newline
}

// Repeat blocks follow the intervals.icu format the user standardized on:
// blank line BEFORE the `Nx` header, none between it and its first step.
function rep(n: number, ...steps: string[]): string {
  return `${n}x\n${steps.map((s) => `- ${s}`).join("\n")}`;
}

/** The tier each sport actually trains at, given day position + readiness. */
function effectiveTier(tier: ReadinessTier, slot: number): ReadinessTier {
  if (slot === 0) return tier;
  // Second/third sessions of the day step down one intensity level.
  return tier === "high" ? "medium" : "low";
}

function runSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low") {
    return {
      title: "Recovery Jog",
      durationMin: 35,
      body: "- 35m 60-70% LTHR relaxed, walk breaks fine",
    };
  }
  if (tier === "medium") {
    return {
      title: "Aerobic Endurance + Strides",
      durationMin: 55,
      body: `Warmup
- 10m 65-72% LTHR

Main
- 35m 72-80% LTHR steady

${rep(4, "20s 95% LTHR stride, tall and quick", "70s easy jog")}

Cooldown
- 4m 60-68% LTHR`,
    };
  }
  // high — quality flavored by block
  switch (block) {
    case "base":
      return {
        title: "Tempo Run",
        durationMin: 60,
        body: `Warmup
- 15m ramp 62-75% LTHR

${rep(2, "15m 88-93% LTHR tempo", "5m 65% LTHR float")}

Cooldown
- 5m 60-68% LTHR`,
      };
    case "build":
      return {
        title: "Threshold Intervals",
        durationMin: 62,
        body: `Warmup
- 15m ramp 62-78% LTHR

${rep(4, "8m 98-103% LTHR", "3m 62-70% LTHR jog")}

Cooldown
- 5m 60-68% LTHR`,
      };
    case "peak":
      return {
        title: "VO2 / Race-Pace Sharpener",
        durationMin: 55,
        body: `Warmup
- 15m ramp 62-80% LTHR

${rep(5, "4m 104-110% LTHR strong", "3m 62% LTHR jog")}

Cooldown
- 5m 60-68% LTHR`,
      };
    case "taper":
      return {
        title: "Taper Openers",
        durationMin: 40,
        body: `Warmup
- 12m 65-75% LTHR

${rep(4, "90s 100-105% LTHR crisp", "2m 62% LTHR jog")}

Cooldown
- 8m 60-68% LTHR`,
      };
    case "recovery":
      return {
        title: "Easy Aerobic Run",
        durationMin: 40,
        body: "- 40m 62-72% LTHR conversational",
      };
  }
}

function trailSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low") {
    return {
      title: "Easy Trail Shakeout",
      durationMin: 40,
      body: "- 40m 60-72% LTHR easy trail, hike the steep bits",
    };
  }
  if (tier === "medium") {
    return {
      title: "Rolling Trail Endurance",
      durationMin: 70,
      body: `Warmup
- 10m 65-72% LTHR easy trail

Main
- 55m 72-82% LTHR rolling terrain, steady effort not pace

Cooldown
- 5m 60-68% LTHR`,
    };
  }
  switch (block) {
    case "base":
      return {
        title: "Hilly Steady State",
        durationMin: 75,
        body: `Warmup
- 15m 65-75% LTHR

Main
- 50m 78-86% LTHR hilly trail, even effort up and over the top

Cooldown
- 10m 60-70% LTHR`,
      };
    case "build":
      return {
        title: "Hill Repeats",
        durationMin: 65,
        body: `Warmup
- 15m ramp 62-78% LTHR to the climb

${rep(7, "3m 98-106% LTHR strong uphill, drive the arms", "3m easy jog/walk back down")}

Cooldown
- 8m 60-70% LTHR`,
      };
    case "peak":
      return {
        title: "Race-Sim Surges",
        durationMin: 60,
        body: `Warmup
- 15m ramp 62-78% LTHR

Main
- 30m 80-88% LTHR with a 45s surge to 105% LTHR every 5m — practice rough-terrain rhythm changes

Cooldown
- 10m 60-70% LTHR`,
      };
    case "taper":
      return {
        title: "Short Trail + Pickups",
        durationMin: 40,
        body: `Warmup
- 15m 65-75% LTHR easy trail

${rep(3, "60s 100% LTHR pickup on runnable ground", "3m easy")}

Cooldown
- 8m 60-68% LTHR`,
      };
    case "recovery":
      return {
        title: "Easy Trail Run",
        durationMin: 45,
        body: "- 45m 62-72% LTHR soft surfaces, enjoy it",
      };
  }
}

function bikeSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low") {
    return {
      title: "Recovery Spin",
      durationMin: 40,
      body: "- 40m 45-55% FTP high cadence, flat route",
    };
  }
  if (tier === "medium") {
    return {
      title: "Endurance + Tempo",
      durationMin: 75,
      body: `Warmup
- 10m ramp 50-65% FTP

${rep(2, "20m 76-84% FTP tempo, smooth cadence 85-95rpm", "5m 55% FTP easy")}

Cooldown
- 10m 50-60% FTP`,
    };
  }
  switch (block) {
    case "base":
      return {
        title: "Sweet Spot Intervals",
        durationMin: 80,
        body: `Warmup
- 15m ramp 50-70% FTP

${rep(3, "12m 88-93% FTP", "5m 55% FTP easy")}

Cooldown
- 10m 50-60% FTP`,
      };
    case "build":
      return {
        title: "Threshold Intervals",
        durationMin: 78,
        body: `Warmup
- 15m ramp 50-75% FTP with 3x30s @ 100% FTP

${rep(4, "8m 98-104% FTP", "4m 55% FTP easy")}

Cooldown
- 10m 50-60% FTP`,
      };
    case "peak":
      return {
        title: "VO2 Intervals",
        durationMin: 65,
        body: `Warmup
- 15m ramp 50-75% FTP with 3x30s @ 105% FTP

${rep(5, "3m 110-118% FTP", "3m 50% FTP very easy")}

Cooldown
- 10m 50-60% FTP`,
      };
    case "taper":
      return {
        title: "Taper Openers",
        durationMin: 45,
        body: `Warmup
- 15m ramp 50-70% FTP

${rep(3, "2m 100-105% FTP crisp", "4m 55% FTP easy")}

Cooldown
- 10m 50-60% FTP`,
      };
    case "recovery":
      return {
        title: "Easy Endurance Spin",
        durationMin: 60,
        body: "- 60m 55-68% FTP steady, comfortable cadence",
      };
  }
}

function swimSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low") {
    return {
      title: "Technique Swim",
      durationMin: 35,
      body: `Warmup
- 300m easy free

Drills
${rep(6, "50m drill (catch-up / fingertip drag), 15s rest")}

Main
- 400m smooth free, focus on long stroke

Cooldown
- 100m easy choice`,
    };
  }
  if (tier === "medium") {
    return {
      title: "Aerobic Endurance Swim",
      durationMin: 50,
      body: `Warmup
- 300m easy free
- 4x50m build, 15s rest

Main
${rep(4, "400m steady free, 30s rest — hold even splits")}

Cooldown
- 200m easy choice`,
    };
  }
  switch (block) {
    case "base":
      return {
        title: "Aerobic Intervals",
        durationMin: 55,
        body: `Warmup
- 400m easy free
- 4x50m drill/swim, 15s rest

Main
${rep(10, "100m moderate free, 15s rest — consistent pace")}

Pull
- 300m pull buoy, strong catch

Cooldown
- 200m easy choice`,
      };
    case "build":
      return {
        title: "Threshold 200s",
        durationMin: 60,
        body: `Warmup
- 400m easy free
- 4x50m build, 15s rest

Main
${rep(5, "200m strong free, 20s rest — best sustainable pace")}

${rep(4, "50m fast, 30s rest")}

Cooldown
- 200m easy choice`,
      };
    case "peak":
      return {
        title: "Race-Pace 100s",
        durationMin: 50,
        body: `Warmup
- 400m easy free
- 6x50m descend 1-3, 15s rest

Main
${rep(8, "100m fast free at target race pace, 20s rest")}

Cooldown
- 200m easy choice`,
      };
    case "taper":
      return {
        title: "Taper Tune-Up",
        durationMin: 35,
        body: `Warmup
- 300m easy free

Main
${rep(6, "50m at race pace, 20s rest")}
- 200m smooth free

Cooldown
- 100m easy choice`,
      };
    case "recovery":
      return {
        title: "Easy Swim",
        durationMin: 35,
        body: `- 300m easy free
- 6x50m drill of choice, 15s rest
- 400m smooth free
- 100m easy backstroke`,
      };
  }
}

function liftSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low") {
    return {
      title: "Mobility + Core",
      durationMin: 30,
      body: `- 10m dynamic mobility flow (hips, t-spine, ankles)
- 15m core circuit: 3 rounds — 45s plank, 10 dead bugs/side, 12 glute bridges, 30s side plank/side
- 5m easy stretching`,
    };
  }
  if (tier === "medium") {
    return {
      title: "Full-Body Strength",
      durationMin: 45,
      body: `Warmup
- 10m dynamic warmup + empty-bar work

Main
- 12m squat or leg press: 3x8 moderate, 2m rest
- 10m bench or push-up variation: 3x8-10
- 10m row variation: 3x10

Core
- 8m: 3 rounds — 10 hanging knee raises, 30s pallof press/side

Cooldown
- 5m stretching`,
    };
  }
  switch (block) {
    case "base":
      return {
        title: "Strength Endurance",
        durationMin: 50,
        body: `Warmup
- 10m dynamic warmup + ramp sets

Main
- 12m goblet squat: 3x12, 90s rest
- 10m Romanian deadlift: 3x10
- 10m push-up + single-arm row superset: 3x(12+10/side)
- 8m walking lunges: 3x10/side

Cooldown
- 10m core + stretching`,
      };
    case "build":
      return {
        title: "Max Strength",
        durationMin: 55,
        body: `Warmup
- 12m dynamic warmup + ramp to working weight

Main
- 15m back squat: 4x5 heavy, 2-3m rest
- 12m deadlift: 3x5, 2-3m rest
- 10m bench press: 4x5

Accessory
- 10m: pull-ups 3x6-8, hip thrust 3x8

Cooldown
- 6m stretching`,
      };
    case "peak":
      return {
        title: "Power (Low Volume)",
        durationMin: 40,
        body: `Warmup
- 12m dynamic warmup, build to fast reps

Main
- 10m trap-bar jump or squat jump: 4x3 explosive, full rest
- 10m push press: 4x3 fast
- 8m kettlebell swing: 4x8 powerful

Cooldown
- 10m mobility, leave feeling fresh`,
      };
    case "taper":
      return {
        title: "Maintenance (Light)",
        durationMin: 30,
        body: `Warmup
- 8m dynamic warmup

Main
- 8m squat: 2x5 @ ~60% of normal, crisp
- 6m push: 2x8 light
- 6m pull: 2x8 light

Cooldown
- 2m shake out — nothing to fatigue`,
      };
    case "recovery":
      return {
        title: "Mobility Session",
        durationMin: 30,
        body: `- 15m full-body mobility flow
- 10m light core: 2 rounds — 30s plank, 10 bird-dogs/side, 12 glute bridges
- 5m breathing + stretching`,
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
    const description = `${s.body}\n\nCoach: ${rationale}`;
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
