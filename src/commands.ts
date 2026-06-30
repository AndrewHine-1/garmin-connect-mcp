// Command registry — the single source of truth for the dashboard's command
// runner and recovery snapshot. Each entry mirrors one MCP tool from tools.ts
// (same Garmin endpoint / journal operation), but exposes a serializable param
// spec so the web UI can render a form for it, plus a `run(ctx)` the server
// invokes. Read tools (GET), the full habit journal, and simple workout
// actions are included; the file-producing FIT downloads and the two
// instruction-only tools (garmin-login, run-tests) are intentionally omitted —
// login has its own button, and FIT downloads are better via the MCP tools.

import type { GarminClient } from "./garmin-client.js";
import {
  loadJournal,
  findHabit,
  loggedDates,
  addHabit,
  deleteHabit,
  logHabit,
  unlogHabit,
} from "./journal.js";
import {
  DEFAULT_METRIC,
  metricKeys,
  getMetric,
  fetchMetricSeries,
} from "./recovery-metrics.js";
import { analyzeHabit, formatDetailed } from "./analysis.js";

export type ParamType = "string" | "number" | "boolean" | "date" | "enum";

export interface ParamDef {
  name: string;
  type: ParamType;
  required: boolean;
  default?: string | number | boolean;
  enumValues?: string[];
  description?: string;
}

export interface RunContext {
  args: Record<string, unknown>;
  today: string;
  /** Returns the authed Garmin client; the server only calls auth commands once a session exists. */
  requireClient: () => GarminClient;
}

export interface CommandDef {
  name: string;
  group: string;
  description: string;
  needsAuth: boolean;
  params: ParamDef[];
  run: (ctx: RunContext) => Promise<unknown>;
}

// ── arg accessors ───────────────────────────────────────────────────────────

