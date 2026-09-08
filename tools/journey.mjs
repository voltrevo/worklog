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
import { claimAndApprove, root, startRig } from "./harness.mjs";

const dataDir = join(root, ".journey-data");
const PORT = 41778;
const HTTP_PORT = 5400;

const TAG = "Journey work";

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

/** The page's own text, flattened and clipped: enough to tell which screen and which state. */
async function visibleText(page) {
  const text = await page.locator("body").innerText().catch((e) => `<unreadable: ${e.message}>`);
  return text.replace(/\s+/g, " ").slice(0, 300);
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

  await rig.close();

  const pageErrors = rig.errors.length;
  console.log(
    `\n${checks} checks, ${failures.length} failed, ${pageErrors} page errors`,
  );
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(failures.length === 0 && pageErrors === 0 ? 0 : 1);
}

/** The month figure on the History screen, in hours, as the browser renders it. */
async function monthTotal(page) {
  const text = await page.locator(".card .big").first().textContent().catch(() => null);
  if (!text) return undefined;
  const m = /(\d+)h\s*(\d+)m/.exec(text);
  return m ? Number(m[1]) + Number(m[2]) / 60 : undefined;
}

await main().catch((err) => {
  console.error(`journey: ${err.message}`);
  process.exit(1);
});
