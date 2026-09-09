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

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimAndApprove, MOBILE, root, startRig, visibleText } from "./harness.mjs";

const dataDir = join(root, ".journey-data");
const PORT = 41778;
const HTTP_PORT = 5400;

const TAG = "Journey work";

/**
 * A minimal but real Ogg page, so `setInputFiles` hands the app something a browser will accept as
 * audio rather than a text file with an audio MIME type.
 *
 * It is a fixture, not music: what section 14 stores and reloads is a name and a byte count, and
 * playback is the browser's problem. Base64 rather than a file on disk because a binary fixture
 * that nothing can read is the sort of thing that rots without anyone noticing.
 */
const OGG_BYTES = Buffer.from(
  "T2dnUwACAAAAAAAAAABtSAAAAAAAAKvhFJ0BHgF2b3JiaXMAAAAAAUSsAAAAAAAAgLsAAAAAAAC4AQ==",
  "base64",
);

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
  // A one-second mean makes the first ten-second poll after a timer starts a certainty (5.31's
  // cap), which is the only way a memoryless process becomes something a test can wait for.
  const rig = await startRig({
    dataDir,
    port: PORT,
    httpPort: HTTP_PORT,
    seedEnv: { WORKLOG_SEED_PROMPT_MS: "1000" },
  });
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

  // 24.8 — in History, which is now the only place entries are listed. The timer screen used to
  // carry a read-only copy of the same rows.
  await nav(desktop.page, "History");
  check(
    "stopping records the entry, and History shows it",
    await until(
      "entry present",
      desktop.page,
      async (p) => (await p.getByText(TAG).count()) > 0,
    ),
  );
  await nav(desktop.page, "Timer");
  // Not "Not working": the phone said that before the timer ever started, so it could not
  // disagree. The entry carrying this run's tag is something that was not there a moment ago.
  await nav(mobile.page, "History");
  check(
    "and the entry reaches the phone",
    await until(
      "phone entry",
      mobile.page,
      async (p) => (await p.getByText(TAG).count()) > 0,
    ),
  );

  // ---------------------------------------------------------------- the prompt
  //
  // 5.6–5.20, and 1.13's "the server controls globally coordinated events". This is the one feature
  // where the *server* starts something and every connected frontend has to present it — not a
  // response to a request, and not a broadcast that merely invalidates a cache. Nothing else in
  // this file or the unit tests exercises `PromptHub` end to end.
  //
  // It only fires while a timer runs (5.13), so this section runs one of its own.
  console.log("\nprompt:");
  await nav(desktop.page, "Timer");
  await desktop.page.getByLabel("Billing tag").fill("Prompted work");
  await desktop.page.getByRole("button", { name: /Start/ }).click();

  const asked = "What are you working on?";
  check(
    "the server asks, without being asked",
    await until("prompt on desktop", desktop.page, (p) => p.getByText(asked).isVisible(), 40_000),
  );
  // 5.17 — *each* notified frontend presents it. A prompt only one device sees is a prompt the
  // person answers once and is then asked again on the other.
  check(
    "and asks the phone too",
    await until("prompt on phone", mobile.page, (p) => p.getByText(asked).isVisible(), 40_000),
  );

  await desktop.page.getByRole("textbox").first().fill("Answering the prompt.");
  await desktop.page.getByRole("button", { name: "Save note" }).click();
  check(
    "answering closes it",
    await until(
      "prompt gone",
      desktop.page,
      async (p) => (await p.getByText(asked).count()) === 0,
    ),
  );
  // 5.21 — the other device's copy is dismissible and costs nothing; it is not left blocking.
  await mobile.page.getByRole("button", { name: "Not now" }).click();

  await desktop.page.getByRole("button", { name: /Stop/ }).click();
  await until(
    "timer stopped",
    desktop.page,
    async (p) => (await p.getByText("Not working").count()) > 0,
  );

  // ---------------------------------------------------------------- recording time from the phone
  console.log("\npast time from the phone:");
  await nav(mobile.page, "History");
  await nav(desktop.page, "History");
  const before = await monthTotal(desktop.page);
  check("the desktop's history screen shows a month total", before !== undefined);

  // 25.30 — reached from a control in the list rather than from a form pinned above it, and it is
  // the same editor the Edit link opens.
  await mobile.page.getByRole("button", { name: "Add past time" }).click();
  await mobile.page.getByRole("dialog").waitFor({ timeout: 15_000 });
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

  // ---------------------------------------------------------------- refusals, not defaults
  //
  // 24.1 is the principle behind most of this review, and its two sharpest cases are here. Both
  // are unit-tested; what is not is that the refusal *reaches the person*, which is the whole
  // difference between a rule and a silently-swallowed promise rejection.
  console.log("\nrefusals:");
  await nav(desktop.page, "Settings");

  // 24.42 — a region that no holiday in the country names. It used to save happily and then drop
  // every state holiday from the pacing arithmetic with nothing on screen to say why.
  const region = desktop.page.getByLabel("Holiday region");
  const goodRegion = await region.inputValue();
  await region.fill("AU-XYZ");
  await desktop.page.getByRole("button", { name: "Save", exact: true }).first().click();
  check(
    "a nonsense holiday region is refused, on screen, saying why",
    await until(
      "region refused",
      desktop.page,
      async (p) => (await p.getByText(/AU-XYZ/).count()) > 0,
    ),
  );
  await region.fill(goodRegion);
  await desktop.page.getByRole("button", { name: "Save", exact: true }).first().click();
  await desktop.page.waitForTimeout(600);

  // 24.31 — an invoice cannot be produced from an incomplete configuration, and the refusal names
  // what is missing rather than rendering a document with holes in it.
  const clientName = desktop.page.getByLabel("Client name");
  const goodClient = await clientName.inputValue();
  await clientName.fill("");
  await desktop.page.getByRole("button", { name: "Save invoice details" }).click();
  await desktop.page.waitForTimeout(600);

  await nav(desktop.page, "Invoices");
  await desktop.page.getByRole("button", { name: "New invoice" }).click();
  check(
    "an incomplete invoice configuration is refused, naming the field",
    await until(
      "config refused",
      desktop.page,
      async (p) => (await p.getByText(/client's name/).count()) > 0,
    ),
  );

  await nav(desktop.page, "Settings");
  await desktop.page.getByLabel("Client name").fill(goodClient);
  await desktop.page.getByRole("button", { name: "Save invoice details" }).click();
  await desktop.page.waitForTimeout(600);

  // ---------------------------------------------------------------- invoicing, and the PDF
  //
  // 24.25–24.31. One list, actions on the rows, dialogs for the two that cannot be undone by
  // clicking again, and a PDF that is frozen at issue rather than re-rendered on each download.
  console.log("\ninvoice:");
  await nav(desktop.page, "Invoices");

  // 25.8 — one control, always here, with the month beside it. It used to be a per-month button
  // that vanished once that month had a draft.
  const newInvoice = desktop.page.getByRole("button", { name: "New invoice" });
  const monthPicker = desktop.page.getByLabel("Month");
  await newInvoice.waitFor({ timeout: 15_000 });
  // 25.9 — prefilled to last month, which is the month you invoice.
  const prefilled = await monthPicker.locator("option:checked").textContent() ?? "";
  check("25.9 — the month is prefilled to last month", prefilled === "August 2026", prefilled);

  // ...and then moved off it deliberately. The seed already ships an August draft, so every count
  // below would be measuring two invoices and attributing it to one. September has work in it and
  // no invoice, which is what makes "how many rows are there for this month" answerable.
  const preparing = "September 2026";
  await monthPicker.selectOption({ label: preparing });
  await newInvoice.click();
  check(
    "a prepared invoice appears in the list as a draft",
    await until(
      "draft",
      desktop.page,
      (p) => p.getByText("Draft", { exact: true }).first().isVisible(),
    ),
  );

  const invoiceRow = () =>
    desktop.page.locator(".stacked-row").filter({ hasText: preparing }).first();

  // 8.33 — the download, which is the whole reason the button exists.
  const firstDownload = desktop.page.waitForEvent("download", { timeout: 20_000 }).catch(() =>
    undefined
  );
  await invoiceRow().getByRole("button", { name: "Download" }).click();
  const draftPdf = await firstDownload;
  check("a draft's PDF downloads", draftPdf !== undefined);
  if (draftPdf) {
    const head = (await readFile(await draftPdf.path())).subarray(0, 5).toString("latin1");
    check("and it is a PDF", head === "%PDF-", JSON.stringify(head));
  }

  // 11.4 — generating changed no state.
  check(
    "generating did not issue anything",
    await desktop.page.getByText("Draft", { exact: true }).first().isVisible(),
  );

  // 24.29 — issuing asks in a dialog.
  await invoiceRow().getByRole("button", { name: "Issue", exact: true }).click();
  check(
    "issuing asks first, in a dialog",
    await until(
      "issue dialog",
      desktop.page,
      async (p) => (await p.getByRole("dialog").count()) > 0,
    ),
  );
  await desktop.page.getByRole("button", { name: "Issue it" }).click();
  check(
    "and issuing moves it out of draft",
    await until(
      "issued",
      desktop.page,
      (p) => p.getByText("Issued", { exact: true }).first().isVisible(),
    ),
  );

  // 24.30 — the frozen document. Issued invoices serve the stored file rather than re-rendering,
  // so downloading twice must give the same bytes even though nothing stops the config changing
  // in between. Byte equality is the only assertion that distinguishes the two.
  const secondDownload = desktop.page.waitForEvent("download", { timeout: 20_000 }).catch(() =>
    undefined
  );
  await invoiceRow().getByRole("button", { name: "Download" }).click();
  const issuedPdf = await secondDownload;
  check("an issued invoice's PDF downloads", issuedPdf !== undefined);
  let frozenBytes;
  if (issuedPdf) {
    frozenBytes = await readFile(await issuedPdf.path());
    check("and it is a PDF", frozenBytes.subarray(0, 5).toString("latin1") === "%PDF-");
  }

  const thirdDownload = desktop.page.waitForEvent("download", { timeout: 20_000 }).catch(() =>
    undefined
  );
  await invoiceRow().getByRole("button", { name: "Download" }).click();
  const again = await thirdDownload;
  check(
    "and it is frozen: the same bytes every time",
    again !== undefined && frozenBytes !== undefined &&
      Buffer.compare(frozenBytes, await readFile(await again.path())) === 0,
  );

  // 25.10 — the reverse of what this used to assert. The month being spoken for used to remove
  // the control; now a second draft for an issued month can be made freely, because preparing a
  // replacement while the wrong one is still out is the ordinary way to correct one. 11.19 bites
  // at issuance and nowhere earlier.
  await newInvoice.click();
  const secondDraft = await until(
    "second draft",
    desktop.page,
    async (p) => (await p.locator(".stacked-row").filter({ hasText: preparing }).count()) === 2,
  );
  check("25.10 — a second draft for an issued month is allowed", secondDraft);

  const draftRow = desktop.page.locator(".stacked-row").filter({ hasText: "Draft" }).first();
  await draftRow.getByRole("button", { name: "Issue", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Issue it" }).click();
  check(
    "and 11.19 refuses it at issuance, saying what covers the month",
    await until(
      "issue refused",
      desktop.page,
      async (p) => (await p.getByText(/already covered by/).count()) > 0,
    ),
    await visibleText(desktop.page),
  );

  // 25.11 — and the draft's lines are its own. Edited here, and History is checked afterwards.
  await draftRow.getByRole("button", { name: "Edit lines" }).click();
  await desktop.page.getByRole("button", { name: "Add a line" }).waitFor({ timeout: 15_000 });
  const lineCount = await desktop.page.locator(".linerow").count();
  check(
    "25.11 — the draft opens with the lines copied from the work",
    lineCount > 0,
    `${lineCount}`,
  );

  await desktop.page.getByLabel("Hours on line 1", { exact: true }).fill("1.5");
  await desktop.page.getByLabel("Description on line 1", { exact: true }).fill("Revised scope");
  await desktop.page.getByRole("button", { name: "Save the draft" }).click();
  check(
    "and an edit sticks without touching the entries",
    await until(
      "edit saved",
      desktop.page,
      async (p) => (await p.locator(".linerow").count()) === 0,
    ),
  );

  // Scoped to the row this block created. `getByRole("button", {name: "Delete"}).first()` picks
  // the first Delete *on the page*, and with two August rows in the list that is a coin flip
  // between the draft and the issued invoice the checks below still need.
  await draftRow.getByRole("button", { name: "Delete" }).click();
  await desktop.page.getByRole("button", { name: "Delete it" }).click();
  await until(
    "second draft gone",
    desktop.page,
    async (p) => (await p.locator(".stacked-row").filter({ hasText: preparing }).count()) === 1,
  );

  // 24.27 — paid, and back again, from the row.
  await invoiceRow().getByRole("button", { name: "Mark paid" }).click();
  check(
    "marking paid works from the row",
    await until(
      "paid",
      desktop.page,
      (p) => p.getByText("Paid", { exact: true }).first().isVisible(),
    ),
  );

  // 24.28 — and it can be deleted, paid or not. Without this the only ways out of a mistake were
  // reverting an issued invoice forever or living with it, which is why "every action should be
  // reversible" was the note against this screen.
  await invoiceRow().getByRole("button", { name: "Delete" }).click();
  check(
    "deleting a paid invoice asks first",
    await until(
      "delete dialog",
      desktop.page,
      async (p) => (await p.getByRole("dialog").count()) > 0,
    ),
  );
  await desktop.page.getByRole("button", { name: "Delete it" }).click();
  check(
    "and then it is gone, freeing the month",
    await until(
      "deleted",
      desktop.page,
      async (p) => (await p.locator(".stacked-row").filter({ hasText: preparing }).count()) === 0,
    ),
  );

  // Prepared again, because the checks further down watch an invoice reach the phone and the
  // delete above left the month empty. Re-preparing is also the proof that deleting freed it.
  await newInvoice.click();
  await until(
    "re-prepared",
    desktop.page,
    (p) => p.getByText("Draft", { exact: true }).first().isVisible(),
  );

  // 25.27 — the start of a running session is editable. The case is forgetting to press Start:
  // you notice at 11:20 that you began at 09:30, and the choice used to be between stopping and
  // hand-adding a past entry, or recording the wrong thing.
  console.log("\nmoving a running start:");
  await nav(desktop.page, "Timer");
  await desktop.page.getByRole("button", { name: /Start/ }).click();
  const startLink = desktop.page.locator(".muted button.link").first();
  await startLink.waitFor({ timeout: 15_000 });
  check(
    "the start of the running session is shown",
    /^\d{2}:\d{2}$/.test(
      (await startLink.textContent())?.trim() ?? "",
    ),
  );
  await startLink.click();
  await desktop.page.getByLabel("Started at").fill("06:15");
  await desktop.page.getByRole("button", { name: "Move the start" }).click();
  check(
    "25.27 — and it can be moved",
    await until(
      "start moved",
      desktop.page,
      async (p) =>
        (await p.locator(".muted button.link").first().textContent())?.trim() === "06:15",
    ),
  );
  // A future start is refused rather than making every figure below it negative.
  await startLink.click();
  await desktop.page.getByLabel("Started at").fill("23:59");
  await desktop.page.getByRole("button", { name: "Move the start" }).click();
  check(
    "and a start in the future is refused, on screen",
    await until(
      "future refused",
      desktop.page,
      async (p) => (await p.getByText(/cannot have started in the future/).count()) > 0,
    ),
    await visibleText(desktop.page),
  );
  await desktop.page.getByRole("button", { name: "Cancel" }).click();
  await desktop.page.getByRole("button", { name: /Stop/ }).click();
  await desktop.page.waitForTimeout(600);

  // ---------------------------------------------------------------- editing what was recorded
  console.log("\nediting:");
  await nav(desktop.page, "History");
  const beforeEdit = await monthTotal(desktop.page);
  // The timer above ran for about two seconds; editing it to 09:00–11:30 replaces that with 2.5h.
  const shortSessionHours = 2 / 3600;

  // 24.12 — the times are editable, in the shared editor (25.30). The fields were called "Start
  // time" and "End time" when they were a table row of their own; the one editor calls them From
  // and To, the same as when adding, which is most of the point of there being one.
  const row = desktop.page.getByRole("row").filter({ hasText: TAG }).first();
  await row.getByRole("button", { name: "Edit" }).click();
  await desktop.page.getByRole("dialog").waitFor({ timeout: 15_000 });

  // 25.28 — the duration is the interval, and the field says so by being unavailable rather than
  // by accepting a number and discarding it, which is what it used to do.
  const howLong = desktop.page.getByLabel("How long");
  check("25.28 — a timed entry's duration cannot be typed into", await howLong.isDisabled());

  const spanBefore = await howLong.inputValue();
  await desktop.page.getByLabel("From").fill("09:00");
  await desktop.page.getByLabel("To").fill("11:30");
  // 25.29 — before saving, not after.
  check(
    "25.29 — and it recomputes as the times are typed",
    (await howLong.inputValue()) === "2.5h",
    `${spanBefore} -> ${await howLong.inputValue()}`,
  );
  await desktop.page.getByRole("button", { name: "Save", exact: true }).click();

  check(
    "editing the times changes the times",
    await until(
      "times edited",
      desktop.page,
      async (p) => (await p.getByText("09:00 – 11:30").count()) > 0,
    ),
  );
  // The duration is the interval; there is no third number to disagree with it.
  check(
    "and the duration follows them",
    await until(
      "duration follows",
      desktop.page,
      async (p) => {
        const now = await monthTotal(p);
        return now !== undefined && beforeEdit !== undefined &&
          Math.abs(now - (beforeEdit - shortSessionHours + 2.5)) < 0.05;
      },
    ),
    `was ${beforeEdit}h`,
  );

  // Read again: the time edit above moved the month total, so `beforeEdit` is stale by now.
  const beforeDelete = await monthTotal(desktop.page);

  // 24.13 — deleting asks first. A single click used to be enough, which for a record with no
  // undo is one mis-aim away from losing an afternoon.
  const doomed = desktop.page.getByRole("row").filter({ hasText: "Phone entry" }).first();
  await doomed.getByRole("button", { name: "Delete", exact: true }).click();
  check(
    "deleting asks before it deletes",
    await until(
      "confirm shown",
      desktop.page,
      async (p) => (await p.getByRole("button", { name: "Yes, delete" }).count()) > 0,
    ),
  );
  await desktop.page.getByRole("button", { name: "Yes, delete" }).click();
  check(
    "deleting takes its hours out of the month",
    await until(
      "deleted",
      desktop.page,
      async (p) => {
        const now = await monthTotal(p);
        return now !== undefined && beforeDelete !== undefined &&
          Math.abs(now - (beforeDelete - 2.5)) < 0.05;
      },
    ),
    `expected ${beforeDelete === undefined ? "?" : beforeDelete - 2.5}h`,
  );

  // ---------------------------------------------------------------- a work note
  console.log("\nwork note:");
  await nav(desktop.page, "Notes");
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
  await nav(mobile.page, "Notes");
  check(
    "and reaches the other one",
    await until(
      "note on phone",
      mobile.page,
      (p) => p.getByText("Wrote the journey harness.").isVisible(),
    ),
  );

  // ---------------------------------------------------------------- a voice note
  //
  // 5.3, 5.23–5.29. The longest untested path in the product: MediaRecorder in the tab, base64 up
  // the wire, a *file on the server's disk* (17.10) rather than a row, and `note-audio` reading it
  // back on request. The disk write in particular has nothing else that touches it.
  //
  // The browser has a synthetic microphone (see `harness.mjs`); without one this whole feature is
  // unreachable from a test, which is most of why it had never been run.
  console.log("\nvoice note:");
  await nav(desktop.page, "Notes");
  await desktop.page.getByRole("button", { name: "New work note" }).click();

  const record = desktop.page.getByRole("button", { name: /Record$/ });
  if (await record.count() === 0) {
    check("the browser offers recording", false, await visibleText(desktop.page));
  } else {
    await record.click();
    check(
      "recording starts",
      await until(
        "recording",
        desktop.page,
        (p) => p.getByText(/● recording/).isVisible(),
      ),
    );
    // Long enough to be a real Opus frame rather than an empty container.
    await desktop.page.waitForTimeout(1_500);

    // 24.5 — the trace has to *move*. Chromium's fake device plays a tone, so a meter that is
    // wired up produces varying bar heights; one that is not produces a row of identical floors,
    // which is also exactly what a dead microphone looks like. That ambiguity is the whole reason
    // the trace exists, so the check is on variety rather than on the element being present.
    const heights = await desktop.page.locator(".trace span").evaluateAll((els) =>
      els.map((e) => e.style.height)
    );
    check("the recording trace is drawn", heights.length > 0, `${heights.length} bars`);
    check(
      "and it moves with the input rather than sitting flat",
      new Set(heights).size > 3,
      `${new Set(heights).size} distinct heights`,
    );

    await desktop.page.getByRole("button", { name: "Stop", exact: true }).click();

    // 5.28 — playable before it is even saved.
    check(
      "and the recording can be heard back before saving",
      await until(
        "player",
        desktop.page,
        async (p) => (await p.locator("audio").count()) > 0,
      ),
    );

    await desktop.page.getByRole("button", { name: "Save note" }).click();

    // 5.24 — retained. The list shows a duration only when the server kept the audio, and the
    // duration comes back from the row while the bytes come back from the file.
    check(
      "the saved note comes back with its recording",
      await until(
        "audio note listed",
        desktop.page,
        async (p) => (await p.getByRole("button", { name: /▶ Play \d+s/ }).count()) > 0,
      ),
    );

    // 5.28 again, but the round trip that matters: this fetches `note-audio`, which reads the file
    // the server wrote. A row with a duration and no file behind it would pass everything above.
    await desktop.page.getByRole("button", { name: /▶ Play \d+s/ }).first().click();
    check(
      "and the bytes come back off the server's disk",
      await until(
        "playback",
        desktop.page,
        async (p) => (await p.locator("audio[src^='blob:']").count()) > 0,
      ),
    );
  }

  // ---------------------------------------------------------------- the local loop
  //
  // Section 14, which has no end-to-end coverage at all: `gain.ts` has the decibel curve under
  // unit test, and everything around it — storing a file, surviving a reload, and above all
  // *staying on this device* — has none.
  //
  // 14.16 and 14.17 are the interesting claim, and they are a cross-device negative: two devices
  // configure this independently and neither the server nor the other one can tell. A negative is
  // exactly what one browser cannot check, so it is checked here by configuring the desktop and
  // then looking at the phone.
  console.log("\nlocal audio:");
  await nav(desktop.page, "Settings");
  await desktop.page.locator('input[type="file"]').setInputFiles({
    name: "loop.ogg",
    mimeType: "audio/ogg",
    buffer: OGG_BYTES,
  });
  check(
    "a chosen file is copied onto this device",
    await until(
      "loop stored",
      desktop.page,
      (p) => p.getByText(/loop\.ogg/).isVisible(),
    ),
  );

  await desktop.page.reload();
  await desktop.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });
  await nav(desktop.page, "Settings");
  check(
    "and is still there after a reload",
    await until(
      "loop persisted",
      desktop.page,
      (p) => p.getByText(/loop\.ogg/).isVisible(),
    ),
  );

  // 14.3–14.5, 16.1, 16.3. The phone is authorised, connected, and looking at the same server.
  //
  // 25.20 reversed 14.25, and this check went with it. It used to assert the phone had no audio
  // card *at all* — and passing was the problem, because what a phone actually showed was a
  // settings screen with a section silently missing and nothing to say why. The reasoning behind
  // 14.25 was about the autoplay policy, which turned out to apply to the desktop too (25.19); the
  // answer to a policy that wants a gesture is a button, not an absence.
  //
  // Two checks, because the pair is what has content: the settings screen is up, and the feature
  // is on it. An earlier version asserted only the negative, with a canary waiting for the file
  // chooser — the canary went red and was right to, since the chooser is never on a phone and so
  // "no loop.ogg here" was a sentence that could not have been false.
  await nav(mobile.page, "Settings");
  const phoneSettings = await until(
    "phone settings",
    mobile.page,
    (p) => p.getByText("Working hours").isVisible(),
  );
  check("the phone's settings screen is up", phoneSettings);
  check(
    "and 25.20 puts the looping audio on it",
    phoneSettings &&
      (await mobile.page.getByText(/Background audio, on this device/).count()) > 0,
    await visibleText(mobile.page),
  );

  // ------------------------------------------------------------- numbers you can type
  //
  // 25.44 and 25.3, on the field that had both faults. The rate went out through the model and
  // came back formatted on every keystroke, so "1" became "1.00" with the caret past the end; and
  // `Number(v) || 0` meant anything unparseable was stored as zero and saved without a word.
  //
  // Typed a character at a time on purpose. `fill()` sets the value in one go and would pass
  // against the old code, because the round trip only shows up between keystrokes.
  console.log("\nnumber fields:");
  await nav(desktop.page, "Settings");
  const rate = desktop.page.getByLabel("Hourly rate");
  await rate.waitFor({ timeout: 15_000 });
  await rate.fill("");
  await rate.pressSequentially("125");
  check(
    "25.44 — typing 125 leaves 125 in the field",
    await rate.inputValue() === "125",
    await rate.inputValue(),
  );

  await desktop.page.getByLabel("Currency").click();
  check(
    "and leaving it is when the formatting arrives",
    await rate.inputValue() === "125.00",
    await rate.inputValue(),
  );

  await rate.fill("abc");
  const saveInvoice = desktop.page.getByRole("button", { name: "Save invoice details" });
  check(
    "25.3 — an unreadable rate is kept, not silently replaced",
    await rate.inputValue() === "abc",
  );
  check(
    "and it is named, marked, and blocks the save",
    (await rate.getAttribute("aria-invalid")) === "true" &&
      (await saveInvoice.isDisabled()) &&
      (await desktop.page.getByText(/the hourly rate is\s+not a number/i).count()) > 0,
    await visibleText(desktop.page),
  );
  // 25.2 — refused, not removed. A vanished button reads as "you cannot do this at all".
  check("and the save button is still on the screen", await saveInvoice.isVisible());

  await rate.fill("120");
  check("and the save comes back once it parses", !(await saveInvoice.isDisabled()));

  // 24.6 — and a note can be deleted, recording and all.
  await nav(desktop.page, "Notes");
  const noteRow = desktop.page.locator(".stacked-row").filter({ hasText: /Voice note|Wrote the/ })
    .first();
  await noteRow.getByRole("button", { name: "Delete" }).click();
  check(
    "deleting a note asks first",
    await until(
      "note confirm",
      desktop.page,
      async (p) =>
        (await p.getByRole("button", { name: "Delete", exact: true }).count()) > 0 &&
        (await p.getByText("Delete this note?").count()) > 0,
    ),
  );
  const notesBefore = await desktop.page.locator(".stacked-row").count();
  // Scoped to the row. `page.getByRole(...).last()` picks the *last* Delete on the page, which is
  // the bottom note's link, so the confirm opened on one row and the click landed on another —
  // and the check then reported "the note did not go", which was true and not the reason.
  await noteRow.getByRole("button", { name: "Delete", exact: true }).click();
  check(
    "and the note goes",
    await until(
      "note gone",
      desktop.page,
      async (p) => (await p.locator(".stacked-row").count()) < notesBefore,
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
      // The number, not the spelling. This was `getByText("120h 0m")` and 25.6 broke it — a check
      // that pins today's formatting fails for a reason that has nothing to do with what it is
      // about, which is that a figure set on one device reached another one.
      async (p) => (await p.getByText(/\b120(\.0)?h\b/).count()) > 0,
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

  // 24.41 — the two bars, which are the pacing screen's whole answer now. Checked as *fills*
  // rather than as text: the claim is that being ahead is visible as an offset between them, and a
  // pair of numbers in the DOM would satisfy a test while the bars sat identical.
  const fills = await desktop.page.locator(".barline .bar > span").evaluateAll((els) =>
    els.map((e) => Number.parseFloat(e.style.width))
  );
  check("the pacing screen draws both bars", fills.length === 2, JSON.stringify(fills));
  check(
    "and worked is ahead of elapsed, which is what 'ahead' means",
    fills.length === 2 && fills[1] > fills[0],
    `elapsed ${fills[0]}%, worked ${fills[1]}%`,
  );

  // 25.25 — and the comparison above is only readable if the two tracks are the same track. They
  // were not: the label column was fixed but the two columns after the bar were `auto`, so "of the
  // target" and "of the scheduled hours" reserved different widths and each bar ended somewhere
  // else. A percentage check cannot see that; the geometry can.
  const tracks = await desktop.page.locator(".barline .bar").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    })
  );
  check(
    "25.25 — both bars start and end at the same x",
    tracks.length === 2 && tracks[0].left === tracks[1].left &&
      tracks[0].right === tracks[1].right,
    JSON.stringify(tracks),
  );

  // 25.46 — neither arrow moves as the month changes, so pressing ‹ twice does not mean chasing it.
  const arrowX = async () =>
    (await desktop.page.locator(".month-nav button").first().boundingBox()).x;
  const beforeArrow = await arrowX();
  await desktop.page.locator(".month-nav button").first().click();
  await desktop.page.waitForTimeout(300);
  check("25.46 — the back arrow stays put when the month changes", await arrowX() === beforeArrow);
  await desktop.page.getByRole("button", { name: "This month" }).click();
  await desktop.page.waitForTimeout(300);

  // 25.26 — today's bar is assembled from the sessions it was made of.
  await nav(desktop.page, "Timer");
  const segmentsBefore = await desktop.page.locator(".bar.segmented > span").count();
  await desktop.page.getByRole("button", { name: /Start/ }).click();
  await desktop.page.waitForTimeout(1200);
  await desktop.page.getByRole("button", { name: /Stop/ }).click();
  const grew = await until(
    "segment added",
    desktop.page,
    async (p) => (await p.locator(".bar.segmented > span").count()) > segmentsBefore,
  );
  check("25.26 — a session adds a segment to today's bar", grew, `${segmentsBefore}`);
  // Each with its own rounded ends, which is only true if the track is not clipping them.
  const clipped = await desktop.page.locator(".bar.segmented").evaluate((e) =>
    getComputedStyle(e).overflow
  );
  check("and the track does not clip their ends back to square", clipped === "visible", clipped);

  // 24.19, 24.20, 24.21 — the things that made this screen busy are gone.
  for (const gone of ["How the projection adds up", "Public holidays used", "Monthly target"]) {
    check(
      `"${gone}" is off the pacing screen`,
      (await desktop.page.getByText(gone).count()) === 0,
    );
  }

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
    "an invoice acted on at the desktop reaches the phone's list",
    await until(
      "issued on phone",
      mobile.page,
      async (p) => (await p.getByText(/Draft|Issued|Paid/).count()) > 0,
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
    // The control, not the dialog's submit button. 25.30 moved adding behind "Add past time", and
    // `{name: "Add"}` then matched nothing for anybody — a check that had stopped being able to
    // fail while still reading as though it were guarding something.
    "and cannot add past time",
    (await spare.page.getByRole("button", { name: "Add past time" }).count()) === 0,
  );

  await nav(spare.page, "Invoices");
  check(
    "and cannot prepare an invoice",
    (await spare.page.getByRole("button", { name: "New invoice" }).count()) === 0,
  );
  check(
    "but can still read one",
    await until(
      "invoice visible to read",
      spare.page,
      async (p) => (await p.getByText(/Draft|Issued|Paid/).count()) > 0,
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
 * Hours out of whatever the screen rendered, as a number.
 *
 * 25.6 changed every duration from `3h 14m` to `3.2h`, and these two readers went red together —
 * which is the right failure, but it is worth only having one of them. Both spellings are accepted
 * because being able to read the old one is what makes this a check on the *value* rather than a
 * second copy of the formatter: a reader that only understands today's format cannot tell a
 * changed number from a changed unit.
 */
function readHours(text) {
  const decimal = /(-?\d+(?:\.\d+)?)\s*h(?![a-z0-9])/i.exec(text);
  const hm = /(-?\d+)h\s*(\d+)m/.exec(text);
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60;
  return decimal ? Number(decimal[1]) : undefined;
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
  return readHours(text);
}

/** The month figure on the History screen, in hours, as the browser renders it. */
async function monthTotal(page) {
  const text = await page.locator(".card .big").first().textContent().catch(() => null);
  if (!text) return undefined;
  return readHours(text);
}

await main().catch((err) => {
  // The stack, not just the message: every locator in this file times out with the same sentence.
  console.error(`journey: ${err.stack ?? err.message}`);
  process.exit(1);
});
