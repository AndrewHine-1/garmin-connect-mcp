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
  /** Where the session shape comes from (pro endurance practice); shown in the
   * dashboard rationale only, never in the exported workout text. */
  inspiration?: string;
}

/** Uniform random pick — each Generate rolls a fresh variant. */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rep(n: number, children: string[]): Rep {
  return { n, children };
}

// Build one step in the intervals.icu order the athlete confirmed works:
// "<duration|distance> [name] <zone> hr". Zone is "z1" or "z2-z4"; the HR zone
// is the actual target. "m" = minutes; swim distances use "y" for yards.
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
    return pick<Session>([
      {
        title: "Recovery Jog",
        durationMin: 35,
        inspiration:
          "classic recovery-day jog — pace irrelevant, blood flow only",
        blocks: [step("35m", "recovery jog", "z1")],
      },
      {
        title: "Easy Rhythm Shakeout",
        durationMin: 35,
        inspiration: "shakeout with short rhythm touches, kept fully aerobic",
        blocks: [
          step("20m", "easy", "z1"),
          rep(6, [step("1m", "rhythm", "z1-z2"), step("1m", "easy", "z1")]),
          step("3m", "cool down", "z1"),
        ],
      },
    ]);
  if (tier === "medium")
    return pick<Session>([
      {
        title: "Aerobic Endurance + Strides",
        durationMin: 55,
        inspiration:
          "daily aerobic volume with strides — the staple day in every pro program",
        blocks: [
          step("10m", "warm up", "z1-z2"),
          step("35m", "endurance", "z2"),
          rep(4, [step("20s", "stride", "z4"), step("70s", "easy", "z1")]),
          step("4m", "cool down", "z1"),
        ],
      },
      {
        title: "Progression Run",
        durationMin: 50,
        inspiration:
          "Kenyan-style progression — start conversational, finish honest",
        blocks: [
          step("15m", "easy", "z1-z2"),
          step("15m", "steady", "z2"),
          step("12m", "strong", "z2-z3"),
          step("8m", "cool down", "z1"),
        ],
      },
      {
        title: "Light Fartlek",
        durationMin: 52,
        inspiration:
          "Scandinavian fartlek — unstructured speed on aerobic legs",
        blocks: [
          step("12m", "warm up", "z1-z2"),
          rep(8, [step("1m", "surge", "z2-z3"), step("2m", "float", "z1-z2")]),
          step("8m", "cool down", "z1"),
        ],
      },
    ]);
  const table: Record<TrainingBlock, Session[]> = {
    base: [
      {
        title: "Tempo Run 2x15",
        durationMin: 60,
        inspiration:
          "Lydiard-style steady-state tempo — the base-season backbone",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(2, [step("15m", "tempo", "z3"), step("5m", "float", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      },
      {
        title: "Alternation Tempo",
        durationMin: 58,
        inspiration: "Canova alternations — surging within a continuous tempo",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(8, [step("2m", "on", "z3"), step("1m", "float", "z2")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Long Hill Circuits",
        durationMin: 58,
        inspiration: "Lydiard hill phase — strength endurance on a long grade",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(6, [step("2m", "uphill", "z3-z4"), step("3m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
    ],
    build: [
      {
        title: "Norwegian Threshold 10x3",
        durationMin: 62,
        inspiration:
          "Ingebrigtsen-camp double-threshold staple — controlled z4 with short floats",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(10, [step("3m", "threshold", "z4"), step("1m", "float", "z1")]),
          step("6m", "cool down", "z1"),
        ],
      },
      {
        title: "Classic Threshold 4x8",
        durationMin: 62,
        inspiration: "Seiler's 4x8 — the best-studied threshold interval dose",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(4, [step("8m", "hard", "z4"), step("3m", "easy", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      },
      {
        title: "Cruise Intervals 5x6",
        durationMin: 62,
        inspiration:
          "Daniels cruise intervals — threshold volume with minimal rest",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(5, [step("6m", "cruise", "z4"), step("90s", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      },
    ],
    peak: [
      {
        title: "Billat 30/30s",
        durationMin: 52,
        inspiration:
          "Billat 30/30 — maximal aerobic speed in short alternations",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(16, [step("30s", "fast", "z5"), step("30s", "easy", "z1")]),
          step("2m", "easy", "z1"),
          rep(4, [step("20s", "stride", "z4"), step("70s", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      },
      {
        title: "VO2 5x4",
        durationMin: 55,
        inspiration: "classic VO2max intervals — 4-minute reps at 3k-5k effort",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(5, [step("4m", "hard", "z5"), step("3m", "easy", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      },
      {
        title: "Race-Pace Blocks",
        durationMin: 56,
        inspiration: "Canova specific blocks — extended time at race intensity",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(3, [
            step("8m", "race pace", "z3-z4"),
            step("3m", "float", "z1-z2"),
          ]),
          step("8m", "cool down", "z1"),
        ],
      },
    ],
    taper: [
      {
        title: "Taper Openers",
        durationMin: 40,
        inspiration: "race-week openers — touch speed, zero fatigue",
        blocks: [
          step("12m", "warm up", "z1-z2"),
          rep(4, [step("90s", "quick", "z4-z5"), step("2m", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      },
      {
        title: "Pre-Race Rhythm",
        durationMin: 38,
        inspiration:
          "sharpening rhythm reps at race effort, well short of strain",
        blocks: [
          step("12m", "warm up", "z1-z2"),
          rep(3, [
            step("3m", "race rhythm", "z3-z4"),
            step("2m", "easy", "z1"),
          ]),
          rep(3, [step("20s", "stride", "z4"), step("70s", "easy", "z1")]),
          step("6m", "cool down", "z1"),
        ],
      },
    ],
    recovery: [
      {
        title: "Easy Aerobic Run",
        durationMin: 40,
        inspiration: "recovery-week aerobic maintenance",
        blocks: [step("40m", "easy run", "z1-z2")],
      },
      {
        title: "Easy Run + Strides",
        durationMin: 40,
        inspiration: "easy volume with a few strides to keep the legs awake",
        blocks: [
          step("32m", "easy", "z1-z2"),
          rep(4, [step("20s", "stride", "z3"), step("70s", "easy", "z1")]),
          step("2m", "cool down", "z1"),
        ],
      },
    ],
  };
  return pick(table[block]);
}

function trailSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return pick<Session>([
      {
        title: "Easy Trail Shakeout",
        durationMin: 40,
        inspiration: "soft-surface recovery — hike anything steep",
        blocks: [step("40m", "easy trail", "z1-z2")],
      },
      {
        title: "Recovery Hike-Run",
        durationMin: 45,
        inspiration: "mountain-runner recovery: alternate jogging and hiking",
        blocks: [
          rep(5, [step("6m", "easy jog", "z1"), step("3m", "hike", "z1")]),
        ],
      },
    ]);
  if (tier === "medium")
    return pick<Session>([
      {
        title: "Rolling Trail Endurance",
        durationMin: 70,
        inspiration: "even-effort rolling terrain — the trail long-run staple",
        blocks: [
          step("10m", "warm up", "z1-z2"),
          step("55m", "rolling endurance", "z2"),
          step("5m", "cool down", "z1"),
        ],
      },
      {
        title: "Trail Progression",
        durationMin: 65,
        inspiration: "progressive trail run — finish the last climb strongest",
        blocks: [
          step("20m", "easy", "z1-z2"),
          step("25m", "steady", "z2"),
          step("12m", "strong", "z2-z3"),
          step("8m", "cool down", "z1"),
        ],
      },
    ]);
  const table: Record<TrainingBlock, Session[]> = {
    base: [
      {
        title: "Hilly Steady State",
        durationMin: 75,
        inspiration:
          "mountain steady state — climb at even effort, not even pace",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          step("50m", "hilly steady state", "z2-z3"),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Uphill Tempo Grind",
        durationMin: 65,
        inspiration:
          "Jornet-style sustained uphill work — long, controlled climbing",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(2, [step("12m", "uphill tempo", "z3"), step("6m", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      },
    ],
    build: [
      {
        title: "Hill Repeats 7x3",
        durationMin: 65,
        inspiration: "classic hill VO2 — strong uphill, full-recovery jog down",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(7, [step("3m", "uphill", "z5"), step("3m", "down", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      },
      {
        title: "Long Climb Threshold",
        durationMin: 66,
        inspiration: "sky-running threshold — extended climbing reps at z4",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(3, [
            step("8m", "uphill threshold", "z4"),
            step("4m", "down", "z1"),
          ]),
          step("8m", "cool down", "z1"),
        ],
      },
      {
        title: "Rolling Threshold 4x8",
        durationMin: 64,
        inspiration: "Seiler 4x8 taken to rolling terrain",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(4, [step("8m", "rolling hard", "z4"), step("3m", "easy", "z1")]),
          step("5m", "cool down", "z1"),
        ],
      },
    ],
    peak: [
      {
        title: "Rolling Surges",
        durationMin: 60,
        inspiration:
          "race-simulation surging — repeated gear changes on tired legs",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(6, [step("45s", "surge", "z5"), step("4m15s", "steady", "z3")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Short Hill Sprints + Tempo",
        durationMin: 58,
        inspiration: "power sprints stacked ahead of race-effort tempo",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(8, [step("30s", "hill sprint", "z5"), step("2m", "easy", "z1")]),
          step("15m", "tempo", "z3"),
          step("8m", "cool down", "z1"),
        ],
      },
    ],
    taper: [
      {
        title: "Short Trail + Pickups",
        durationMin: 40,
        inspiration: "race-week legs check on easy trail",
        blocks: [
          step("15m", "warm up", "z1-z2"),
          rep(3, [step("60s", "pickup", "z4"), step("3m", "easy", "z1")]),
          step("8m", "cool down", "z1"),
        ],
      },
      {
        title: "Course-Feel Openers",
        durationMin: 38,
        inspiration: "short race-terrain touches at goal effort",
        blocks: [
          step("12m", "warm up", "z1-z2"),
          rep(4, [
            step("90s", "race effort", "z3-z4"),
            step("2m", "easy", "z1"),
          ]),
          step("8m", "cool down", "z1"),
        ],
      },
    ],
    recovery: [
      {
        title: "Easy Trail Run",
        durationMin: 45,
        inspiration: "soft surfaces, easy effort",
        blocks: [step("45m", "easy trail run", "z1-z2")],
      },
      {
        title: "Flat Trail Cruise",
        durationMin: 50,
        inspiration: "flat, runnable trail at conversation pace",
        blocks: [
          step("45m", "easy cruise", "z1-z2"),
          step("5m", "cool down", "z1"),
        ],
      },
    ],
  };
  return pick(table[block]);
}

function bikeSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return pick<Session>([
      {
        title: "Recovery Spin",
        durationMin: 40,
        inspiration: "high-cadence flush ride — pro teams' day-after staple",
        blocks: [step("40m", "recovery spin", "z1")],
      },
      {
        title: "Coffee Spin",
        durationMin: 50,
        inspiration: "long-easy café ride tradition — strictly conversational",
        blocks: [step("50m", "easy spin", "z1")],
      },
    ]);
  if (tier === "medium")
    return pick<Session>([
      {
        title: "Endurance + Tempo",
        durationMin: 75,
        inspiration:
          "tempo blocks inside an endurance ride — classic aerobic builder",
        blocks: [
          step("10m", "warm up", "z1"),
          rep(2, [step("20m", "tempo", "z2-z3"), step("5m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Zone 2 + Cadence Work",
        durationMin: 70,
        inspiration:
          "steady z2 with high-cadence spin-ups — polarized easy-day work",
        blocks: [
          step("10m", "warm up", "z1"),
          step("40m", "endurance", "z2"),
          rep(4, [step("1m", "spin up", "z2"), step("3m", "steady", "z2")]),
          step("4m", "cool down", "z1"),
        ],
      },
    ]);
  const table: Record<TrainingBlock, Session[]> = {
    base: [
      {
        title: "Sweet Spot 3x12",
        durationMin: 80,
        inspiration: "sweet-spot base — the time-efficient aerobic builder",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(3, [step("12m", "sweet spot", "z3"), step("5m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Classic 2x20 Tempo",
        durationMin: 78,
        inspiration: "the 2x20 — decades-old FTP-building standard",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(2, [step("20m", "tempo", "z3"), step("6m", "easy", "z1")]),
          step("11m", "cool down", "z1"),
        ],
      },
      {
        title: "Low-Cadence Strength",
        durationMin: 72,
        inspiration: "big-gear seated climbing reps — on-bike strength work",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(4, [step("8m", "big gear", "z3"), step("4m", "easy spin", "z1")]),
          step("9m", "cool down", "z1"),
        ],
      },
    ],
    build: [
      {
        title: "Seiler 4x8",
        durationMin: 78,
        inspiration: "Seiler's 4x8 — best-studied HR-interval dose on the bike",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(4, [step("8m", "threshold", "z4"), step("4m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Over-Unders 3x10",
        durationMin: 72,
        inspiration: "over-unders — surging across threshold like race moves",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(3, [
            step("10m", "over under", "z3-z4"),
            step("5m", "easy", "z1"),
          ]),
          step("12m", "cool down", "z1"),
        ],
      },
      {
        title: "Long Threshold 3x12",
        durationMin: 80,
        inspiration: "extended threshold reps — grand-tour climber staple",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(3, [step("12m", "threshold", "z4"), step("6m", "easy", "z1")]),
          step("11m", "cool down", "z1"),
        ],
      },
    ],
    peak: [
      {
        title: "Rønnestad 40/20s",
        durationMin: 62,
        inspiration: "Rønnestad 40/20 micro-intervals — proven VO2 protocol",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(13, [step("40s", "hard", "z5"), step("20s", "soft pedal", "z1")]),
          step("5m", "easy", "z1"),
          rep(13, [step("40s", "hard", "z5"), step("20s", "soft pedal", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "VO2 5x3",
        durationMin: 65,
        inspiration: "classic 3-minute VO2max repeats",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(5, [step("3m", "hard", "z5"), step("3m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
    ],
    taper: [
      {
        title: "Taper Openers",
        durationMin: 45,
        inspiration: "race-week leg openers",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(3, [step("2m", "crisp", "z4"), step("4m", "easy", "z1")]),
          step("10m", "cool down", "z1"),
        ],
      },
      {
        title: "Sprint Touches",
        durationMin: 42,
        inspiration: "short sprints for neuromuscular sharpness, zero fatigue",
        blocks: [
          step("15m", "warm up", "z1"),
          rep(4, [step("30s", "fast", "z4-z5"), step("4m30s", "easy", "z1")]),
          step("7m", "cool down", "z1"),
        ],
      },
    ],
    recovery: [
      {
        title: "Easy Endurance Spin",
        durationMin: 60,
        inspiration: "recovery-week z1-z2 spin",
        blocks: [step("60m", "easy spin", "z1-z2")],
      },
      {
        title: "Short Recovery Ride",
        durationMin: 45,
        inspiration: "keep it short, flat, and light",
        blocks: [step("45m", "recovery ride", "z1")],
      },
    ],
  };
  return pick(table[block]);
}

function swimSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return pick<Session>([
      {
        title: "Technique Swim",
        durationMin: 35,
        inspiration:
          "drill-focused technique day — recovery that still earns feel",
        blocks: [
          step("300y", "warm up", "z1"),
          rep(6, [step("50y", "drill", "z1"), rest("15s")]),
          step("400y", "smooth free", "z2"),
          step("100y", "cool down", "z1"),
        ],
      },
      {
        title: "Easy Mixed Swim",
        durationMin: 35,
        inspiration: "easy mixed-stroke recovery swim",
        blocks: [
          step("300y", "warm up", "z1"),
          rep(4, [step("100y", "easy choice", "z1-z2"), rest("20s")]),
          step("300y", "smooth free", "z1-z2"),
          step("100y", "cool down", "z1"),
        ],
      },
    ]);
  if (tier === "medium")
    return pick<Session>([
      {
        title: "Aerobic Endurance 400s",
        durationMin: 50,
        inspiration: "long aerobic repeats — distance-squad bread and butter",
        blocks: [
          step("300y", "warm up", "z1-z2"),
          rep(4, [step("50y", "build", "z2"), rest("15s")]),
          rep(4, [step("400y", "endurance", "z2-z3"), rest("30s")]),
          step("200y", "cool down", "z1"),
        ],
      },
      {
        title: "Aerobic Pyramid",
        durationMin: 50,
        inspiration:
          "pyramid set — building then descending distances at steady effort",
        blocks: [
          step("300y", "warm up", "z1-z2"),
          step("100y", "steady", "z2"),
          rest("15s"),
          step("200y", "steady", "z2-z3"),
          rest("20s"),
          step("300y", "steady", "z2-z3"),
          rest("25s"),
          step("200y", "steady", "z2-z3"),
          rest("20s"),
          step("100y", "steady", "z2"),
          rest("15s"),
          step("400y", "pull", "z2"),
          step("200y", "cool down", "z1"),
        ],
      },
    ]);
  const table: Record<TrainingBlock, Session[]> = {
    base: [
      {
        title: "Aerobic 100s",
        durationMin: 55,
        inspiration: "high-rep aerobic 100s on short rest — classic base set",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(4, [step("50y", "drill", "z1"), rest("15s")]),
          rep(10, [step("100y", "aerobic", "z3"), rest("15s")]),
          step("300y", "pull", "z2"),
          step("200y", "cool down", "z1"),
        ],
      },
      {
        title: "Negative-Split 300s",
        durationMin: 55,
        inspiration:
          "negative-split repeats — pacing discipline under aerobic load",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(4, [step("50y", "build", "z2"), rest("15s")]),
          rep(4, [step("300y", "negative split", "z2-z3"), rest("30s")]),
          step("200y", "cool down", "z1"),
        ],
      },
    ],
    build: [
      {
        title: "Threshold 200s (CSS)",
        durationMin: 60,
        inspiration: "CSS-style threshold 200s — the swim-threshold standard",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(4, [step("50y", "build", "z2"), rest("15s")]),
          rep(5, [step("200y", "threshold", "z4"), rest("20s")]),
          rep(4, [step("50y", "sprint", "z5"), rest("30s")]),
          step("200y", "cool down", "z1"),
        ],
      },
      {
        title: "Threshold 100s",
        durationMin: 58,
        inspiration: "10x100 at threshold on tight rest — CSS density work",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(4, [step("50y", "drill", "z1"), rest("15s")]),
          rep(10, [step("100y", "threshold", "z4"), rest("15s")]),
          step("300y", "pull", "z2"),
          step("200y", "cool down", "z1"),
        ],
      },
      {
        title: "Broken 400s",
        durationMin: 60,
        inspiration: "broken 400s — race-distance blocks split by micro-rests",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(12, [step("100y", "strong", "z4"), rest("10s")]),
          rep(4, [step("50y", "easy", "z1-z2"), rest("15s")]),
          step("200y", "cool down", "z1"),
        ],
      },
    ],
    peak: [
      {
        title: "Race-Pace 100s",
        durationMin: 50,
        inspiration: "race-pace 100s — specific speed at goal effort",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(6, [step("50y", "descend", "z2-z3"), rest("15s")]),
          rep(8, [step("100y", "race pace", "z4-z5"), rest("20s")]),
          step("200y", "cool down", "z1"),
        ],
      },
      {
        title: "USRPT 50s",
        durationMin: 48,
        inspiration: "USRPT-style 50s — high-rep race-pace with short rest",
        blocks: [
          step("400y", "warm up", "z1-z2"),
          rep(16, [step("50y", "race pace", "z5"), rest("20s")]),
          step("200y", "smooth free", "z2"),
          step("200y", "cool down", "z1"),
        ],
      },
    ],
    taper: [
      {
        title: "Taper Tune-Up",
        durationMin: 35,
        inspiration: "race-week feel — short race-pace touches",
        blocks: [
          step("300y", "warm up", "z1-z2"),
          rep(6, [step("50y", "race pace", "z4"), rest("20s")]),
          step("200y", "smooth free", "z2"),
          step("100y", "cool down", "z1"),
        ],
      },
      {
        title: "Sharpen + Glide",
        durationMin: 32,
        inspiration: "a few fast 25s, then long easy swimming for feel",
        blocks: [
          step("300y", "warm up", "z1-z2"),
          rep(8, [step("25y", "fast", "z5"), rest("30s")]),
          step("300y", "smooth free", "z1-z2"),
          step("100y", "cool down", "z1"),
        ],
      },
    ],
    recovery: [
      {
        title: "Easy Swim",
        durationMin: 35,
        inspiration: "easy technique-led recovery swim",
        blocks: [
          step("300y", "warm up", "z1-z2"),
          rep(6, [step("50y", "drill", "z1"), rest("15s")]),
          step("400y", "smooth free", "z2"),
          step("100y", "cool down", "z1"),
        ],
      },
      {
        title: "Continuous Easy Swim",
        durationMin: 35,
        inspiration: "unbroken easy swimming — rhythm and relaxation",
        blocks: [
          step("200y", "warm up", "z1"),
          step("800y", "continuous easy", "z1-z2"),
          step("100y", "cool down", "z1"),
        ],
      },
    ],
  };
  return pick(table[block]);
}

// Strength has no HR/power target, so each set is a named time block; the
// rep scheme lives in the name using "×" (not "x", which would trip the
// repeat parser).
function liftSession(block: TrainingBlock, tier: ReadinessTier): Session {
  if (tier === "low")
    return pick<Session>([
      {
        title: "Mobility + Core",
        durationMin: 30,
        inspiration:
          "movement-quality day — mobility flow plus anti-rotation core",
        blocks: ["Mobility Flow 10m", "Core Circuit 15m", "Stretch 5m"],
      },
      {
        title: "Band + Core Reset",
        durationMin: 30,
        inspiration: "band activation and core reset — no loading",
        blocks: ["Band Activation 10m", "Core Circuit 12m", "Stretch 8m"],
      },
    ]);
  if (tier === "medium")
    return pick<Session>([
      {
        title: "Full-Body Strength A",
        durationMin: 45,
        inspiration:
          "endurance-athlete full-body day — squat/push/pull pattern",
        blocks: [
          "Warmup 10m",
          "Squat 3×8 12m",
          "Bench 3×8 10m",
          "Row 3×10 10m",
          "Core 8m",
          "Stretch 5m",
        ],
      },
      {
        title: "Full-Body Strength B",
        durationMin: 45,
        inspiration:
          "hinge-dominant full-body day — deadlift/press/pull pattern",
        blocks: [
          "Warmup 10m",
          "Romanian Deadlift 3×8 12m",
          "Overhead Press 3×8 10m",
          "Lat Pulldown 3×10 10m",
          "Core 8m",
          "Stretch 5m",
        ],
      },
    ]);
  const table: Record<TrainingBlock, Session[]> = {
    base: [
      {
        title: "Strength Endurance A",
        durationMin: 50,
        inspiration: "higher-rep strength endurance — base-phase gym standard",
        blocks: [
          "Warmup 10m",
          "Goblet Squat 3×12 12m",
          "Romanian Deadlift 3×10 10m",
          "Push-Up + Row 3×12 10m",
          "Walking Lunge 3×10 8m",
          "Core + Stretch 10m",
        ],
      },
      {
        title: "Strength Endurance B",
        durationMin: 50,
        inspiration:
          "single-leg emphasis — durability work for endurance athletes",
        blocks: [
          "Warmup 10m",
          "Split Squat 3×10 12m",
          "Step-Up 3×10 10m",
          "Single-Leg RDL 3×8 10m",
          "Pull-Up 3×6 8m",
          "Core + Stretch 10m",
        ],
      },
    ],
    build: [
      {
        title: "Max Strength — Squat Focus",
        durationMin: 55,
        inspiration: "heavy low-rep strength — squat-led session",
        blocks: [
          "Warmup 12m",
          "Back Squat 4×5 15m",
          "Deadlift 3×5 12m",
          "Bench Press 4×5 10m",
          "Pull-Up + Hip Thrust 3×8 10m",
          "Stretch 6m",
        ],
      },
      {
        title: "Max Strength — Hinge Focus",
        durationMin: 55,
        inspiration: "heavy low-rep strength — hinge-led session",
        blocks: [
          "Warmup 12m",
          "Deadlift 4×5 15m",
          "Front Squat 3×5 12m",
          "Overhead Press 4×5 10m",
          "Row + Nordic Curl 3×8 10m",
          "Stretch 6m",
        ],
      },
    ],
    peak: [
      {
        title: "Power — Jumps",
        durationMin: 40,
        inspiration: "low-volume explosive work — convert strength to power",
        blocks: [
          "Warmup 12m",
          "Trap-Bar Jump 4×3 10m",
          "Push Press 4×3 10m",
          "Kettlebell Swing 4×8 8m",
          "Mobility 10m",
        ],
      },
      {
        title: "Power — Plyo",
        durationMin: 40,
        inspiration: "plyometric emphasis — fast contacts, full recovery",
        blocks: [
          "Warmup 12m",
          "Box Jump 5×3 10m",
          "Med-Ball Throw 4×5 8m",
          "Hex-Bar Deadlift 3×3 10m",
          "Mobility 10m",
        ],
      },
    ],
    taper: [
      {
        title: "Maintenance",
        durationMin: 30,
        inspiration: "light race-week maintenance — crisp, nothing to fatigue",
        blocks: [
          "Warmup 8m",
          "Squat 2×5 8m",
          "Push 2×8 6m",
          "Pull 2×8 6m",
          "Stretch 2m",
        ],
      },
      {
        title: "Neural Primer",
        durationMin: 25,
        inspiration: "low-volume neural touch — a few fast light reps",
        blocks: [
          "Warmup 8m",
          "Jump Squat 3×3 6m",
          "Push Press 2×5 6m",
          "Stretch 5m",
        ],
      },
    ],
    recovery: [
      {
        title: "Mobility Session",
        durationMin: 30,
        inspiration: "full-body mobility flow",
        blocks: ["Mobility Flow 15m", "Light Core 10m", "Breathing 5m"],
      },
      {
        title: "Yoga-Style Flow",
        durationMin: 30,
        inspiration: "slow flow and breathing — parasympathetic day",
        blocks: ["Slow Flow 20m", "Breathing 5m", "Stretch 5m"],
      },
    ],
  };
  return pick(table[block]);
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
    const inspNote = s.inspiration ? ` Session: ${s.inspiration}.` : "";
    const rationale = `${ctx.summary}. ${meta.label} set to ${TIER_WORD[tier]} for your ${block} block.${slotNote}${inspNote}`;
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
