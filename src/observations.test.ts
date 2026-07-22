import test from "node:test";
import assert from "node:assert/strict";
import { alignObservations, isWeekend, toNum } from "./observations.js";
import type { DatedValue } from "./journal.js";

test("joins a habit at D to its outcome at D+lag", () => {
  const days: DatedValue[] = [{ date: "2026-01-05", value: 3 }]; // Monday
  const series = new Map<string, number | null>([["2026-01-06", 80]]); // D+1
  const rows = alignObservations(days, { series, lag: 1 }, { load: new Map() });
  assert.deepEqual(rows, [
    { habit: 3, alcohol: 0, weekend: 0, load: 0, y: 80 },
  ]);
});

test("drops a day whose outcome is missing at D+lag", () => {
  const days: DatedValue[] = [
    { date: "2026-01-05", value: true }, // needs y@01-06 (present)
    { date: "2026-01-06", value: true }, // needs y@01-07 (missing)
    { date: "2026-01-07", value: true }, // needs y@01-08 (present but null)
  ];
  const series = new Map<string, number | null>([
    ["2026-01-06", 70],
    ["2026-01-08", null],
  ]);
  const rows = alignObservations(days, { series, lag: 1 }, { load: new Map() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].y, 70);
  assert.equal(rows[0].habit, 1); // true -> 1
});

test("reads load at D and defaults a missing day to 0", () => {
  const days: DatedValue[] = [
    { date: "2026-01-05", value: 1 },
    { date: "2026-01-06", value: 1 },
  ];
  const series = new Map<string, number | null>([
    ["2026-01-05", 50],
    ["2026-01-06", 60],
  ]);
  const load = new Map<string, number>([["2026-01-05", 120]]); // 01-06 absent
  const rows = alignObservations(days, { series, lag: 0 }, { load });
  assert.equal(rows[0].load, 120);
  assert.equal(rows[1].load, 0); // rest day
});

test("requires alcohol only when its map is supplied", () => {
  const days: DatedValue[] = [
    { date: "2026-01-05", value: 1 },
    { date: "2026-01-06", value: 1 },
  ];
  const series = new Map<string, number | null>([
    ["2026-01-05", 50],
    ["2026-01-06", 60],
  ]);
  const alcohol = new Map<string, number>([["2026-01-05", 2]]); // 01-06 missing

  const withAlc = alignObservations(
    days,
    { series, lag: 0 },
    { alcohol, load: new Map() }
  );
  assert.equal(withAlc.length, 1); // 01-06 dropped for missing alcohol
  assert.equal(withAlc[0].alcohol, 2);

  const noAlc = alignObservations(
    days,
    { series, lag: 0 },
    { load: new Map() }
  );
  assert.equal(noAlc.length, 2); // nothing dropped on alcohol's account
  assert.equal(noAlc[0].alcohol, 0);
  assert.equal(noAlc[1].alcohol, 0);
});

test("isWeekend flags Saturday and Sunday", () => {
  assert.equal(isWeekend("2026-01-03"), 1); // Sat
  assert.equal(isWeekend("2026-01-04"), 1); // Sun
  assert.equal(isWeekend("2026-01-05"), 0); // Mon
});

test("toNum maps booleans and passes numbers through", () => {
  assert.equal(toNum(true), 1);
  assert.equal(toNum(false), 0);
  assert.equal(toNum(4.2), 4.2);
});
