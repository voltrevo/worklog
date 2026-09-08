import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { type Db, open } from "./db.ts";
import {
  checkRegion,
  countryOf,
  type Fetcher,
  loadHolidays,
  type RawHoliday,
  selectForRegion,
  snapshotYears,
} from "./holidays.ts";

function fresh(): Db {
  return open({ path: ":memory:" });
}

const NOW = 1_788_000_000_000;

const SAMPLE: RawHoliday[] = [
  {
    date: "2026-01-01",
    localName: "New Year's Day",
    name: "New Year's Day",
    countryCode: "AU",
    counties: null,
    types: ["Public"],
  },
  {
    date: "2026-04-27",
    localName: "Anzac Day",
    name: "Anzac Day",
    countryCode: "AU",
    counties: ["AU-NSW", "AU-ACT", "AU-WA"],
    types: ["Public"],
  },
  {
    date: "2026-09-25",
    localName: "Friday before AFL Grand Final",
    name: "AFL Grand Final",
    countryCode: "AU",
    counties: ["AU-VIC"],
    types: ["Public"],
  },
  {
    date: "2026-08-03",
    localName: "Bank Holiday",
    name: "Bank Holiday",
    countryCode: "AU",
    counties: ["AU-NSW"],
    types: ["Bank"],
  },
];

Deno.test("6.31 -- the region selects, and another state's holiday does not apply", () => {
  const nsw = selectForRegion(SAMPLE, "AU-NSW").map((h) => h.date);
  assertEquals(nsw, ["2026-01-01", "2026-04-27"]);
  const vic = selectForRegion(SAMPLE, "AU-VIC").map((h) => h.date);
  assertEquals(vic, ["2026-01-01", "2026-09-25"]);
});

Deno.test("6.33 -- a bank holiday that is not a general public holiday is excluded", () => {
  // NSW's August bank holiday is real, is listed for AU-NSW, and is not a day off for most people.
  const nsw = selectForRegion(SAMPLE, "AU-NSW");
  assertEquals(nsw.some((h) => h.date === "2026-08-03"), false);
});

Deno.test("a nationwide holiday applies to every region", () => {
  for (const r of ["AU-NSW", "AU-VIC", "AU-TAS", "au-nsw"]) {
    assertEquals(selectForRegion(SAMPLE, r).some((h) => h.date === "2026-01-01"), true, r);
  }
});

Deno.test("the same holiday listed twice shows once", () => {
  const doubled = [...SAMPLE, SAMPLE[1] as RawHoliday];
  assertEquals(selectForRegion(doubled, "AU-NSW").length, 2);
});

Deno.test("countryOf takes the country out of a subdivision code", () => {
  assertEquals(countryOf("AU-NSW"), "AU");
  assertEquals(countryOf("AU"), "AU");
  assertEquals(countryOf("au-vic"), "AU");
});

Deno.test("a successful fetch is used and cached", async () => {
  const db = fresh();
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls++;
    return Promise.resolve(SAMPLE);
  };

  const first = await loadHolidays({ db, region: "AU-NSW", year: 2026, fetcher, now: NOW });
  assertEquals(first.origin, "network");
  assertEquals(first.warning, undefined);
  assertEquals(first.holidays.length, 2);
  assertEquals(calls, 1);

  // 6.6 -- a fresh cache short-circuits the network entirely, with no warning, because nothing
  // went wrong.
  const second = await loadHolidays({ db, region: "AU-NSW", year: 2026, fetcher, now: NOW + 1000 });
  assertEquals(second.origin, "cache");
  assertEquals(second.warning, undefined);
  assertEquals(calls, 1, "it did not go back to the network");
  db.close();
});

Deno.test("a stale cache tries the network again", async () => {
  const db = fresh();
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls++;
    return Promise.resolve(SAMPLE);
  };
  await loadHolidays({ db, region: "AU-NSW", year: 2026, fetcher, now: NOW });
  const later = await loadHolidays({
    db,
    region: "AU-NSW",
    year: 2026,
    fetcher,
    now: NOW + 48 * 3_600_000,
  });
  assertEquals(later.origin, "network");
  assertEquals(calls, 2);
  db.close();
});

Deno.test("6.35/6.36 -- a failed fetch falls back to the cache and says so", async () => {
  const db = fresh();
  await loadHolidays({
    db,
    region: "AU-NSW",
    year: 2026,
    fetcher: () => Promise.resolve(SAMPLE),
    now: NOW,
  });

  const broken: Fetcher = () => Promise.reject(new Error("ECONNREFUSED"));
  const result = await loadHolidays({
    db,
    region: "AU-NSW",
    year: 2026,
    fetcher: broken,
    now: NOW + 48 * 3_600_000,
  });
  assertEquals(result.origin, "cache");
  assertEquals(result.holidays.length, 2, "the workday count did not change");
  assertStringIncludes(result.warning ?? "", "ECONNREFUSED");
  db.close();
});

