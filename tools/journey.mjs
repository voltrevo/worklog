/**
 * 23.7 — the write path, end to end, from two real browsers against one real server.
 *
 *     deno task journey
 *
 * `screenshots.mjs` proves that every screen renders. It never presses anything that changes
 * state, and that gap is what let "Generate PDF" ship as a button that rendered a document onto the
 * server's disk and handed the person who pressed it nothing (8.33). A screen that renders is not a
 * feature that works.
 *
 * So this drives the things the product is *for*: run a timer, record time from a second device,
 * watch the first device learn about it without being asked, invoice a month, take delivery of the
 * PDF, and issue it. Every assertion is on what the browser can see or receive — never on the
 * server's database, because the whole question is whether the server's state ever reaches anyone.
 *
 * It shares `harness.mjs` with the screenshots, and runs on different ports so both can run at
 * once without one quietly connecting to the other's listener.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimAndApprove, MOBILE, root, startRig, visibleText } from "./harness.mjs";

const dataDir = join(root, ".journey-data");
const PORT = 41778;
const HTTP_PORT = 5400;

const TAG = "Journey work";

/**
 * A Monday in the month the app will be showing, in the timezone the harness pins its browsers to.
 *
 * A Monday specifically, because the override check needs a day that *is* scheduled before it can
 * prove that marking it off lowers the capacity. "The 15th" would silently be a no-op in the months
 * where the 15th is a Sunday, and the check would pass in eleven months of the year.
 */
const FIRST_MONDAY = (() => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const at = (t) => parts.find((p) => p.type === t).value;
  const first = new Date(Date.UTC(Number(at("year")), Number(at("month")) - 1, 1));
  // getUTCDay: 0 is Sunday, so 1 is Monday and this is how far the first of the month is from one.
  const day = first.getUTCDate() + ((8 - first.getUTCDay()) % 7);
  return `${at("year")}-${at("month")}-${String(day).padStart(2, "0")}`;
})();

let checks = 0;
const failures = [];

function check(label, ok, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

/**
 * Poll until a predicate holds.
 *
 * Not `waitForTimeout`: a fixed sleep either wastes time or is a flake waiting for a slower
 * machine, and the things being waited on here arrive over WebRTC, whose latency is nobody's to
 * predict.
 */
async function until(label, page, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate(page);
      if (last) return true;
    } catch (e) {
      last = e.message;
    }
    await page.waitForTimeout(250);
  }
  check(label, false, `timed out after ${timeout}ms (last: ${JSON.stringify(last)})`);
  // What the page was actually showing. A boolean that stayed false says nothing about whether the
  // app was connected, on another screen, or sitting on an error -- and those want different fixes.
  console.error(`      showing: ${JSON.stringify(await visibleText(page))}`);
  return false;
}

const nav = (page, name) => page.getByRole("button", { name, exact: true }).first().click();

