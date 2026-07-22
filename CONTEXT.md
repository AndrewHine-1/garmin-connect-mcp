# Domain glossary

Shared language for this repo's habit-and-recovery analysis. Use these terms in
code, comments, and reviews so the same idea always has the same name.

## Habit journal

- **Habit** — something the user logs about a day: boolean (did it / didn't) or
  numeric (a quantity, e.g. caffeine mg). Defined in `journal.ts`.
- **Behavior-day (D)** — the calendar day (YYYY-MM-DD) a habit was logged for.
  All confounders are read at D.
- **Outcome** — a recovery metric a habit might move: Training Readiness, Sleep
  Score, or Average Stress. Registered in `recovery-metrics.ts`.
- **Lag** — days between a behavior-day and when its outcome is stamped. Garmin
  records overnight metrics under the wake date, so behavior on D shows up at
  **D+1** (lag 1); same-day stress is **D+0**. Lives on each metric as `lagDays`.
- **Confounder** — a variable held constant so a habit's effect is isolated:
  **alcohol** (drinks that day), **weekend** (Sat/Sun), and **training load**
  (summed activity load that day; a missing day is a rest day = 0).

## Analysis

- **Observation** — one behavior-day joined to its confounders (read at D) and
  its outcome (read at D+lag): `{ habit, alcohol, weekend, load, y }`. The join
  and its listwise-deletion rules live in one place, `observations.ts`
  (`alignObservations`). A day survives only if its outcome is present (and its
  alcohol value, when adjusting for alcohol).
- **Isolated effect** — a habit's own regression coefficient with the
  confounders held constant, reported as a signed percentage of the outcome's
  mean (`+` always means "better"; stress is sign-flipped). Fitted by `regress`
  in `stats.ts`, which addresses coefficients by name.
- **Confidence tier** — the honesty gate on a cell: `ok` / `weak` / `none`,
  derived from usable-day counts and the coefficient's p-value (`analysis.ts`).
