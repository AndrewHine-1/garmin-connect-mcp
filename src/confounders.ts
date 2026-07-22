import type { GarminClient } from "./garmin-client.js";

/**
 * Per-day training load, used by the habit-impact feature to control for "how
 * hard did I train that day" as a confounder.
 *
 * The number for a given date is the sum of `activityTrainingLoad` across all
 * activities whose local start date falls on that date. Every requested date is
 * present in the returned map; a date with no activity (or only null-load
 * activities) maps to 0.
 */

/** Number of activities requested per page from the activity-search endpoint. */
const PAGE_LIMIT = 100;

/**
 * Safety cap on pagination so a bad request window (or an unexpectedly busy
 * account) can't loop forever. A few pages of 100 activities each covers far
 * more history than any realistic multi-week window needs.
 */
const MAX_PAGES = 5;

interface ActivitySummary {
  activityTrainingLoad: number | null;
  startTimeLocal: string;
}

/** Extract the local "YYYY-MM-DD" date from a Garmin `startTimeLocal` string. */
function localDate(startTimeLocal: string): string {
  return startTimeLocal.slice(0, 10);
}

/**
 * Fetch the summed daily training load for each requested date.
 *
 * @param client GarminClient used to reach the activity-search endpoint.
 * @param dates the "YYYY-MM-DD" dates to report on; order is irrelevant.
 * @returns map of "YYYY-MM-DD" -> summed activityTrainingLoad, containing an
 *   entry for every date in `dates` (0 when that day had no activity load).
 */
export async function fetchDailyTrainingLoad(
  client: GarminClient,
  dates: string[]
): Promise<Map<string, number>> {
  // Seed every requested date at 0 so the map always covers the full request,
  // and lookups elsewhere can treat "present but 0" as a genuine rest day.
  const loadByDate = new Map<string, number>();
  for (const date of dates) loadByDate.set(date, 0);

  if (dates.length === 0) return loadByDate;

  // Earliest date we care about; we page backwards until activities reach it.
  const earliestRequested = dates.reduce((a, b) => (b < a ? b : a));

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * PAGE_LIMIT;
    const raw = await client.get(
      "activitylist-service/activities/search/activities",
      { limit: PAGE_LIMIT, start }
    );

    const activities = Array.isArray(raw) ? (raw as ActivitySummary[]) : [];
    // No activities left in the history — nothing more to page through.
    if (activities.length === 0) break;

    // Activities come back newest-first; track the oldest date on this page so
    // we know whether we still need to reach further back.
    let oldestOnPage: string | null = null;

    for (const activity of activities) {
      const { startTimeLocal, activityTrainingLoad } = activity;
      if (!startTimeLocal) continue;

      const date = localDate(startTimeLocal);
      if (oldestOnPage === null || date < oldestOnPage) oldestOnPage = date;

      // Only accumulate for dates the caller asked about.
      if (loadByDate.has(date)) {
        const load =
          typeof activityTrainingLoad === "number" ? activityTrainingLoad : 0;
        loadByDate.set(date, (loadByDate.get(date) ?? 0) + load);
      }
    }

    // Continue only while the oldest activity seen is still newer than the
    // earliest requested date AND the page was full (more history may exist).
    const needOlder = oldestOnPage !== null && oldestOnPage > earliestRequested;
    const pageWasFull = activities.length === PAGE_LIMIT;
    if (!needOlder || !pageWasFull) break;
  }

  return loadByDate;
}
