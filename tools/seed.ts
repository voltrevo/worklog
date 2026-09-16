/**
 * Fill a database with a month of plausible work, for screenshots and for trying the app out.
 *
 *     deno run -A --node-modules-dir=manual tools/seed.ts ./data
 *
 * **Every name and number here is invented** (9.5, 9.6, 20.7). Wren & Co bills Kestrel Labs at a
 * round rate into an account at a bank that does not exist. Nothing in this file, or in any
 * screenshot taken from it, is anybody's real detail.
 *
 * It writes through the same store functions the server uses, so the fixtures cannot drift from
 * what the application would actually have produced.
 */

import { open } from "../server/db.ts";
import { setConfig } from "../server/config.ts";
import { addEntry } from "../server/work.ts";
import { createDraft } from "../server/invoices.ts";
import { datesInMonth, monthOf, shiftMonth, today, weekdayOf } from "../shared/dates.ts";
import type { Weekday } from "../shared/types.ts";
import { fixtureSchedule, hoursFor, scheduledHours } from "./seedPlan.ts";

const dataDir = Deno.args[0] ?? "./data";
await Deno.mkdir(dataDir, { recursive: true });
const db = open({ path: `${dataDir}/worklog.sqlite` });

const now = Date.now();

setConfig(db, "invoice", {
  fromName: "Wren & Co",
  fromAddress: "12 Fictional Way, Nowhere NSW 2000, Australia",
  fromEmail: "hello@example.invalid",
  fromAbn: "00 000 000 000",
  fromPhone: "+61 400 000 000",
  clientName: "Kestrel Labs Pty Ltd",
  clientAddress: "1 Imaginary Street, Level 9\nMelbourne VIC 3000\nAustralia",
  currency: "AUD",
  rateMinor: 12_000,
  taxRate: 0,
  taxLabel: "GST",
  approver: "Robin Fairweather",
  teamProject: "Product Development",
  bonusTeamProject: "General",
  bonusMinor: 25_000,
  payMethod: "Wire Transfer",
  payName: "Wren & Co",
  payBsb: "000-000",
  payAccountNumber: "00000000",
  payBank: "Bank of Nowhere",
  note: "",
}, now);

/*
 * 27.32 — the week is part of the fixture now, because the product no longer ships one.
 *
 * A seeded database represents somebody who has set this up, and Mon–Fri 09:00–17:00 is what they
 * set. It used to come from `DEFAULTS`, which meant every screenshot and every journey check was
 * quietly also asserting that a brand-new server had a working week in it.
 */
const schedule = fixtureSchedule(weekdayOf(today()) as Weekday);

setConfig(db, "pacing", {
  monthlyTargetHours: 160,
  region: "AU-NSW",
  schedule,
}, now);
/**
 * 45 minutes is the realistic figure; `WORKLOG_SEED_PROMPT_MS` shortens it for the journey.
 *
 * The prompt process is memoryless (5.14): each poll asks "given the elapsed time, should one fire
 * now?", and 5.31 caps that probability at 1. So a mean below the ten-second poll interval makes
 * the first poll after a timer starts certain, which turns an unobservable feature into a
 * fifteen-second check. The knob is on the *seeder* rather than the server because it is a property
 * of the fixture, not a mode the product has.
 */
const promptMs = Number(Deno.env.get("WORKLOG_SEED_PROMPT_MS")) || 45 * 60_000;
setConfig(db, "prompt", { enabled: true, meanIntervalMs: promptMs }, now);

/** Enough variety that the invoice's Description column is not one word repeated. */
const TAGS = [
  "Feature development",
  "Code review and refactoring",
  "API integration",
  "Bug fixes and testing",
  "Product planning",
  "Technical documentation",
  "Client feedback & updates",
  "Performance improvements",
  "Sprint review",
];

/** Deterministic, so two runs of the screenshot harness produce the same picture. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const random = rng(20260908);
const HOUR = 3_600_000;
const thisMonth = monthOf(today());
const lastMonth = shiftMonth(thisMonth, -1);

function fill(month: string, upTo?: string): number {
  let count = 0;
  for (const date of datesInMonth(month)) {
    if (upTo && date > upTo) break;
    const weekday = weekdayOf(date);
    // A weekend is worked about one time in ten, which is what makes the pacing screen interesting.
    // Today is always worked, because a timer screen showing a day with nothing on it is not the
    // screen this fixture exists to photograph.
    const isToday = date === today();
    if (!isToday && weekday >= 6 && random() > 0.1) continue;
    if (!isToday && weekday < 6 && random() > 0.92) continue; // the odd day off

    const tag = TAGS[Math.floor(random() * TAGS.length)] ?? TAGS[0]!;
    // Quarter hours, because that is how people actually record time -- and because an invoice
    // full of $1,060.03 lines reads as a bug even when the arithmetic is right.
    const raw = weekday >= 6 ? 2 + random() * 3 : 5 + random() * 4;
    const hours = hoursFor(raw, isToday, scheduledHours(schedule, weekday as Weekday));
    // Padded rather than prefixed with "0": hour 10 built `T010:00:00`, which `Date` rejects, and
    // the resulting NaN reached the database as a NULL `created_at`. The schema caught it.
    const startHour = String(9 + Math.floor(random() * 2)).padStart(2, "0");
    const startedAt = new Date(`${date}T${startHour}:00:00`).getTime();
    addEntry(db, {
      date,
      durationMs: Math.round(hours * HOUR),
      billingTag: tag,
      timing: { startedAt, endedAt: startedAt + Math.round(hours * HOUR) },
    }, startedAt);
    count++;
  }
  return count;
}

const filledLast = fill(lastMonth);
const filledThis = fill(thisMonth, today());

// One duration-only entry, so the history and the invoice both show the other kind (2.9, 19.6).
addEntry(db, {
  date: shiftDay(today(), -1),
  durationMs: Math.round(1.5 * HOUR),
  billingTag: "Client feedback & updates",
}, now);

db.prepare(
  "INSERT INTO work_note (id, created_at, body, prompted) VALUES (?, ?, ?, 1)",
).run(crypto.randomUUID(), now - 2 * HOUR, "Finished the cage-sum pruning and started on the UI.");

// A draft for last month, so the Invoices screen has something on it.
createDraft(db, { period: lastMonth, preparedOn: today() }, now);

console.log(
  `seeded ${dataDir}: ${filledLast} entries in ${lastMonth}, ${filledThis} in ${thisMonth}, ` +
    `one duration-only, one work note, one draft invoice`,
);
db.close();

function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