async function main() {
  const rig = await startRig({ dataDir, port: PORT, httpPort: HTTP_PORT });
  const { desktop, mobile } = await claimAndApprove(rig);

  // ---------------------------------------------------------------- a timer, and a second device
  console.log("\ntimer:");
  await nav(desktop.page, "Timer");
  await desktop.page.getByLabel("Billing tag").fill(TAG);
  await desktop.page.getByRole("button", { name: /Start/ }).click();

  check(
    "the desktop shows the session it just started",
    await until(
      "desktop session",
      desktop.page,
      (p) => p.getByText(`Working on ${TAG}`).isVisible(),
    ),
  );

  // 1.9, 17.12 — the phone did not ask. This is the subscribe/broadcast path, and it is the one
  // thing a single-browser test cannot check at all.
  //
  // When it fails, reload and look again. That separates two failures a single check cannot tell
  // apart: the server never learned (both stay empty) versus the server learned and never told the
  // phone (the reload fills it in). The second is a broken push; the first is a broken write.
  await nav(mobile.page, "Timer");
  const live = await until(
    "phone session",
    mobile.page,
    (p) => p.getByText(`Working on ${TAG}`).isVisible(),
    15_000,
  );
  if (live) {
    check("the phone learns about it without being reloaded", true);
  } else {
    // Wait for the app to be up before drawing any conclusion. Without this the reload arm reports
    // "the server never recorded it" whenever reconnecting takes longer than the window, which is a
    // diagnostic that lies exactly when it is needed.
    await mobile.page.reload();
    await mobile.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 })
      .catch(() => {});
    await nav(mobile.page, "Timer").catch(() => {});
    const afterReload = await until(
      "phone session after reload",
      mobile.page,
      (p) => p.getByText(`Working on ${TAG}`).isVisible(),
      20_000,
    );
    check(
      "the phone learns about it without being reloaded",
      false,
      afterReload
        ? "a reload shows it, so the server knew and the push never arrived"
        : "a reload does not show it either, so the server never recorded the start",
    );
  }

  // Long enough that the entry is not zero-length, short enough not to pad the run.
  await desktop.page.waitForTimeout(2_000);
  await desktop.page.getByRole("button", { name: /Stop/ }).click();

  check(
    "stopping leaves an entry in today's list",
    await until(
      "entry present",
      desktop.page,
      async (p) => (await p.getByRole("cell", { name: TAG }).count()) > 0,
    ),
  );
  // Not "Not working": the phone said that before the timer ever started, so it could not
  // disagree. The entry carrying this run's tag is something that was not there a moment ago.
  check(
    "and the entry reaches the phone",
    await until(
      "phone entry",
      mobile.page,
      async (p) => (await p.getByText(TAG).count()) > 0,
    ),
  );

  // ---------------------------------------------------------------- recording time from the phone
  console.log("\npast time from the phone:");
  await nav(mobile.page, "History");
  await nav(desktop.page, "History");
  const before = await monthTotal(desktop.page);
  check("the desktop's history screen shows a month total", before !== undefined);

  await mobile.page.getByLabel("How long").fill("2h 30m");
  await mobile.page.getByLabel("Billing tag").fill("Phone entry");
  await mobile.page.getByRole("button", { name: "Add", exact: true }).click();

  check(
    "the desktop's month total grows by what the phone recorded",
    await until(
      "month total",
      desktop.page,
      async (p) => {
        const now = await monthTotal(p);
        return now !== undefined && before !== undefined &&
          Math.abs(now - before - 2.5) < 0.05;
      },
    ),
    `was ${before}h`,
  );

  // ---------------------------------------------------------------- invoicing, and the PDF
  console.log("\ninvoice:");
  await nav(desktop.page, "Invoices");

  const prepare = desktop.page.getByRole("button", { name: /Prepare invoice|Rebuild draft/ });
  await prepare.waitFor({ timeout: 15_000 });
  await prepare.click();
  check(
    "a draft exists for last month",
    await until(
      "draft",
      desktop.page,
      (p) => p.getByText("Draft", { exact: true }).first().isVisible(),
    ),
  );

  // 8.33 — the whole reason this file exists. A download that never arrives fails here rather than
  // looking like a button that worked.
  const wait = desktop.page.waitForEvent("download", { timeout: 20_000 }).catch(() => undefined);
  await desktop.page.getByRole("button", { name: "Generate PDF" }).click();
  const download = await wait;

  check("generating a PDF delivers a file to the browser", download !== undefined);
  if (download) {
    const path = await download.path();
    const head = (await readFile(path)).subarray(0, 5).toString("latin1");
    check("and the file is a PDF", head === "%PDF-", `starts with ${JSON.stringify(head)}`);
    check(
      "named after the invoice",
      /\.pdf$/.test(download.suggestedFilename()),
      download.suggestedFilename(),
    );
  }

  // 11.4 — and none of that changed the accounting state.
  check(
    "generating did not issue anything",
    await desktop.page.getByText("Draft", { exact: true }).first().isVisible(),
  );

  await desktop.page.getByRole("button", { name: "Mark as issued" }).click();
  await desktop.page.getByRole("button", { name: "Issue it" }).click();
  check(
    "issuing moves it out of draft",
    await until(
      "issued",
      desktop.page,
      (p) => p.getByText("Issued", { exact: true }).first().isVisible(),
    ),
  );

  // 11.5, 11.19 — the month is spoken for now, so the rebuild that was available a moment ago is
  // not. The server would refuse anyway; this checks the UI does not offer it.
  check(
    "and the month can no longer be rebuilt",
    await desktop.page.getByRole("button", { name: "Rebuild draft" }).isDisabled(),
  );

  // ---------------------------------------------------------------- editing what was recorded
  console.log("\nediting:");
  await nav(desktop.page, "History");
  const beforeEdit = await monthTotal(desktop.page);

  // The row this run created. 2.12's "drop the times" turns a timed entry into a duration-only
  // one, which is the branch `entry-update` carries a `null` for and nothing else exercises.
  const row = desktop.page.getByRole("row").filter({ hasText: TAG }).first();
  await row.getByRole("button", { name: "Edit" }).click();
  await desktop.page.getByRole("checkbox").first().check();
  await desktop.page.getByRole("button", { name: "Save", exact: true }).click();

  check(
    "an edited entry keeps its hours and loses its times",
    await until(
      "duration only",
      desktop.page,
      async (p) => {
        const r = p.getByRole("row").filter({ hasText: TAG }).first();
        return (await r.getByText("duration only").count()) > 0;
      },
    ),
  );
  check(
    "and the month total did not move",
    Math.abs((await monthTotal(desktop.page)) - beforeEdit) < 0.02,
    `${beforeEdit}h -> ${await monthTotal(desktop.page)}h`,
  );

  await desktop.page.getByRole("row").filter({ hasText: "Phone entry" }).first()
    .getByRole("button", { name: "Delete" }).click();
  check(
    "deleting takes its hours out of the month",
    await until(
      "deleted",
      desktop.page,
      async (p) => {
        const now = await monthTotal(p);
        return now !== undefined && Math.abs(now - (beforeEdit - 2.5)) < 0.05;
      },
    ),
    `expected ${beforeEdit - 2.5}h`,
  );

  // ---------------------------------------------------------------- a work note
  console.log("\nwork note:");
  await nav(desktop.page, "Timer");
  await desktop.page.getByRole("button", { name: "New work note" }).click();
  await desktop.page.getByRole("textbox").first().fill("Wrote the journey harness.");
  await desktop.page.getByRole("button", { name: "Save note" }).click();
  check(
    "a note written on one device is readable on it",
    await until(
      "note saved",
      desktop.page,
      (p) => p.getByText("Wrote the journey harness.").isVisible(),
    ),
  );
  await nav(mobile.page, "Timer");
  check(
    "and reaches the other one",
    await until(
      "note on phone",
      mobile.page,
      (p) => p.getByText("Wrote the journey harness.").isVisible(),
    ),
  );

  // ---------------------------------------------------------------- surviving reloads
  //
  // Twice, and the second one is the point. The device key lives in IndexedDB, and two modules used
  // to open that database at different versions -- so the *first* reload found it at the old
  // version and worked, and the second could not open it at all. A device that cannot read its own
  // key is a device the server has never met: it lands back on the connect screen and has to be
  // approved all over again. One reload could not see this. See `web/src/idb.ts`.
  console.log("\nreloads:");
  for (const attempt of [1, 2]) {
    await mobile.page.reload();
    check(
      `the phone is still itself after reload ${attempt}`,
      await until(
        `phone authorised after reload ${attempt}`,
        mobile.page,
        async (p) =>
          (await p.getByText("Today", { exact: true }).count()) > 0 &&
          (await p.getByRole("button", { name: /Ask for/ }).count()) === 0,
        30_000,
      ),
    );
  }

  // ---------------------------------------------------------------- configuration, and its effect
  //
  // 6.x and 1.12. The point is not that a number was stored -- it is that changing the *schedule*
  // moves the projection on another device, which is what 6.21's "expected working hours, not a
  // number of hours" means in practice. A config screen whose values nothing downstream reads is
  // exactly the shape of `a-value-nothing-reads-is-untestable`.
  console.log("\nconfiguration:");
  await nav(desktop.page, "Pacing");
  const capacityBefore = await figure(desktop.page, "Capacity this month");
  check("the pacing figures can be read at all", capacityBefore !== undefined, `${capacityBefore}`);

  await nav(desktop.page, "Settings");
  await desktop.page.getByLabel("Monthly target (hours)").fill("120");
  // Saturday off -> on. The capacity is the sum of the scheduled intervals, so adding a sixth
  // workday must raise it; a target change alone would not, which is why both are exercised.
  await desktop.page.getByRole("checkbox").nth(5).check();
  await desktop.page.getByRole("button", { name: "Save", exact: true }).first().click();

  await nav(mobile.page, "Pacing");
  check(
    "a target set on the desktop is the target the phone projects against",
    await until(
      "target on phone",
      mobile.page,
      async (p) => (await p.getByText("120h 0m").count()) > 0,
    ),
  );

  await nav(desktop.page, "Pacing");
  check(
    "and adding a workday to the week raises the month's capacity",
    await until(
      "capacity up",
      desktop.page,
      async (p) => {
        const now = await figure(p, "Capacity this month");
        return now !== undefined && capacityBefore !== undefined && now > capacityBefore;
      },
    ),
    `was ${capacityBefore}h`,
  );

  // 6.19, 6.20 — an override is not a work record. It changes what the month is expected to hold,
  // so the capacity moves and the recorded hours do not.
  const capacityWithSaturday = await figure(desktop.page, "Capacity this month");
  const workedBefore = await figure(desktop.page, "Worked so far");
  await desktop.page.getByLabel("Date").last().fill(FIRST_MONDAY);
  await desktop.page.getByRole("button", { name: "Add", exact: true }).click();

  check(
    "marking a day off lowers the capacity",
    await until(
      "capacity down",
      desktop.page,
      async (p) => {
        const now = await figure(p, "Capacity this month");
        return now !== undefined && capacityWithSaturday !== undefined &&
          now < capacityWithSaturday;
      },
    ),
    `was ${capacityWithSaturday}h`,
  );
  // `workedBefore !== undefined` is not padding: without it a locator that matched nothing makes
  // this `undefined === undefined`, and the check passes by having read neither figure.
  const workedAfter = await figure(desktop.page, "Worked so far");
  check(
    "and changes no recorded work at all",
    workedBefore !== undefined && workedAfter === workedBefore,
    `${workedBefore}h -> ${workedAfter}h`,
  );

  // ---------------------------------------------------------------- revoking, while connected
  //
  // 13.20, 13.21 — the phone is holding an open subscription. Revoking has to reach it there
  // rather than at its next reload, because "next reload" on a tab left open is never.
  console.log("\nrevocation:");
  await nav(desktop.page, "Admin");
  await desktop.page.getByRole("button", { name: "Device access" }).click();

  // 13.25, 1.12 — a request that arrives while an admin is already looking at this screen. It used
  // to arrive nowhere: the lists were fetched once on mount, so the admin saw the request only
  // after navigating away and back. Note the ordering -- the desktop is put on this screen *before*
  // the spare asks, because arriving-while-watching is the whole claim.
  const spare = await rig.open("spare", MOBILE, "Spare Tablet");
  const askSpare = spare.page.getByRole("button", { name: "Ask for write access" });
  await askSpare.waitFor({ timeout: 30_000 });
  await askSpare.click();
  check(
    "a request arrives on an admin screen nobody navigated",
    await until(
      "pending row",
      desktop.page,
      async (p) => (await p.getByText("Spare Tablet").count()) > 0,
    ),
  );

  // 1.12 again, on the other list that used to load once: an invoice issued on this device must
  // reach a second one without it being told to look. The phone is still authorised at this point,
  // which is the only reason this check can be made before the revocation below.
  await nav(mobile.page, "Invoices");
  check(
    "an invoice issued on the desktop shows as issued on the phone",
    await until(
      "issued on phone",
      mobile.page,
      async (p) => (await p.getByText("Issued", { exact: true }).count()) > 0,
    ),
  );

  await nav(desktop.page, "Admin");
  await desktop.page.getByRole("button", { name: "Device access" }).click();
  await desktop.page.getByRole("row", { name: /Pixel Phone/ })
    .getByRole("button", { name: "Revoke" }).click();

  check(
    "a revoked device finds out while it is still connected",
    await until(
      "phone locked out",
      mobile.page,
      async (p) => (await p.getByRole("button", { name: /Ask for/ }).count()) > 0,
    ),
  );

  // ---------------------------------------------------------------- what a read device can see
  //
  // 13.32–13.34 and 19.12/19.13. The server refusing a write from a `read` device is covered by
  // `rpc_test.ts`; what is not covered anywhere is the *UI's* half of it, which is a different
  // mechanism — a `canWrite` flag threaded through five screens, hiding some controls and
  // disabling others. A refusal the person could not have seen coming is a bug even when the
  // server does the right thing.
  //
  // The spare tablet is still pending from the check above, so it is the device to approve.
  console.log("\nread-only:");
  await desktop.page.getByRole("row", { name: /Spare Tablet/ })
    .getByRole("button", { name: "read", exact: true }).click();
  await spare.page.reload();
  await spare.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });

  check(
    "a read device cannot start the timer",
    await spare.page.getByRole("button", { name: /Start/ }).isDisabled(),
  );
  check(
    "and is not offered a work note",
    (await spare.page.getByRole("button", { name: "New work note" }).count()) === 0,
  );

  await nav(spare.page, "History");
  check(
    "and cannot add past time",
    (await spare.page.getByRole("button", { name: "Add", exact: true }).count()) === 0,
  );

  await nav(spare.page, "Invoices");
  check(
    "and cannot prepare an invoice",
    (await spare.page.getByRole("button", { name: /Prepare invoice|Rebuild draft/ })
      .count()) === 0,
  );
  check(
    "but can still read one",
    await until(
      "invoice visible to read",
      spare.page,
      async (p) => (await p.getByText("Issued", { exact: true }).count()) > 0,
    ),
  );
  check(
    "and has no Admin tab at all",
    (await spare.page.getByRole("button", { name: "Admin", exact: true }).count()) === 0,
  );

  await rig.close();

  const pageErrors = rig.errors.length;
  console.log(
    `\n${checks} checks, ${failures.length} failed, ${pageErrors} page errors`,
  );
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(failures.length === 0 && pageErrors === 0 ? 0 : 1);
}

/**
 * One of the Pacing screen's labelled figures, in hours.
 *
 * Read by its label rather than by position: the cards are a flex row, and a check that says
 * "the third card went up" stops meaning anything the moment a fourth is added.
 */
async function figure(page, label) {
  const text = await page.locator(".card", { hasText: label }).first()
    .locator(".big").first().textContent().catch(() => null);
  if (!text) return undefined;
  const m = /(\d+)h\s*(\d+)m/.exec(text);
  return m ? Number(m[1]) + Number(m[2]) / 60 : undefined;
}

/** The month figure on the History screen, in hours, as the browser renders it. */
async function monthTotal(page) {
  const text = await page.locator(".card .big").first().textContent().catch(() => null);
  if (!text) return undefined;
  const m = /(\d+)h\s*(\d+)m/.exec(text);
  return m ? Number(m[1]) + Number(m[2]) / 60 : undefined;
}

await main().catch((err) => {
  // The stack, not just the message: every locator in this file times out with the same sentence.
  console.error(`journey: ${err.stack ?? err.message}`);
  process.exit(1);
});
