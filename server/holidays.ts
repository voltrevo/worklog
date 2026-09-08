/**
 * Public holidays, from a source keyed by region (6.31) rather than one that knows about NSW.
 *
 * The source is [Nager.Date](https://date.nager.at) — no key, open source, and it carries the two
 * things the requirements need as *data* rather than as rules we would have to encode: a `counties`
 * array so a state's holidays can be selected (6.8), and a `types` array so a bank holiday that is
 * not a general public holiday can be excluded (6.33). NSW is then 6.32, a default.
 *
 * **A feed nobody here controls is deciding how many hours are in the month**, so the fallbacks
 * matter more than the fetch:
 *
 * - a cache in SQLite (6.6), then a snapshot checked into the repo (6.34);
 * - a failed fetch never silently changes the workday count (6.35) — it falls back and says so;
 * - every fallback logs a warning (6.36) and is reported alongside the figures (6.37), because a
 *   wrong or missing holiday otherwise just shifts the pace by a day with nothing to look at.
 */

import type { Holiday } from "@worklog/shared/types";
import type { Db } from "./db.ts";
import snapshotData from "./data/holidays-AU.json" with { type: "json" };

/** One entry exactly as the feed gives it. Fields we ignore are left off. */
export interface RawHoliday {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
  /** `null` means nationwide. Otherwise ISO 3166-2 subdivision codes. */
  counties: string[] | null;
  types: string[];
}

export type HolidayOrigin = "network" | "cache" | "snapshot" | "none";

export interface HolidayResult {
  holidays: Holiday[];
  origin: HolidayOrigin;
  /** Present whenever `origin` is not `"network"` — the thing 6.36 logs and 6.37 shows. */
  warning?: string;
}

const SNAPSHOT = snapshotData as unknown as Record<string, RawHoliday[]>;

/** How long a cached year is treated as current. A year's holidays barely move; a day is plenty. */
const CACHE_TTL_MS = 24 * 60 * 60_000;

export function countryOf(region: string): string {
  return region.slice(0, 2).toUpperCase();
}

/**
 * Keep the entries that apply to `region` and are genuinely public holidays.
 *
 * Two filters, and both matter. `counties === null` is nationwide and applies everywhere; otherwise
 * the region has to be listed, which is what keeps Victoria's AFL Grand Final holiday out of a NSW
 * month. And `types` must include `Public`: a `Bank` type that is not also `Public` is a bank
 * holiday rather than a general one, which is exactly the distinction 6.33 asks for.
 */
export function selectForRegion(raw: readonly RawHoliday[], region: string): Holiday[] {
  const wanted = region.toUpperCase();
  return raw
    .filter((h) => h.counties === null || h.counties.some((c) => c.toUpperCase() === wanted))
    .filter((h) => h.types.includes("Public"))
    .map((h) => ({ date: h.date, name: h.localName || h.name }))
    // The feed can list one name several times for different states; after the region filter a
    // duplicate date would double-count nothing, but it would show twice in 6.37's list.
    .filter((h, i, all) => all.findIndex((o) => o.date === h.date && o.name === h.name) === i)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface Fetcher {
  (region: string, year: number): Promise<RawHoliday[]>;
}

/** The real one. Separated so tests can drive every fallback without a network. */
export const fetchFromNager: Fetcher = async (region, year) => {
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryOf(region)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`holiday source returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("holiday source did not return a list");
  return body as RawHoliday[];
};

/** `now` is passed in rather than read: the TTL is the thing being tested, so it cannot be the
 * one term that quietly comes from the wall clock. */
function readCache(
  db: Db,
  region: string,
  year: number,
  now: number,
): { raw: RawHoliday[]; age: number } | null {
  const row = db.prepare(
    "SELECT fetched_at, payload_json FROM holiday_cache WHERE region = ? AND year = ?",
  ).get(countryOf(region), year) as { fetched_at: number; payload_json: string } | undefined;
  if (!row) return null;
  try {
    return { raw: JSON.parse(row.payload_json) as RawHoliday[], age: now - row.fetched_at };
  } catch {
    return null;
  }
}

function writeCache(db: Db, region: string, year: number, raw: RawHoliday[], now: number): void {
  db.prepare(
    `INSERT INTO holiday_cache (region, year, fetched_at, payload_json) VALUES (?, ?, ?, ?)
     ON CONFLICT (region, year) DO UPDATE SET fetched_at = excluded.fetched_at,
                                              payload_json = excluded.payload_json`,
  ).run(countryOf(region), year, now, JSON.stringify(raw));
}

export interface LoadOptions {
  db: Db;
  region: string;
  year: number;
  fetcher?: Fetcher;
  now?: number;
  /** Set to skip the network entirely — used when the fetch has already failed this run. */
  offline?: boolean;
}

/**
 * The holidays for one region and year, from the freshest source that works.
 *
 * The cache is consulted *first* and short-circuits the network while it is fresh, so an ordinary
 * page load does not reach the internet. Only a stale or missing cache tries the feed, and a
 * failure there falls back rather than propagating: an unreachable holiday API must not stop the
 * pacing screen from drawing.
 */
export async function loadHolidays(opts: LoadOptions): Promise<HolidayResult> {
  const { db, region, year } = opts;
  const now = opts.now ?? Date.now();
  const cached = readCache(db, region, year, now);

  if (cached && cached.age < CACHE_TTL_MS) {
    return { holidays: selectForRegion(cached.raw, region), origin: "cache" };
  }

  if (!opts.offline) {
    try {
      const raw = await (opts.fetcher ?? fetchFromNager)(region, year);
      writeCache(db, region, year, raw, now);
      return { holidays: selectForRegion(raw, region), origin: "network" };
    } catch (err) {
      const why = (err as Error).message;
      if (cached) {
        return {
          holidays: selectForRegion(cached.raw, region),
          origin: "cache",
          warning: `holiday source unreachable (${why}); using a cached copy from ` +
            `${Math.round(cached.age / 3_600_000)}h ago`,
        };
      }
      const snap = SNAPSHOT[String(year)];
      if (snap) {
        return {
          holidays: selectForRegion(snap, region),
          origin: "snapshot",
          warning:
            `holiday source unreachable (${why}); using the snapshot shipped with this build`,
        };
      }
      // 6.35 -- returning an empty list here would quietly *add* workdays to the month, which is
      // the exact failure the requirement names. Say there are none and say why, so the caller can
      // refuse to draw a pace rather than draw a confident wrong one.
      return {
        holidays: [],
        origin: "none",
        warning: `holiday source unreachable (${why}) and nothing cached or shipped for ${year}; ` +
          `this month's workday count is not trustworthy`,
      };
    }
  }

  if (cached) {
    return {
      holidays: selectForRegion(cached.raw, region),
      origin: "cache",
      warning: `offline; using a cached copy from ${Math.round(cached.age / 3_600_000)}h ago`,
    };
  }
  const snap = SNAPSHOT[String(year)];
  if (snap) {
    return {
      holidays: selectForRegion(snap, region),
      origin: "snapshot",
      warning: "offline; using the snapshot shipped with this build",
    };
  }
  return {
    holidays: [],
    origin: "none",
    warning: `offline and nothing cached or shipped for ${year}; this month's workday count is ` +
      `not trustworthy`,
  };
}

/** Every year the snapshot covers, so a build can say what it can answer without a network. */
export function snapshotYears(): number[] {
  return Object.keys(SNAPSHOT).map(Number).sort();
}
