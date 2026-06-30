// Local habit journal — the storage half of the Whoop-style "how does this
// behavior affect my recovery" feature.
//
// Garmin has no public API for arbitrary daily notes, so habits and their daily
// values live in a local JSON file next to the saved session, at
// ~/.garmin-connect-mcp/journal.json. The analysis tools then pull recovery
// metrics from Garmin per date and join them against this log.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSessionDir } from "./garmin-client.js";

export type HabitType = "boolean" | "numeric";
export type HabitValue = boolean | number;

export interface Habit {
  id: string; // slug, stable key used in entries
  name: string; // human label as the user typed it
  type: HabitType;
  description?: string;
  createdAt: string; // YYYY-MM-DD
}

export interface JournalData {
  habits: Habit[];
  // entries[date][habitId] = value
  entries: Record<string, Record<string, HabitValue>>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function journalFile(): string {
  return join(getSessionDir(), "journal.json");
}

export function getJournalFile(): string {
  return journalFile();
}

export function loadJournal(): JournalData {
  const file = journalFile();
  if (!existsSync(file)) {
    return { habits: [], entries: {} };
  }
  const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<JournalData>;
  return { habits: data.habits ?? [], entries: data.entries ?? {} };
}

export function saveJournal(data: JournalData): void {
  const dir = getSessionDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(journalFile(), JSON.stringify(data, null, 2));
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new Error(`Invalid date "${date}". Use YYYY-MM-DD.`);
  }
}

/** Return a shallow copy of `obj` without `key` (avoids dynamic `delete`). */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/** Resolve a habit by exact id, slug, or case-insensitive name. */
export function findHabit(
  data: JournalData,
  idOrName: string
): Habit | undefined {
  const needle = idOrName.trim().toLowerCase();
  const slug = slugify(idOrName);
  return data.habits.find(
    (h) => h.id === idOrName || h.id === slug || h.name.toLowerCase() === needle
  );
}

export function addHabit(opts: {
  name: string;
  type: HabitType;
  description?: string;
  createdAt: string;
}): Habit {
  const data = loadJournal();
  const id = slugify(opts.name);
  if (!id) {
    throw new Error(`Habit name "${opts.name}" produces an empty id.`);
  }
  if (data.habits.some((h) => h.id === id)) {
    throw new Error(
      `A habit with id "${id}" already exists. Pick a different name or delete the existing one.`
    );
  }
  const habit: Habit = {
    id,
    name: opts.name.trim(),
    type: opts.type,
    description: opts.description?.trim() || undefined,
    createdAt: opts.createdAt,
  };
  data.habits.push(habit);
  saveJournal(data);
  return habit;
}

export function deleteHabit(
  idOrName: string,
  purgeEntries: boolean
): { habit: Habit; entriesRemoved: number } {
  const data = loadJournal();
  const habit = findHabit(data, idOrName);
  if (!habit) {
    throw new Error(`No habit found matching "${idOrName}".`);
  }
  data.habits = data.habits.filter((h) => h.id !== habit.id);
  let entriesRemoved = 0;
  if (purgeEntries) {
    for (const date of Object.keys(data.entries)) {
      if (habit.id in data.entries[date]) {
        data.entries[date] = omitKey(data.entries[date], habit.id);
        entriesRemoved++;
        if (Object.keys(data.entries[date]).length === 0) {
          data.entries = omitKey(data.entries, date);
        }
      }
    }
  }
  saveJournal(data);
  return { habit, entriesRemoved };
}

/** Coerce a loosely-typed input value to the habit's declared type. */
export function coerceValue(habit: Habit, raw: unknown): HabitValue {
  if (habit.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
      const v = raw.trim().toLowerCase();
      if (["true", "yes", "y", "1", "done"].includes(v)) return true;
      if (["false", "no", "n", "0", "skip", "skipped"].includes(v))
        return false;
    }
    throw new Error(
      `Habit "${habit.name}" is boolean; value must be yes/no (got ${JSON.stringify(raw)}).`
    );
  }
  // numeric
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!isFinite(num)) {
    throw new Error(
      `Habit "${habit.name}" is numeric; value must be a number (got ${JSON.stringify(raw)}).`
    );
  }
  return num;
}

export function logHabit(
  idOrName: string,
  date: string,
  rawValue: unknown
): { habit: Habit; date: string; value: HabitValue } {
  assertDate(date);
  const data = loadJournal();
  const habit = findHabit(data, idOrName);
  if (!habit) {
    throw new Error(
      `No habit found matching "${idOrName}". Create it first with add-habit.`
    );
  }
  const value = coerceValue(habit, rawValue);
  if (!data.entries[date]) data.entries[date] = {};
  data.entries[date][habit.id] = value;
  saveJournal(data);
  return { habit, date, value };
}

export function unlogHabit(
  idOrName: string,
  date: string
): { habit: Habit; date: string } {
  assertDate(date);
  const data = loadJournal();
  const habit = findHabit(data, idOrName);
  if (!habit) throw new Error(`No habit found matching "${idOrName}".`);
  if (data.entries[date]) {
    data.entries[date] = omitKey(data.entries[date], habit.id);
    if (Object.keys(data.entries[date]).length === 0) {
      data.entries = omitKey(data.entries, date);
    }
  }
  saveJournal(data);
  return { habit, date };
}

export interface DatedValue {
  date: string;
  value: HabitValue;
}

/** All logged values for one habit, within [startDate, endDate], date-sorted. */
export function habitSeries(
  data: JournalData,
  habitId: string,
  startDate: string,
  endDate: string
): DatedValue[] {
  assertDate(startDate);
  assertDate(endDate);
  const out: DatedValue[] = [];
  for (const [date, byHabit] of Object.entries(data.entries)) {
    if (date < startDate || date > endDate) continue;
    if (habitId in byHabit) out.push({ date, value: byHabit[habitId] });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Every date that has at least one logged habit, within the range. */
export function loggedDates(
  data: JournalData,
  startDate: string,
  endDate: string
): string[] {
  assertDate(startDate);
  assertDate(endDate);
  return Object.keys(data.entries)
    .filter((d) => d >= startDate && d <= endDate)
    .sort();
}