Deno.test("6.34 -- with no cache at all it falls back to the shipped snapshot", async () => {
  const db = fresh();
  const broken: Fetcher = () => Promise.reject(new Error("DNS failure"));
  const result = await loadHolidays({
    db,
    region: "AU-NSW",
    year: 2026,
    fetcher: broken,
    now: NOW,
  });
  assertEquals(result.origin, "snapshot");
  assertStringIncludes(result.warning ?? "", "snapshot");

  // The snapshot is the real feed, so this is also a check on the real NSW data: eleven public
  // holidays in 2026, including Anzac Day moved to the Monday and Boxing Day moved to the 28th.
  const dates = result.holidays.map((h) => h.date);
  assertEquals(dates.length, 11);
  assertEquals(dates.includes("2026-04-27"), true, "Anzac Day observed on the Monday");
  assertEquals(dates.includes("2026-12-28"), true, "Boxing Day observed on the Monday");
  assertEquals(dates.includes("2026-09-25"), false, "Victoria's AFL holiday is not NSW's");
  db.close();
});

Deno.test("a year nothing has heard of reports that it does not know, rather than none", () => {
  // 6.35's exact failure: an empty list would quietly *add* workdays to the month. The caller has
  // to be able to tell "no holidays" from "no idea".
  const db = fresh();
  return loadHolidays({
    db,
    region: "AU-NSW",
    year: 2099,
    fetcher: () => Promise.reject(new Error("nope")),
    now: NOW,
  }).then((result) => {
    assertEquals(result.origin, "none");
    assertEquals(result.holidays, []);
    assertStringIncludes(result.warning ?? "", "not trustworthy");
    db.close();
  });
});

Deno.test("offline never touches the network, even with no cache", async () => {
  const db = fresh();
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls++;
    return Promise.resolve(SAMPLE);
  };
  const result = await loadHolidays({
    db,
    region: "AU-NSW",
    year: 2026,
    fetcher,
    now: NOW,
    offline: true,
  });
  assertEquals(calls, 0);
  assertEquals(result.origin, "snapshot");
  assertStringIncludes(result.warning ?? "", "offline");
  db.close();
});

Deno.test("the snapshot covers the years a build is likely to be asked about", () => {
  const years = snapshotYears();
  assertEquals(years.length >= 4, true);
  assertEquals(years.includes(2026), true);
});

Deno.test("24.42 -- a region that yields no holidays is refused", async () => {
  const db = fresh();
  // The snapshot is Australia's, so AU-NSW is real and AU-XYZ is the shape of a state code that
  // does not exist — which is exactly the input that used to save happily and then flatten the
  // month's holidays with nothing on screen to explain the shifted pace.
  const good = await checkRegion({ db, region: "AU-NSW", year: 2026, offline: true, now: NOW });
  assertEquals(good.ok, true);
  assertEquals(good.ok && good.holidays > 0, true);

  const bad = await checkRegion({ db, region: "AU-XYZ", year: 2026, offline: true, now: NOW });
  assertEquals(bad.ok, false);
  assertEquals(bad.ok === false && bad.reason.includes("AU-XYZ"), true, "the reason names it");
  db.close();
});

Deno.test("a country on its own is a legitimate answer", async () => {
  // National holidays only. Rejecting this would force everyone to name a subdivision.
  const db = fresh();
  const verdict = await checkRegion({ db, region: "AU", year: 2026, offline: true, now: NOW });
  assertEquals(verdict.ok, true);
  db.close();
});

Deno.test("garbage is refused on shape, before anything is fetched", async () => {
  const db = fresh();
  for (const region of ["", "   ", "garbage", "A", "AUSTRALIA", "AU-TOOLONG", "12-34"]) {
    const verdict = await checkRegion({ db, region, year: 2026, offline: true, now: NOW });
    assertEquals(verdict.ok, false, `${JSON.stringify(region)} was accepted`);
  }
  db.close();
});

Deno.test("an unreachable source is not a rejection", async () => {
  // Refusing to save because the network is down would be worse than the problem: the region may
  // be perfectly right, and 6.36 already says on screen when the pace is built from a snapshot.
  const db = fresh();
  const verdict = await checkRegion({
    db,
    region: "GB-ENG",
    year: 2026,
    now: NOW,
    fetcher: () => Promise.reject(new Error("network is down")),
  });
  assertEquals(verdict.ok, true);
  db.close();
});