function optStr(ctx: RunContext, name: string): string | undefined {
  const v = ctx.args[name];
  if (v == null || v === "") return undefined;
  return String(v);
}
function reqStr(ctx: RunContext, name: string): string {
  const v = optStr(ctx, name);
  if (!v) throw new Error(`"${name}" is required`);
  return v;
}
function numArg(ctx: RunContext, name: string, fallback: number): number {
  const v = ctx.args[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  if (!isFinite(n)) throw new Error(`"${name}" must be a number`);
  return n;
}
function boolArg(ctx: RunContext, name: string, fallback: boolean): boolean {
  const v = ctx.args[name];
  if (v == null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  return ["true", "yes", "1", "on"].includes(String(v).toLowerCase());
}
/** Optional date arg, defaulting to today. */
function dateArg(ctx: RunContext, name = "date"): string {
  return optStr(ctx, name) ?? ctx.today;
}
function daysAgoIso(n: number): string {
  // Local calendar day, consistent with the server's today().
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x: number): string => (x < 10 ? "0" : "") + x;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── reusable param presets ──────────────────────────────────────────────────

const P_DATE: ParamDef = {
  name: "date",
  type: "date",
  required: false,
  description: "YYYY-MM-DD, defaults to today",
};
const P_ACTIVITY_ID: ParamDef = {
  name: "activityId",
  type: "string",
  required: true,
  description: "Activity ID (from list-activities)",
};
const P_METRIC: ParamDef = {
  name: "metric",
  type: "enum",
  required: false,
  default: DEFAULT_METRIC,
  enumValues: metricKeys(),
  description: "Recovery metric to correlate against",
};
const P_RANGE_START: ParamDef = {
  name: "startDate",
  type: "date",
  required: false,
  description: "YYYY-MM-DD, defaults to 60 days ago",
};
const P_RANGE_END: ParamDef = {
  name: "endDate",
  type: "date",
  required: false,
  description: "YYYY-MM-DD, defaults to today",
};

// ── factories for the common shapes ──────────────────────────────────────────

/** GET with the date embedded in the path. */
function pathDateGet(
  name: string,
  group: string,
  description: string,
  pathFn: (d: string) => string
): CommandDef {
  return {
    name,
    group,
    description,
    needsAuth: true,
    params: [P_DATE],
    run: (ctx) => ctx.requireClient().get(pathFn(dateArg(ctx))),
  };
}

/** GET with the date passed as a query param. */
function queryDateGet(
  name: string,
  group: string,
  description: string,
  path: string,
  dateParamName: string,
  extra: Record<string, string | number> = {}
): CommandDef {
  return {
    name,
    group,
    description,
    needsAuth: true,
    params: [P_DATE],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(path, { [dateParamName]: dateArg(ctx), ...extra }),
  };
}

/** GET keyed on an activity id, optionally with a path suffix. */
function activityGet(
  name: string,
  description: string,
  suffix: string,
  query?: Record<string, string | number>
): CommandDef {
  return {
    name,
    group: "Activities",
    description,
    needsAuth: true,
    params: [P_ACTIVITY_ID],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(
          `activity-service/activity/${reqStr(ctx, "activityId")}${suffix}`,
          query
        ),
  };
}

// ── the registry ─────────────────────────────────────────────────────────────

export const COMMANDS: CommandDef[] = [
  // Session / Profile
  {
    name: "check-session",
    group: "Session",
    description: "Verify the saved Garmin session is still valid",
    needsAuth: true,
    params: [],
    run: async (ctx) => {
      const profile = await ctx
        .requireClient()
        .get("userprofile-service/userprofile/user-settings/");
      return { status: "ok", profile };
    },
  },
  {
    name: "get-user-profile",
    group: "Profile",
    description: "Your Garmin Connect user profile and settings",
    needsAuth: true,
    params: [],
    run: (ctx) =>
      ctx.requireClient().get("userprofile-service/userprofile/user-settings/"),
  },

  // Recovery & Health
  pathDateGet(
    "get-training-readiness",
    "Recovery & Health",
    "Training readiness score (sleep, recovery, training load)",
    (d) => `metrics-service/metrics/trainingreadiness/${d}`
  ),
  queryDateGet(
    "get-sleep",
    "Recovery & Health",
    "Sleep score, duration, stages, SpO2, HRV during sleep",
    "sleep-service/sleep/dailySleepData",
    "date",
    { nonSleepBufferMinutes: 60 }
  ),
  pathDateGet(
    "get-hrv",
    "Recovery & Health",
    "Heart rate variability data for a date",
    (d) => `hrv-service/hrv/${d}`
  ),
  queryDateGet(
    "get-daily-heart-rate",
    "Recovery & Health",
    "Heart rate throughout the day (incl. resting HR)",
    "wellness-service/wellness/dailyHeartRate",
    "date"
  ),
  pathDateGet(
    "get-daily-stress",
    "Recovery & Health",
    "Stress levels throughout the day",
    (d) => `wellness-service/wellness/dailyStress/${d}`
  ),
  {
    name: "get-body-battery",
    group: "Recovery & Health",
    description: "Today's body battery charged/drained values",
    needsAuth: true,
    params: [],
    run: (ctx) =>
      ctx
        .requireClient()
        .get("wellness-service/wellness/bodyBattery/messagingToday"),
  },
  pathDateGet(
    "get-daily-respiration",
    "Recovery & Health",
    "Respiration rate data for a date",
    (d) => `wellness-service/wellness/daily/respiration/${d}`
  ),
  pathDateGet(
    "get-daily-intensity-minutes",
    "Recovery & Health",
    "Intensity minutes earned for a date",
    (d) => `wellness-service/wellness/daily/im/${d}`
  ),
  queryDateGet(
    "get-daily-movement",
    "Recovery & Health",
    "Daily movement/activity data",
    "wellness-service/wellness/dailyMovement",
    "calendarDate"
  ),
  queryDateGet(
    "get-daily-summary-chart",
    "Recovery & Health",
    "Combined daily wellness chart data",
    "wellness-service/wellness/dailySummaryChart/",
    "date"
  ),
  pathDateGet(
    "get-vo2max",
    "Recovery & Health",
    "Latest VO2 Max / fitness level estimate",
    (d) => `metrics-service/metrics/maxmet/latest/${d}`
  ),
  pathDateGet(
    "get-hydration",
    "Recovery & Health",
    "Daily hydration / water intake data",
    (d) => `usersummary-service/usersummary/hydration/allData/${d}`
  ),
  {
    name: "get-daily-summary",
    group: "Recovery & Health",
    description: "Steps, calories, distance, intensity minutes, floors",
    needsAuth: true,
    params: [P_DATE],
    run: async (ctx) => {
      const client = ctx.requireClient();
      const displayName = await client.getDisplayName();
      return client.get(
        `usersummary-service/usersummary/daily/${displayName}`,
        {
          calendarDate: dateArg(ctx),
        }
      );
    },
  },

  // Activities
  {
    name: "list-activities",
    group: "Activities",
    description: "List activities with pagination",
    needsAuth: true,
    params: [
      { name: "limit", type: "number", required: false, default: 20 },
      { name: "start", type: "number", required: false, default: 0 },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .get("activitylist-service/activities/search/activities", {
          limit: numArg(ctx, "limit", 20),
          start: numArg(ctx, "start", 0),
        }),
  },
  activityGet("get-activity", "Full activity summary", ""),
  {
    name: "get-activity-details",
    group: "Activities",
    description: "Time-series metrics (HR, cadence, elevation, pace)",
    needsAuth: true,
    params: [
      P_ACTIVITY_ID,
      { name: "maxChartSize", type: "number", required: false, default: 10000 },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(`activity-service/activity/${reqStr(ctx, "activityId")}/details`, {
          maxChartSize: numArg(ctx, "maxChartSize", 10000),
          maxPolylineSize: 0,
          maxHeatMapSize: 2000,
        }),
  },
  activityGet("get-activity-splits", "Lap/split data", "/splits"),
  activityGet(
    "get-activity-hr-zones",
    "Heart rate time-in-zone breakdown",
    "/hrTimeInZones"
  ),
  activityGet(
    "get-activity-polyline",
    "Full-resolution GPS track",
    "/polyline/full-resolution/"
  ),
  activityGet(
    "get-activity-weather",
    "Weather conditions during the activity",
    "/weather"
  ),

  // Fitness & Records
  {
    name: "get-weight",
    group: "Fitness & Records",
    description: "Weight measurements over a date range",
    needsAuth: true,
    params: [
      { name: "startDate", type: "date", required: true },
      { name: "endDate", type: "date", required: true },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(
          `weight-service/weight/range/${reqStr(ctx, "startDate")}/${reqStr(ctx, "endDate")}`,
          { includeAll: "true" }
        ),
  },
  {
    name: "get-personal-records",
    group: "Fitness & Records",
    description: "All personal records with history",
    needsAuth: true,
    params: [],
    run: async (ctx) => {
      const client = ctx.requireClient();
      const displayName = await client.getDisplayName();
      return client.get(
        `personalrecord-service/personalrecord/prs/${displayName}`,
        { includeHistory: "true" }
      );
    },
  },
  {
    name: "get-fitness-stats",
    group: "Fitness & Records",
    description: "Aggregated activity stats by type over a date range",
    needsAuth: true,
    params: [
      { name: "startDate", type: "date", required: true },
      { name: "endDate", type: "date", required: true },
      {
        name: "aggregation",
        type: "enum",
        required: false,
        default: "daily",
        enumValues: ["daily", "weekly", "monthly"],
      },
      {
        name: "metric",
        type: "enum",
        required: false,
        default: "duration",
        enumValues: ["duration", "distance", "calories"],
      },
    ],
    run: (ctx) =>
      ctx.requireClient().get("fitnessstats-service/activity", {
        aggregation: optStr(ctx, "aggregation") ?? "daily",
        startDate: reqStr(ctx, "startDate"),
        endDate: reqStr(ctx, "endDate"),
        groupByActivityType: "true",
        standardizedUnits: "true",
        groupByParentActivityType: "false",
        userFirstDay: "sunday",
        metric: optStr(ctx, "metric") ?? "duration",
      }),
  },
  {
    name: "get-hr-zones-config",
    group: "Fitness & Records",
    description: "Configured heart rate zone boundaries",
    needsAuth: true,
    params: [],
    run: (ctx) => ctx.requireClient().get("biometric-service/heartRateZones/"),
  },
  {
    name: "get-power-zones",
    group: "Fitness & Records",
    description: "Power zone configuration for all sports",
    needsAuth: true,
    params: [],
    run: (ctx) =>
      ctx.requireClient().get("biometric-service/powerZones/sports/all"),
  },

  // Calendar, Goals & Badges
  {
    name: "get-calendar",
    group: "Calendar & Goals",
    description: "Monthly calendar with activities and events",
    needsAuth: true,
    params: [
      {
        name: "year",
        type: "number",
        required: true,
        description: "e.g. 2026",
      },
      {
        name: "month",
        type: "number",
        required: true,
        description: "0-11 (0=January, 11=December)",
      },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(
          `calendar-service/year/${numArg(ctx, "year", new Date().getUTCFullYear())}/month/${numArg(ctx, "month", new Date().getUTCMonth())}`
        ),
  },
  {
    name: "get-goals",
    group: "Calendar & Goals",
    description: "Fitness goals",
    needsAuth: true,
    params: [
      {
        name: "status",
        type: "enum",
        required: false,
        default: "active",
        enumValues: ["active", "future", "past"],
      },
    ],
    run: (ctx) =>
      ctx.requireClient().get("goal-service/goal/goals", {
        status: optStr(ctx, "status") ?? "active",
      }),
  },
  {
    name: "get-badges",
    group: "Calendar & Goals",
    description: "All earned badges/achievements",
    needsAuth: true,
    params: [],
    run: (ctx) => ctx.requireClient().get("badge-service/badge/earned"),
  },
  {
    name: "get-badge-leaderboard",
    group: "Calendar & Goals",
    description: "Badge leaderboard among your connections",
    needsAuth: true,
    params: [{ name: "limit", type: "number", required: false, default: 25 }],
    run: (ctx) =>
      ctx.requireClient().get("badge-service/badge/leaderboard", {
        limit: numArg(ctx, "limit", 25),
      }),
  },
  {
    name: "get-sleep-stats",
    group: "Fitness & Records",
    description: "Sleep statistics over a date range (averages, trends)",
    needsAuth: true,
    params: [
      { name: "startDate", type: "date", required: true },
      { name: "endDate", type: "date", required: true },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(
          `sleep-service/stats/sleep/daily/${reqStr(ctx, "startDate")}/${reqStr(ctx, "endDate")}`
        ),
  },

  // Workouts
  {
    name: "list-workouts",
    group: "Workouts",
    description: "List your saved workouts",
    needsAuth: true,
    params: [
      { name: "start", type: "number", required: false, default: 0 },
      { name: "limit", type: "number", required: false, default: 100 },
    ],
    run: (ctx) =>
      ctx.requireClient().get("workout-service/workouts", {
        start: numArg(ctx, "start", 0),
        limit: numArg(ctx, "limit", 100),
      }),
  },
  {
    name: "get-workout",
    group: "Workouts",
    description: "A single workout with full step/segment details",
    needsAuth: true,
    params: [{ name: "workoutId", type: "string", required: true }],
    run: (ctx) =>
      ctx
        .requireClient()
        .get(`workout-service/workout/${reqStr(ctx, "workoutId")}`),
  },
  {
    name: "create-workout",
    group: "Workouts",
    description:
      "Create a workout from a JSON definition (see MCP docs for format)",
    needsAuth: true,
    params: [
      {
        name: "workout",
        type: "string",
        required: true,
        description: "JSON string of the workout object",
      },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .post("workout-service/workout", JSON.parse(reqStr(ctx, "workout"))),
  },
  {
    name: "schedule-workout",
    group: "Workouts",
    description: "Schedule a workout to a date (syncs to device)",
    needsAuth: true,
    params: [
      { name: "workoutId", type: "string", required: true },
      { name: "date", type: "date", required: true },
    ],
    run: (ctx) =>
      ctx
        .requireClient()
        .post(`workout-service/schedule/${reqStr(ctx, "workoutId")}`, {
          date: reqStr(ctx, "date"),
        }),
  },
  {
    name: "delete-workout",
    group: "Workouts",
    description: "Delete a workout",
    needsAuth: true,
    params: [{ name: "workoutId", type: "string", required: true }],
    run: async (ctx) => {
      await ctx
        .requireClient()
        .delete(`workout-service/workout/${reqStr(ctx, "workoutId")}`);
      return { deleted: reqStr(ctx, "workoutId") };
    },
  },

  // Habit Journal (local; analyze-* also hit Garmin)
  {
    name: "list-habits",
    group: "Habit Journal",
    description: "List all custom habits you've defined",
    needsAuth: false,
    params: [],
    run: async () => ({ habits: loadJournal().habits }),
  },
  {
    name: "add-habit",
    group: "Habit Journal",
    description: "Define a custom habit (boolean yes/no, or numeric)",
    needsAuth: false,
    params: [
      { name: "name", type: "string", required: true },
      {
        name: "type",
        type: "enum",
        required: false,
        default: "boolean",
        enumValues: ["boolean", "numeric"],
      },
      { name: "description", type: "string", required: false },
    ],
    run: async (ctx) => ({
      created: addHabit({
        name: reqStr(ctx, "name"),
        type: (optStr(ctx, "type") ?? "boolean") as "boolean" | "numeric",
        description: optStr(ctx, "description"),
        createdAt: ctx.today,
      }),
    }),
  },
  {
    name: "log-habit",
    group: "Habit Journal",
    description: "Record a habit's value for a day (defaults to today)",
    needsAuth: false,
    params: [
      { name: "habit", type: "string", required: true },
      {
        name: "value",
        type: "string",
        required: true,
        description: "yes/no for boolean habits, or a number",
      },
      P_DATE,
    ],
    run: async (ctx) => {
      const res = logHabit(reqStr(ctx, "habit"), dateArg(ctx), ctx.args.value);
      return {
        logged: {
          habit: res.habit.name,
          date: res.date,
          value: res.value,
        },
      };
    },
  },
  {
    name: "unlog-habit",
    group: "Habit Journal",
    description: "Remove a habit's value for a specific day",
    needsAuth: false,
    params: [
      { name: "habit", type: "string", required: true },
      { name: "date", type: "date", required: true },
    ],
    run: async (ctx) => {
      const res = unlogHabit(reqStr(ctx, "habit"), reqStr(ctx, "date"));
      return { removed: { habit: res.habit.name, date: res.date } };
    },
  },
  {
    name: "delete-habit",
    group: "Habit Journal",
    description: "Delete a habit (and optionally its logged values)",
    needsAuth: false,
    params: [
      { name: "habit", type: "string", required: true },
      { name: "purgeEntries", type: "boolean", required: false, default: true },
    ],
    run: async (ctx) => {
      const res = deleteHabit(
        reqStr(ctx, "habit"),
        boolArg(ctx, "purgeEntries", true)
      );
      return { deleted: res.habit, entriesRemoved: res.entriesRemoved };
    },
  },
  {
    name: "get-journal",
    group: "Habit Journal",
    description: "Show logged habit entries over a date range",
    needsAuth: false,
    params: [P_RANGE_START, P_RANGE_END],
    run: async (ctx) => {
      const data = loadJournal();
      const end = optStr(ctx, "endDate") ?? ctx.today;
      const start = optStr(ctx, "startDate") ?? daysAgoIso(30);
      const dates = loggedDates(data, start, end);
      return {
        startDate: start,
        endDate: end,
        habits: data.habits.map((h) => ({
          id: h.id,
          name: h.name,
          type: h.type,
        })),
        entries: dates.map((d) => ({ date: d, values: data.entries[d] })),
      };
    },
  },
  {
    name: "analyze-habit",
    group: "Habit Journal",
    description:
      "Correlate ONE habit with a recovery metric (t-test / correlation)",
    needsAuth: true,
    params: [
      { name: "habit", type: "string", required: true },
      P_METRIC,
      P_RANGE_START,
      P_RANGE_END,
    ],
    run: async (ctx) => {
      const data = loadJournal();
      const habit = findHabit(data, reqStr(ctx, "habit"));
      if (!habit)
        throw new Error(`No habit matching "${reqStr(ctx, "habit")}".`);
      const metric = optStr(ctx, "metric") ?? DEFAULT_METRIC;
      const metricDef = getMetric(metric);
      const end = optStr(ctx, "endDate") ?? ctx.today;
      const start = optStr(ctx, "startDate") ?? daysAgoIso(60);
      const habitDates = loggedDates(data, start, end).filter(
        (d) => habit.id in data.entries[d]
      );
      if (habitDates.length === 0) {
        throw new Error(
          `No logged days for "${habit.name}" between ${start} and ${end}.`
        );
      }
      const series = await fetchMetricSeries(
        ctx.requireClient(),
        metric,
        habitDates
      );
      const result = analyzeHabit(data, habit, metricDef, series, start, end);
      return { ...result, text: formatDetailed(result, metricDef) };
    },
  },
  {
    name: "analyze-habits",
    group: "Habit Journal",
    description: "Rank ALL habits by their effect on a recovery metric",
    needsAuth: true,
    params: [P_METRIC, P_RANGE_START, P_RANGE_END],
    run: async (ctx) => {
      const data = loadJournal();
      if (data.habits.length === 0) throw new Error("No habits defined yet.");
      const metric = optStr(ctx, "metric") ?? DEFAULT_METRIC;
      const metricDef = getMetric(metric);
      const end = optStr(ctx, "endDate") ?? ctx.today;
      const start = optStr(ctx, "startDate") ?? daysAgoIso(60);
      const dates = loggedDates(data, start, end);
      if (dates.length === 0) {
        throw new Error(`No logged habit days between ${start} and ${end}.`);
      }
      const series = await fetchMetricSeries(
        ctx.requireClient(),
        metric,
        dates
      );
      const results = data.habits.map((h) =>
        analyzeHabit(data, h, metricDef, series, start, end)
      );
      const coverage = [...series.values()].filter((v) => v != null).length;
      return {
        metric,
        metricLabel: metricDef.label,
        unit: metricDef.unit,
        higherIsBetter: metricDef.higherIsBetter,
        startDate: start,
        endDate: end,
        loggedDays: dates.length,
        metricCoverage: coverage,
        results,
      };
    },
  },
];

export const COMMAND_MAP: Map<string, CommandDef> = new Map(
  COMMANDS.map((c) => [c.name, c])
);

/** Serializable view of the registry (no `run`) for the web UI. */
export function serializeCommands(): Array<Omit<CommandDef, "run">> {
  return COMMANDS.map(({ run: _run, ...rest }) => rest);
}
