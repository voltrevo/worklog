import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import type { WorkEntry } from "./types.ts";
import type { InvoiceRecord } from "./invoice.ts";
import { monthReport, rangeHours, stateOf } from "./reports.ts";

const HOUR = 3_600_000;

function entry(date: string, hours: number, tag: string, timed = false): WorkEntry {
  return {
    id: `${date}-${tag}-${hours}`,
    date,
    durationMs: hours * HOUR,
    billingTag: tag,
    ...(timed ? { timing: { startedAt: 0, endedAt: hours * HOUR } } : {}),
  };
}

const ENTRIES = [
  entry("2026-09-01", 6, "Feature development", true),
  entry("2026-09-01", 2, "Meetings"),
  entry("2026-09-02", 7, "Feature development", true),
  entry("2026-09-03", 3, "Code review"),
  entry("2026-10-01", 8, "Feature development", true),
];

Deno.test("7.2/7.3 -- the total is the sum of the durations, whatever form they took", () => {
  const r = monthReport("2026-09", ENTRIES);
  assertEquals(r.totalHours, 18);
  // 2.13 -- a timed entry and a duration-only one are the same number here, which is what lets
  // 2.9 exist at all.
  assertEquals(ENTRIES.filter((e) => e.timing).length, 3);
});

Deno.test("7.6 -- totals by billing tag, largest first, with the days each spans", () => {
  const r = monthReport("2026-09", ENTRIES);
  assertEquals(
    r.byTag.map((t) => [t.tag, t.hours, t.days]),
    [
      ["Feature development", 13, 2],
      ["Meetings", 2, 1],
      ["Code review", 3, 1],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)),
  );
  assertAlmostEquals(r.byTag[0]!.share, 13 / 18, 1e-12);
  assertAlmostEquals(r.byTag.reduce((t, x) => t + x.share, 0), 1, 1e-12);
});

Deno.test("two tags with the same hours are ordered by name, so the table does not shuffle", () => {
  const r = monthReport("2026-09", [
    entry("2026-09-01", 4, "Zebra"),
    entry("2026-09-02", 4, "Alpha"),
  ]);
  assertEquals(r.byTag.map((t) => t.tag), ["Alpha", "Zebra"]);
});

Deno.test("7.5 -- daily totals, in order, for the days that have work", () => {
  const r = monthReport("2026-09", ENTRIES);
  assertEquals(r.byDay, [
    { date: "2026-09-01", hours: 8 },
    { date: "2026-09-02", hours: 7 },
    { date: "2026-09-03", hours: 3 },
  ]);
});

Deno.test("a month with no work reports zero rather than NaN", () => {
  // `share` divides by the total, and a table full of NaN% looks perfectly reasonable until
  // somebody reads it.
  const r = monthReport("2026-11", ENTRIES);
  assertEquals(r.totalHours, 0);
  assertEquals(r.byTag, []);
  assertEquals(r.byDay, []);
  assertEquals(r.state, "uninvoiced");
});

Deno.test("7.8/7.11 -- the state comes from the invoice covering the month", () => {
  const invoices: InvoiceRecord[] = [
    { id: "1", period: "2026-09", number: "INV-2026-09", status: "issued" },
    { id: "2", period: "2026-08", number: "INV-2026-08", status: "paid" },
    { id: "3", period: "2026-10", number: "INV-2026-10", status: "draft" },
  ];
  assertEquals(stateOf("2026-09", invoices).state, "invoiced");
  assertEquals(stateOf("2026-08", invoices).state, "paid");
  assertEquals(stateOf("2026-07", invoices).state, "uninvoiced");
  // 11.3 -- a draft has no accounting meaning, so its month is still unbilled. That is exactly
  // what somebody chasing unbilled hours wants it to say.
  assertEquals(stateOf("2026-10", invoices).state, "uninvoiced");

  const r = monthReport("2026-09", ENTRIES, invoices);
  assertEquals(r.state, "invoiced");
  assertEquals(r.invoiceNumber, "INV-2026-09");
});

Deno.test("7.7 -- work shows in the report whatever its invoice state", () => {
  const paid: InvoiceRecord[] = [
    { id: "1", period: "2026-09", number: "INV-2026-09", status: "paid" },
  ];
  const r = monthReport("2026-09", ENTRIES, paid);
  assertEquals(r.totalHours, 18, "invoiced work is still work");
  assertEquals(r.byTag.length, 3);
});

Deno.test("7.4 -- an arbitrary half-open range, which the UI does not offer in v1", () => {
  assertEquals(rangeHours(ENTRIES, "2026-09-01", "2026-09-03"), 15, "the 3rd is excluded");
  assertEquals(rangeHours(ENTRIES, "2026-09-01", "2026-10-02"), 26);
  assertEquals(rangeHours(ENTRIES, "2026-09-05", "2026-09-06"), 0);
});
