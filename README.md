# garmin-connect-mcp

[![CI](https://github.com/etweisberg/garmin-connect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/etweisberg/garmin-connect-mcp/actions/workflows/ci.yml)
[![Release](https://github.com/etweisberg/garmin-connect-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/etweisberg/garmin-connect-mcp/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@etweisberg/garmin-connect-mcp)](https://www.npmjs.com/package/@etweisberg/garmin-connect-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@etweisberg/garmin-connect-mcp)](https://www.npmjs.com/package/@etweisberg/garmin-connect-mcp)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

MCP server for Garmin Connect. Access your activities, health stats, sleep data, FIT files, and more from Claude Code or any MCP client.

## Why This Exists

In March 2026, Garmin changed their authentication API, breaking [garth](https://github.com/matin/garth) and [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) — the two most popular libraries for accessing Garmin data programmatically. Garth has been [officially deprecated](https://github.com/matin/garth/discussions/222). Garmin added Cloudflare TLS fingerprinting that blocks all non-browser HTTP clients (Node.js `fetch`, Python `requests`, `curl`) from their API endpoints.

This project works around that by routing all API calls through a headless Playwright browser, inheriting a real Chrome TLS fingerprint. Authentication uses browser cookies captured from a manual login session.

## Install

```bash
npm install -g @etweisberg/garmin-connect-mcp
npx playwright install chromium
```

Then register with Claude Code:

```bash
claude mcp add garmin -- npx @etweisberg/garmin-connect-mcp
```

You also need the Playwright MCP server for the login flow:

```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

### Prerequisites

- Node.js 18+
- Playwright MCP server (for browser-based login)
- A Garmin Connect account with a synced device

## Setup

### 1. Login

In Claude Code, call the `garmin-login` tool. It will walk you through:

1. Opening Garmin Connect in the Playwright browser
2. Logging in manually
3. Extracting cookies and CSRF token
4. Saving the session to `~/.garmin-connect-mcp/session.json`

### 2. Verify

Call the `check-session` tool to confirm authentication works.

Session cookies expire after a few hours. Re-run the login flow when they do.

## Available Tools

### Session & Auth

| Tool            | Description                                               |
| --------------- | --------------------------------------------------------- |
| `garmin-login`  | Returns login instructions for the Playwright MCP browser |
| `check-session` | Validates the saved session is still active               |
| `run-tests`     | Returns a test plan to verify all tools work              |

### Activities

| Tool                    | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `list-activities`       | List activities with pagination                          |
| `get-activity`          | Full activity summary (distance, duration, HR, calories) |
| `get-activity-details`  | Time-series metrics (HR, cadence, elevation over time)   |
| `get-activity-splits`   | Lap/split data                                           |
| `get-activity-hr-zones` | Heart rate time-in-zone breakdown                        |
| `get-activity-polyline` | Full-resolution GPS track                                |
| `get-activity-weather`  | Weather conditions during activity                       |
| `download-fit`          | Download original FIT file                               |

### Daily Health

| Tool                          | Description                                  |
| ----------------------------- | -------------------------------------------- |
| `get-daily-summary`           | Steps, calories, distance, intensity minutes |
| `get-daily-heart-rate`        | Heart rate data throughout the day           |
| `get-daily-stress`            | Stress levels throughout the day             |
| `get-daily-summary-chart`     | Combined wellness chart data                 |
| `get-daily-intensity-minutes` | Intensity minutes for a date                 |
| `get-daily-movement`          | Movement/activity data                       |
| `get-daily-respiration`       | Respiration rate data                        |

### Sleep / Body Battery / HRV

| Tool               | Description                         |
| ------------------ | ----------------------------------- |
| `get-sleep`        | Sleep score, duration, stages, SpO2 |
| `get-body-battery` | Body battery charged/drained values |
| `get-hrv`          | Heart rate variability data         |

### Training & Recovery

| Tool                     | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `get-training-readiness` | Training readiness score (sleep, recovery, load) |
| `get-sleep-stats`        | Sleep statistics over a date range               |
| `get-hydration`          | Daily hydration/water intake data                |

### Weight / Records / Fitness

| Tool                   | Description                           |
| ---------------------- | ------------------------------------- |
| `get-weight`           | Weight measurements over a date range |
| `get-personal-records` | All personal records with history     |
| `get-fitness-stats`    | Aggregated activity stats by type     |
| `get-vo2max`           | Latest VO2 Max estimate               |
| `get-hr-zones-config`  | Heart rate zone boundaries            |
| `get-power-zones`      | Power zone config for all sports      |
| `get-user-profile`     | User profile and settings             |

### Calendar, Goals & Badges

| Tool                    | Description                                 |
| ----------------------- | ------------------------------------------- |
| `get-calendar`          | Monthly calendar with activities and events |
| `get-goals`             | Active, future, or past fitness goals       |
| `get-badges`            | All earned badges/achievements              |
| `get-badge-leaderboard` | Badge leaderboard among connections         |

### Workouts

| Tool                   | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `list-workouts`        | List saved workouts                                |
| `get-workout`          | Get workout details (steps, segments)              |
| `create-workout`       | Create a new workout (warmup, intervals, cooldown) |
| `schedule-workout`     | Schedule a workout to a date (syncs to device)     |
| `delete-workout`       | Delete a workout                                   |
| `download-workout-fit` | Download a workout as a FIT file                   |

### Habit Journal (recovery insights)

| Tool             | Description                                                      |
| ---------------- | --------------------------------------------------------------- |
| `add-habit`      | Define a custom habit (boolean yes/no, or numeric)              |
| `list-habits`    | List your defined habits                                        |
| `delete-habit`   | Delete a habit (and optionally its logged values)               |
| `log-habit`      | Record a habit's value for a day (defaults to today)            |
| `unlog-habit`    | Remove a habit's value for a day                                |
| `get-journal`    | Show logged habit entries over a date range                     |
| `analyze-habit`  | Correlate ONE habit with a recovery metric (t-test/correlation) |
| `analyze-habits` | Rank ALL habits by their effect on a recovery metric            |

## Habit Journal

A [Whoop Journal](https://www.whoop.com/)-style feature: track any daily habit you
name yourself, then see how it correlates with your recovery.

**Define your own habits** — anything, e.g. `Alcohol`, `Caffeine (mg)`,
`Magnesium`, `Screen before bed`, `Ate late`. Each habit is either:

- **boolean** — a yes/no behavior (`add-habit name:"Alcohol" type:boolean`)
- **numeric** — a quantity or 1–10 scale (`add-habit name:"Caffeine (mg)" type:numeric`)

**Log daily** — `log-habit habit:"Alcohol" value:yes` (defaults to today, or pass
`date:YYYY-MM-DD`). Numeric: `log-habit habit:"Caffeine (mg)" value:120`.

**Get insights** — `analyze-habit habit:"Alcohol"` pulls a recovery metric from
Garmin for each logged day and runs a proper test:

- boolean habits → Welch's two-sample t-test (habit days vs. non-habit days)
- numeric habits → Pearson correlation

It reports the effect size, % change, and a confidence level (high/medium/low),
e.g. _"On days you did Alcohol, your Training Readiness was 23 points lower
(−29%), confidence: high"_. Use `analyze-habits` for a ranked overview of every
habit at once.

**Timing — log a habit on the day you did it.** Garmin stamps a night's sleep
and the morning recovery metrics derived from it with the **wake-up date**, so a
behavior on day _D_ shows up in the recovery reported on the morning of _D+1_.
The analysis handles this for you: overnight metrics (training readiness, sleep
score, HRV, resting HR) are matched to the **next morning's** value, while
same-day stress is matched to the same day. So you just log what you did when you
did it — e.g. log "Alcohol" the night you drink, and it's correlated against the
next morning's readiness. (A habit logged today won't have a result until
tomorrow's recovery syncs.)

**Recovery metrics** (choose with `metric:`): `training_readiness` (default,
Garmin's closest analog to a Whoop recovery score), `sleep_score`, `hrv`,
`resting_hr`, `stress_avg`. For `resting_hr` and `stress_avg`, lower is better —
the analysis accounts for this automatically and still reports the direction in
terms of recovery.

**Storage** — habits and daily values are stored locally in
`~/.garmin-connect-mcp/journal.json` (the same folder as your session). Defining
and logging habits needs no Garmin login; only the `analyze-*` tools call Garmin.
Because the data lives on disk, it's identical whether you use Claude Code or
Claude Desktop.

> Correlation isn't causation, and small samples are noisy — log consistently
> for a few weeks before trusting a signal. The confidence label is based on the
> p-value of the test.

## Dashboard (Cadence)

A local web dashboard that wraps the same commands in a visual UI — a Whoop/Oura-style
recovery cockpit with the habit journal as the flagship. It runs as a tiny Node HTTP
server bound to `127.0.0.1` (no external deps) and serves a single page.

```bash
npm run build
npm run dashboard          # opens http://127.0.0.1:8765 in your browser
# or: node dist/index.js dashboard
```

What it gives you:

- **Auto-login** — an auth pill in the top bar. Click it (or trigger any command that
  needs Garmin) and a real browser opens; finish logging in and the dashboard captures
  your session automatically, then retries what you were doing. No terminal step.
- **Today** — a Training Readiness ring (PRIMED / STEADY / STRAINED) with a one-line
  coach read, and an above-the-fold habit logger (tap Yes/No or type a number; autosaves).
- **Recovery glance** — tiles for Sleep, HRV, Resting HR, Stress. Click a tile to
  re-target the correlation table against that metric.
- **What's moving your recovery** — the `analyze-habits` payoff: a ranked table with
  effect direction, magnitude (% change or Pearson r), and a confidence dot-meter;
  low-confidence rows are dimmed with a "needs N more days" nudge.
- **History & streaks** — a 30-day grid of your logged habits (local data, no API).
- **Command Console** — a collapsible panel that exposes every read command and habit
  action with an auto-generated, typed parameter form, Pretty/Raw result tabs, copy +
  download, and a re-runnable session log. The friendly sections call these same commands.

Config: `GARMIN_DASHBOARD_PORT` (default `8765`), `GARMIN_DASHBOARD_NO_OPEN=1` to skip
auto-opening the browser. Data and session live in `~/.garmin-connect-mcp/`, shared with
the MCP server — so logging a habit in the dashboard shows up for Claude too.

### Coach (readiness-aware workouts → intervals.icu)

The Coach section turns the morning's Garmin stats into the day's training:

1. **Set your training block** (base / build / peak / taper / recovery) — persisted in
   `~/.garmin-connect-mcp/coach-settings.json` and overwritten on each save.
2. **Pick today's sport(s)** — Run, Trail Run, Bike, Swim, Lift — in priority order.
   The first sport gets the readiness-driven session; later ones are stepped down an
   intensity level so the combined day stays absorbable.
3. **Generate** — readiness (or sleep score as fallback) maps to a tier:
   ≥67 → quality session (flavor set by your block: tempo/sweet-spot in base,
   threshold in build, VO2/race-pace in peak, openers in taper), 34–66 → steady
   endurance, <34 → recovery. Each card shows the workout in intervals.icu
   workout-builder text. Cardio steps target an **HR zone** written
   `<duration|distance> <name> zN hr` (e.g. `- 8m hard z4 hr`,
   `- 50mtr build z2 hr`, ranges as `z2-z4 hr`); rests are `<dur> rest`; repeats
   are a bare `Nx` header with `- child` lines and a blank line before and after.
   Swim distances use `mtr` (`m` = minutes). Weightlifting stays as named time
   blocks (rep scheme in the name using `×`). The readiness rationale is shown on
   the dashboard card only; it is NOT written into the exported workout.
4. **Send to intervals.icu** — one click per workout (or send all) creates planned
   workout events on your calendar for the selected date; the text parses into
   structured steps and syncs wherever intervals.icu pushes.

Each (sport × block × readiness tier) cell holds a **pool of session variants
drawn from professional endurance practice** — e.g. Norwegian double-threshold
10×3 (Ingebrigtsen camp), Seiler 4×8s, Daniels cruise intervals, Canova
alternations and race-pace blocks, Billat 30/30s, Rønnestad 40/20s, classic
2×20s, over-unders, CSS threshold 200s/100s, broken 400s, USRPT 50s, Lydiard
hill work. **Generate picks one at random each time** — hit Generate again to
re-roll a different session at the same intensity. The variant's provenance
shows in the dashboard rationale (never in the exported workout text).

Connect intervals.icu once in the section's settings (athlete ID, e.g. `i599755`,
and an API key from intervals.icu → Settings → Developer). Command console
equivalents: `get-coach-settings`, `set-coach-settings`, `generate-workouts`,
`export-workouts-icu`.

### VO2max trend

The dashboard charts your VO2max over time (3m / 6m / 1y presets) from Garmin's
`maxmet` daily history — running and cycling series when both exist, with a
crosshair tooltip and a data-table fallback. Command console equivalent:
`get-vo2max-history` (fetches in 90-day chunks, returns `{date, running,
cycling}` points).

### Automatic login (optional, unattended)

Garmin web sessions expire after a few hours, so the manual browser login recurs. If you
want it to re-authenticate itself, store your Garmin credentials locally and the dashboard
will re-login on its own whenever the session expires — no window, no clicking.

Provide credentials **either** via environment variables:

```bash
export GARMIN_EMAIL="you@example.com"
export GARMIN_PASSWORD="your-garmin-password"
```

**or** save them to `~/.garmin-connect-mcp/credentials.json` (written with `0600`, owner-only):

```bash
GARMIN_EMAIL="you@example.com" GARMIN_PASSWORD='...' node dist/index.js save-credentials
```

Then the dashboard auto-relogins transparently when a request hits an expired session
(the footer shows "auto-login on"). You can also trigger it directly:

```bash
node dist/index.js login --auto        # unattended, headless
GARMIN_LOGIN_HEADFUL=1 node dist/index.js login --auto   # show the browser (if Cloudflare complains)
```

**Caveats & security:**

- **2FA blocks it.** If your Garmin account has two-factor auth, automated login can't
  enter the code — it detects the 2FA prompt and asks you to use manual login instead.
- Credentials are your real password stored in plaintext on your machine. Keep the file
  `0600`, never commit it (it's git-ignored), and prefer this only on a machine you control.
- If Cloudflare challenges the headless browser, run once with `GARMIN_LOGIN_HEADFUL=1`.

## Architecture

```
Claude Code / MCP Client
        |
        | MCP (stdio)
        v
garmin-connect-mcp server
        |
        | page.evaluate(fetch(...))
        v
Headless Playwright Chromium
        |
        | HTTPS (real Chrome TLS fingerprint)
        v
connect.garmin.com/gc-api/*
```

All API calls are made from within a headless Chromium browser context via `page.evaluate(fetch(...))`. This inherits the real Chrome TLS fingerprint, bypassing Cloudflare's detection of non-browser clients.

**Auth flow**: Cookies + CSRF token are captured from a manual browser login (via the Playwright MCP server) and stored at `~/.garmin-connect-mcp/session.json`. The headless browser loads these cookies on startup.

**Why not direct HTTP?** Cloudflare blocks Node.js `fetch`, Python `requests`, and even `curl` with a 403. Only requests from a real browser TLS stack are accepted.

## Development

```bash
git clone https://github.com/etweisberg/garmin-connect-mcp.git
cd garmin-connect-mcp
npm install
npx playwright install chromium
npm run build
```

### Scripts

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `npm run build`     | Compile TypeScript                             |
| `npm run lint`      | Run ESLint                                     |
| `npm run format`    | Format with Prettier                           |
| `npm run typecheck` | Type check without emitting                    |
| `npm test`          | Run integration tests (requires valid session) |

### Local Integration Testing

The standalone test suite (`npm test`) requires a valid Garmin session and hits the real API. Run it locally after authenticating:

```bash
npm test
```

## Contributing

1. Create a feature branch off `main`
2. Make your changes
3. Run checks:
   ```bash
   npm run lint
   npm run format
   npm run typecheck
   npm run build
   ```
4. **Test via Claude Code**: The recommended way to verify your changes is through Claude Code. After building, call the `run-tests` MCP tool — it returns a test plan that exercises all 27 tools against the live Garmin API. Tell Claude to execute the plan and report results.
5. Open a PR against `main`

CI runs lint, format check, typecheck, and build on every PR. Integration tests run locally only (they require Garmin authentication that can't safely run in CI).

### Releasing

Releases are fully automated. Every merge to `main` triggers the release workflow which:

1. Runs CI (lint, format, typecheck, build)
2. Bumps the patch version
3. Publishes to npm with provenance
4. Creates a GitHub Release

No manual version bumping or tagging needed — just merge your PR.

## License

[AGPL-3.0](LICENSE)
