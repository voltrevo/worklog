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
  /**
   * The feed before `selectForRegion` narrowed it (24.42).
   *
   * Needed because "did this region yield holidays?" is the wrong question: an unknown subdivision
   * yields the *national* ones, so `AU-XYZ` comes back with six and looks fine. The right question
   * — is this subdivision named by any holiday in the country — can only be asked of the raw feed.
   */
  raw: readonly RawHoliday[];
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
    return { holidays: selectForRegion(cached.raw, region), raw: cached.raw, origin: "cache" };
  }

  if (!opts.offline) {
    try {
      const raw = await (opts.fetcher ?? fetchFromNager)(region, year);
      writeCache(db, region, year, raw, now);
      return { holidays: selectForRegion(raw, region), raw, origin: "network" };
    } catch (err) {
      const why = (err as Error).message;
      if (cached) {
        return {
          holidays: selectForRegion(cached.raw, region),
          raw: cached.raw,
          origin: "cache",
          warning: `holiday source unreachable (${why}); using a cached copy from ` +
            `${Math.round(cached.age / 3_600_000)}h ago`,
        };
      }
      const snap = SNAPSHOT[String(year)];
      if (snap) {
        return {
          holidays: selectForRegion(snap, region),
          raw: snap,
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
        raw: [],
        origin: "none",
        warning: `holiday source unreachable (${why}) and nothing cached or shipped for ${year}; ` +
          `this month's workday count is not trustworthy`,
      };
    }
  }

  if (cached) {
    return {
      holidays: selectForRegion(cached.raw, region),
      raw: cached.raw,
      origin: "cache",
      warning: `offline; using a cached copy from ${Math.round(cached.age / 3_600_000)}h ago`,
    };
  }
  const snap = SNAPSHOT[String(year)];
  if (snap) {
    return {
      holidays: selectForRegion(snap, region),
      raw: snap,
      origin: "snapshot",
      warning: "offline; using the snapshot shipped with this build",
    };
  }
  return {
    holidays: [],
    raw: [],
    origin: "none",
    warning: `offline and nothing cached or shipped for ${year}; this month's workday count is ` +
      `not trustworthy`,
  };
}

/** Every year the snapshot covers, so a build can say what it can answer without a network. */
export function snapshotYears(): number[] {
  return Object.keys(SNAPSHOT).map(Number).sort();
}

/**
 * 24.42, 24.32 — is this a region the holiday source knows about?
 *
 * The field used to be free text with no check at all, so `AU-XYZ`, `garbage` and an empty string
 * all saved happily and then quietly produced a month with no holidays — which is
 * indistinguishable from a month that genuinely has none, and shifts the pacing arithmetic by a
 * day at a time with nothing on screen to say why.
 *
 * The test is deliberately "does the source yield anything", not "is this in a list of valid
 * codes": there is no such list to check against without inventing one. `AU-XYZ` fails because
 * Australia's holidays are never in AU-XYZ; `AU` alone passes, because national holidays are a
 * legitimate answer.
 *
 * A source that cannot be reached is *not* a rejection. Refusing to save a setting because the
 * network is down would be worse than the problem: the region may well be right, and the pacing
 * screen already says when it is working from a snapshot (6.36).
 */
export async function checkRegion(
  opts: LoadOptions & { region: string },
): Promise<{ ok: true; holidays: number } | { ok: false; reason: string }> {
  const region = opts.region.trim();
  if (!region) return { ok: false, reason: "a region is needed" };
  if (!/^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/.test(region)) {
    return {
      ok: false,
      reason: `"${region}" is not a region code — try AU, AU-NSW or GB-ENG`,
    };
  }

  const result = await loadHolidays({ ...opts, region });
  if (result.origin === "none") {
    // Nothing to check against. Accepting is the lesser evil; see above.
    return { ok: true, holidays: 0 };
  }

  /*
   * Only judge against a feed that is actually about this country.
   *
   * The fallback snapshot ships one country's holidays, so checking `GB-ENG` while offline
   * consults Australia's list, finds no mention of England and rejects a perfectly good region.
   * A check that fires on the wrong evidence is worse than no check: it is the one somebody
   * disables.
   */
  const country = countryOf(region);
  const feedIsForThisCountry = result.raw.some((h) => h.countryCode?.toUpperCase() === country);
  if (!feedIsForThisCountry) return { ok: true, holidays: result.holidays.length };

  const [, subdivision] = region.toUpperCase().split("-");
  if (subdivision) {
    // The question is whether the *country's* feed names this subdivision — not whether the
    // region yielded holidays, because an unknown one yields the national ones and looks healthy.
    // `AU-XYZ` came back with six holidays and no complaint, having silently dropped every NSW
    // day from the month's pacing.
    const named = result.raw.some((h) =>
      h.counties?.some((c) => c.toUpperCase() === region.toUpperCase())
    );
    if (!named) {
      return {
        ok: false,
        reason: `no holiday in ${countryOf(region)} is listed for ${region}. Use ` +
          `${countryOf(region)} for national holidays only, or check the subdivision code.`,
      };
    }
  } else if (result.holidays.length === 0) {
    return {
      ok: false,
      reason: `no public holiday is listed for ${region}, so pacing would treat every day as an ` +
        `ordinary one`,
    };
  }

  return { ok: true, holidays: result.holidays.length };
}
