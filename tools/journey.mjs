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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimAndApprove, DESKTOP, MOBILE, root, startRig, visibleText } from "./harness.mjs";

const dataDir = join(root, ".journey-data");
const PORT = 41778;
const HTTP_PORT = 5400;

const TAG = "Journey work";

/**
 * A minimal but real Ogg page, so `setInputFiles` hands the app something a browser will accept as
 * audio rather than a text file with an audio MIME type.
 *
 * **It has to be decodable now.** It was a 60-byte Ogg header, which was enough while the only
 * claim was that section 14 stores a name and a byte count — and useless the moment the checks
 * became about whether the loop actually *plays* (26.3, 26.5). A stub that cannot decode makes
 * `play()` reject, which looks exactly like the bug being tested for.
 *
 * Synthesised rather than committed as a binary: WAV needs no codec in any browser, the header is
 * eleven fields, and a fixture nobody can read is the sort of thing that rots unnoticed.
 */
function toneWav(seconds = 0.4, hz = 440, rate = 8_000) {
  const frames = Math.floor(rate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(12_000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); // PCM header length
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); // bytes per second
  head.writeUInt16LE(2, 32); // block align
  head.writeUInt16LE(16, 34); // bits
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const LOOP_BYTES = toneWav();

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

/**
 * Close whatever sheet is open, if any.
 *
 * The seed sets a one-second prompt mean so the prompt section has something to catch, which means
 * a prompt panel can appear over *any* screen at *any* point in the run — and the next click then
 * lands on the overlay instead of the control, failing hundreds of lines from its cause. 26.9 made
 * dismissing one that has content ask first, so the confirmation is answered too.
 */
/**
 * 26.12 — an invoice's state, read and set through the one control that now carries it.
 *
 * Four buttons became a `<select>`, so "is it a draft" is the value of a control rather than the
 * presence of a word on the page. Reading it as text still worked for a while, because "Draft" is
 * also an option label — which is exactly the kind of accidental pass worth not relying on.
 */
const stateOf = (row) => row.getByRole("combobox").inputValue();

/**
 * 26.11 — open an invoice's PDF in the viewer and read the bytes the viewer is showing.
 *
 * The old checks waited for a `download` event, which no longer happens: the button hands the file
 * to an iframe over a blob URL instead of to the browser's downloader. Reading the blob back
 * through `fetch` in the page is a stronger check than the download was, because it asserts the
 * bytes *the person is looking at* rather than the bytes of a second request that happened to be
 * made at the same time.
 */
async function viewPdf(page, row) {
  await row.getByRole("button", { name: "View" }).click();
  const frame = page.locator("iframe.viewer-frame");
  await frame.waitFor({ state: "visible", timeout: 20_000 });
  const src = await frame.getAttribute("src");
  const bytes = src?.startsWith("blob:")
    ? Buffer.from(
      await page.evaluate(
        async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
        src,
      ),
    )
    : undefined;
  await page.getByRole("button", { name: "Close" }).click();
  await frame.waitFor({ state: "detached", timeout: 10_000 });
  return { src, bytes };
}
const setStateTo = async (row, value) => {
  await row.getByRole("combobox").selectOption(value);
  await row.page().waitForTimeout(700);
};

/**
 * Source that escaped into the page.
 *
 * A JSX comment written bare — `/* ... *\/` between two tags, without the surrounding braces — is
 * not a comment. It is text, and it renders. Four lines of reasoning about why issuing needs no
 * confirmation appeared under every invoice row that way, and nothing else here would have
 * noticed: it is visible, it has contrast, it has no role, it is simply prose nobody wrote for a
 * reader. The same scan catches a stray `{...}` or an arrow function stringified into content.
 */
async function sourceOnScreen(page, where) {
  const found = await page.evaluate(() =>
    [...document.body.querySelectorAll("*")]
      .flatMap((el) => [...el.childNodes])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? "")
      .filter((t) => /\/\*|\*\/|=>\s*\{|\bfunction\s*\(/.test(t))
      .map((t) => t.trim().slice(0, 60))
  );
  return found.map((t) => `${where}: ${t}`);
}

/**
 * 26.17 — a checkbox on a line with fields, sitting at a different height from them.
 *
 * A row that bottom-aligns a one-line checkbox against a caption-plus-control field puts the two
 * sets of words half a control apart. Written as a sweep rather than a check on the one row that
 * was reported, because the row that was reported is not interesting — the arrangement is, and it
 * is available to every screen.
 */
async function checkboxAlignment(page, where) {
  const off = await page.evaluate(() =>
    [...document.querySelectorAll(".row")].flatMap((row) => {
      const box = [...row.children].find((c) => c.querySelector?.('input[type="checkbox"]'));
      const field = [...row.querySelectorAll("input:not([type=checkbox]), select")]
        .find((i) => !box?.contains(i));
      if (!box || !field) return [];
      const a = box.getBoundingClientRect(), b = field.getBoundingClientRect();
      // Only things actually side by side. A `wrap` row on a narrow phone is two lines, and two
      // things on different lines are not misaligned with each other — they do not overlap at all,
      // which is a sounder test than any distance between their tops.
      if (!a.height || !b.height || a.bottom <= b.top || b.bottom <= a.top) return [];
      const dy = Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2);
      return dy > 4
        ? [`${(box.textContent ?? "").trim().slice(0, 28)} is ${dy.toFixed(1)}px off`]
        : [];
    })
  );
  return off.map((t) => `${where}: ${t}`);
}

/**
 * 26.16 — the captions the invoice settings uses are the document's own.
 *
 * The point of `shared/invoiceLook.ts` is that the form and the renderer caption the same value
 * with the same words, so that checking a printed invoice against these settings is a matter of
 * finding the same phrase in both. A caption written by hand into the form defeats that while
 * looking completely fine on screen — which is how "Your ABN" sat over the field that prints under
 * "ABN:" for as long as it did.
 *
 * The allowed set is read out of the module rather than copied here, because a third copy of these
 * strings is the same bug in a different file.
 */
const documentCaptions = () => {
  const src = readFileSync(join(root, "shared/invoiceLook.ts"), "utf8");
  const from = src.indexOf("export const INVOICE_LABELS");
  const to = src.indexOf("} as const;", from);
  if (from < 0 || to < 0) throw new Error("INVOICE_LABELS is not where this expected it");
  return new Set([...src.slice(from, to).matchAll(/"([^"]+)"/g)].map((m) => m[1]));
};

async function invented(page) {
  const allowed = documentCaptions();
  // The card is rendered from the config, which arrives over the wire — so this has to wait for
  // it. Read the instant the screen was navigated to, the query returned nothing and the check
  // was a comparison against an empty list, which is a check that answers "fine" to anything.
  await page.locator(".invsheet-title").waitFor({ timeout: 20_000 });
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll(".invsheet-label, .invsheet-heading, .invsheet-title")]
      .map((el) => (el.textContent ?? "").trim())
      .filter(Boolean)
  );
  // A floor, for the same reason: the document has this many captions, and finding fewer means
  // the query stopped matching rather than the form being clean.
  if (shown.length < 15) throw new Error(`only ${shown.length} captions on the invoice form`);
  return shown.filter((c) => !allowed.has(c));
}

async function clearSheets(page) {
  for (let i = 0; i < 3 && (await page.getByRole("dialog").count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const discard = page.getByRole("button", { name: "Throw it away" });
    if (await discard.count()) await discard.click();
    await page.waitForTimeout(300);
  }
}

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

  /*
   * Connecting to a fresh server is quiet.
   *
   * The report was "when I connect to a fresh server, it errors after a moment, then I connect
   * again and it's fine" — over a local network, so almost certainly not a real disconnection. The
   * cause was a replaced transport marking the live one failed, and that is fixed; nothing was
   * watching for the symptom, though, and the symptom is what a person sees.
   *
   * A few seconds of watching rather than one look, because the whole complaint was that it
   * appears *after a moment*. `lastError` renders as a strip that stays until it is dismissed, so
   * anything that arrives inside the window is still on screen at the end of it.
   */
  await desktop.page.waitForTimeout(6_000);
  for (const [label, page] of [["desktop", desktop.page], ["phone", mobile.page]]) {
    const strip = await page.locator(".notice.bad").allInnerTexts();
    check(
      `connecting the ${label} to a fresh server raises nothing`,
      strip.length === 0,
      strip.join(" / "),
    );
  }

  /*
   * The day grid, before anything in this run has touched the schedule.
   *
   * Four states with four swatches in the legend, and the ladder that picks between them asks
   * "is this day in the future" first. That answer wins over "is this a workday at all", so a
   * Saturday three weeks from now is drawn as a day you might still work — and it means the red
   * state, the one the screen exists to show, is unreachable: a past workday with nothing recorded
   * has no hours remaining and no hours worked, which the ladder reads as "not a workday".
   */
  console.log("\nthe day grid:");
  await nav(desktop.page, "Pacing");
  const dayCells = async (page) =>
    await page.locator(".daygrid .day").evaluateAll((els) =>
      els.map((el) => ({
        cls: [...el.classList].filter((c) => c !== "day").join(" "),
        title: el.getAttribute("title") ?? "",
      }))
    );
  const dayOf = (title) => title.slice(0, 10);
  const workedIn = (title) => Number.parseFloat(title.split(": ")[1] ?? "");
  const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00`).getDay());

  const thisMonth = await dayCells(desktop.page);
  const todayIso = new Date().toISOString().slice(0, 10);
  const futureWeekend = thisMonth.filter((c) =>
    dayOf(c.title) > todayIso && isWeekend(dayOf(c.title))
  );
  check(
    "a weekend still to come is drawn as a non-workday, not as a day left to fill",
    futureWeekend.length > 0 && futureWeekend.every((c) => c.cls === "off"),
    `${futureWeekend.length} of them: ${[...new Set(futureWeekend.map((c) => c.cls))].join(", ")}`,
  );

  // Last month, which is entirely in the past, and which the seed does not fill every weekday of.
  await desktop.page.getByRole("button", { name: /^Go to/ }).first().click();
  await desktop.page.waitForTimeout(700);
  const lastMonth = await dayCells(desktop.page);
  const unworkedWeekdays = lastMonth.filter((c) =>
    !isWeekend(dayOf(c.title)) && workedIn(c.title) === 0
  );
  check(
    "a scheduled day that went unworked is drawn as one",
    unworkedWeekdays.length > 0 && unworkedWeekdays.every((c) => c.cls === "missed"),
    `${unworkedWeekdays.length} of them: ${
      [...new Set(unworkedWeekdays.map((c) => c.cls))].join(", ")
    }`,
  );
  await desktop.page.getByRole("button", { name: /^Go to/ }).last().click();
  await desktop.page.waitForTimeout(700);

  // ---------------------------------------------------------------- a timer, and a second device
  console.log("\ntimer:");

  /*
   * 26.19 — and the bar is the size the numbers say.
   *
   * Every segment used to be a percentage of the whole track, with a 2px gap between them and a
   * 3px minimum on each — both of which add width the data did not ask for. Starting and stopping
   * the timer a few times visibly ran the bar ahead of the day: six short sessions added ten
   * pixels of gap and up to eighteen of minimum, about six percentage points on this track. A
   * progress bar wrong in the direction of "you have done more than you have" is worse than none.
   *
   * Measured against the two figures printed beside it rather than against the model, because the
   * whole fault was that the drawing and the arithmetic disagreed.
   *
   * First thing in the run, and that placement is load-bearing. It sat later, after the entries
   * and schedule changes, where today's total is 20.3h against 8h scheduled — `progress` is
   * capped at 1, so both sides of the comparison were 1 and the check stayed green through a
   * deliberate four-point inflation of the fill. Zero error to seven decimal places was the
   * tell: a real measurement of a rendered width is never exact.
   */
  // `claimAndApprove` leaves the desktop on the admin screen.
  await nav(desktop.page, "Timer");

  // A prompt can fire at any moment; see `clearSheets`.
  await clearSheets(desktop.page);

  let worstBar = 0;
  let usable = 0;
  const readings = [];
  for (let i = 0; i < 4; i++) {
    await desktop.page.getByRole("button", { name: /Start/ }).click();
    await desktop.page.waitForTimeout(500);
    await desktop.page.getByRole("button", { name: /Stop/ }).click();
    await desktop.page.waitForTimeout(600);
    const m = await desktop.page.evaluate(() => {
      const bar = document.querySelector(".bar.segmented");
      const fill = bar?.querySelector(".bar-fill");
      const done = document.querySelector(".huge")?.textContent ?? "";
      const of = [...document.querySelectorAll("*")].map((e) => e.textContent ?? "")
        .find((t) => /^of [\d.]+h scheduled$/.test(t.trim())) ?? "";
      return {
        track: bar?.getBoundingClientRect().width ?? 0,
        fill: fill?.getBoundingClientRect().width ?? 0,
        segs: fill ? fill.children.length : 0,
        doneH: parseFloat(done),
        ofH: parseFloat(of.replace("of ", "")),
      };
    });
    // The measurement has to be a measurement. A `.huge` that is not today's figure, or a track
    // of zero width, gives a comparison that quietly succeeds — and a check that cannot fail is
    // the thing this whole exercise keeps turning up.
    readings.push(m);
    if (!(m.track > 0) || !(m.ofH > 0) || !Number.isFinite(m.doneH) || m.segs === 0) continue;
    const want = Math.min(1, m.doneH / m.ofH);
    /*
     * A full bar proves nothing.
     *
     * `progress` is capped at 1, so once the day is over its scheduled hours both sides of this
     * comparison are 1 whatever the drawing does — and this check sat green through a deliberate
     * four-point inflation of the fill because of it. It reads exactly zero error, which is the
     * tell: a real measurement of a rendered width is never exact.
     */
    if (want > 0.95) continue;
    worstBar = Math.max(worstBar, Math.abs(m.fill / m.track - want));
    usable++;
  }
  // Well inside the ~6pp the old minimums and gaps added, and outside the 0.6pp that the figure's
  // own one-decimal rounding (25.6) can account for.
  // And leave the screen as it was found: four cycles is four chances for a prompt to appear.
  await clearSheets(desktop.page);

  /*
   * And the bar is drawn, not merely sized.
   *
   * `.bar > span` was a child selector, and 26.19 moved the segments inside a `.bar-fill`. Nothing
   * matched: for several commits the bar painted its track and no segments at all, on every screen
   * that has one. The check above measures the segments' *widths*, and `flex-grow` still gave them
   * widths — so a bar that painted nothing passed a check about how wide its paint was.
   */
  const painted = await desktop.page.evaluate(() => {
    const bar = document.querySelector(".bar.segmented");
    const seg = bar?.querySelector(".bar-fill > span");
    if (!bar || !seg) return { seg: false };
    const s = getComputedStyle(seg);
    return {
      seg: true,
      h: seg.getBoundingClientRect().height,
      colour: s.backgroundColor,
      track: getComputedStyle(bar).backgroundColor,
    };
  });
  check(
    "and the segments are actually painted",
    painted.seg === true && painted.h > 2 && painted.colour !== painted.track &&
      painted.colour !== "rgba(0, 0, 0, 0)",
    JSON.stringify(painted),
  );

  // 26.20 — and the screen it is on uses the window it is in.
  const filled = await desktop.page.evaluate(() => {
    const main = document.querySelector(".main");
    const screen = document.querySelector(".timerscreen");
    if (!main || !screen) return null;
    const style = getComputedStyle(main);
    const inner = main.clientHeight - parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    return { inner, screen: screen.getBoundingClientRect().height };
  });
  check(
    "26.20 — the timer screen fills the window it is given",
    filled !== null && filled.inner > 300 && filled.screen >= filled.inner - 1,
    JSON.stringify(filled),
  );

  check(
    "26.19 — the bar stays the size the figures say, however many sessions",
    usable >= 3 && worstBar < 0.015,
    `${usable} usable readings, worst ${(worstBar * 100).toFixed(2)}pp out — ${
      JSON.stringify(readings)
    }`,
  );

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
  await clearSheets(desktop.page);
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
  //
  // The phone gets its own prompts, and 26.9 made a note with typing in it refuse to vanish. With
  // the prompt interval turned down to a second for this run, one is almost always open here.
  await clearSheets(mobile.page);
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

  // 26.26 — and the third panel that holds unsaved work. A half-filled form is somebody's work
  // too, and Escape used to take it without a word.
  await mobile.page.keyboard.press("Escape");
  check(
    "a half-filled entry asks before throwing it away",
    await until(
      "entry discard asked",
      mobile.page,
      async (p) => (await p.getByRole("button", { name: "Throw it away" }).count()) > 0,
    ),
    await visibleText(mobile.page),
  );
  await mobile.page.getByRole("button", { name: "Not now" }).click();

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

  // 26.16 — before anything is typed: the form is captioned in the document's words.
  const madeUp = await invented(desktop.page);
  check(
    "26.16 — the invoice form uses the document's own captions",
    madeUp.length === 0,
    madeUp.join("; "),
  );

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

  // 25.41 — the confirmation is inline and nothing moves. The "Saved." notice used to go in at the
  // top of the page, above the `<h1>`, so a successful save pushed every card down by a line — the
  // button you had just pressed moved out from under the pointer at the moment it worked, and on
  // the cards further down the confirmation appeared somewhere off screen.
  const saveButton = desktop.page.getByRole("button", { name: "Save", exact: true }).first();
  const boxBefore = await saveButton.boundingBox();
  await saveButton.click();
  const confirmed = await until(
    "save confirmed",
    desktop.page,
    async (p) => (await p.locator(".saveresult:visible").count()) > 0,
  );
  check("25.41 — a save says so", confirmed);
  const boxAfter = await saveButton.boundingBox();
  check(
    "and it does not move the button that produced it",
    boxBefore !== null && boxAfter !== null && Math.abs(boxAfter.y - boxBefore.y) < 1,
    `${boxBefore?.y} -> ${boxAfter?.y}`,
  );

  // 25.42, 25.43 — a stored-but-hidden value says so in the field, and clearing is per group.
  const maskedAddress = desktop.page.getByRole("button", {
    name: /Postal address — stored and hidden/,
  });
  check("25.42 — the address is a mask, not an empty box", (await maskedAddress.count()) === 1);
  check(
    "and the payment block is masked field by field, not by a chip",
    (await desktop.page.getByRole("button", { name: /^BSB — stored and hidden/ }).count()) === 1 &&
      (await desktop.page.getByText("set", { exact: true }).count()) === 0,
  );
  await maskedAddress.click();
  check(
    "25.43 — pressing one explains that the value is stored and not shown",
    await until(
      "mask dialog",
      desktop.page,
      async (p) => (await p.getByText(/not sent back to any device/).count()) > 0,
    ),
  );
  await desktop.page.getByRole("button", { name: "Clear and retype" }).click();
  check(
    "and clearing that group makes it typeable",
    await until(
      "address typeable",
      desktop.page,
      (p) => p.getByLabel("Postal address").isEditable(),
    ),
  );
  check(
    "25.43 — while leaving the other group alone",
    (await desktop.page.getByRole("button", { name: /^BSB — stored and hidden/ }).count()) === 1,
  );

  // Typed back in, because clearing is only half of "clear and retype" — and because a cleared
  // address *saved* is a cleared address. The first version of this block stopped at the check
  // above, and everything downstream then failed on an invoice configuration missing its address,
  // which is the correct behaviour reached by a route nobody intended.
  await desktop.page.getByLabel("Postal address").fill("12 Fictional Way, Nowhere NSW 2000");

  /*
   * A box left empty on purpose, in a group that was unlocked on purpose.
   *
   * The card used to send only the payment fields that had something typed in them, because an
   * untouched box must not blank a stored value. After "Clear and re-enter" every box is empty on
   * purpose, so clearing five and retyping four kept the fifth — and 24.31 requires it, so the
   * document would have printed a BSB from a bank the person had left, with nothing anywhere
   * saying so.
   */
  await desktop.page.getByRole("button", { name: /^BSB — stored and hidden/ }).click();
  await desktop.page.getByRole("button", { name: "Clear and re-enter" }).click();
  await desktop.page.getByLabel("Payment method", { exact: true }).fill("Bank transfer");
  await desktop.page.getByLabel("Account name", { exact: true }).fill("Wren & Co");
  await desktop.page.getByLabel("Account number", { exact: true }).fill("00000000");
  await desktop.page.getByLabel("Bank", { exact: true }).fill("Bank of Nowhere");
  // Every one but the BSB, which stays empty.
  await desktop.page.getByRole("button", { name: "Save invoice details" }).click();
  await desktop.page.waitForTimeout(700);

  // 24.31 is where an incomplete configuration is named, so that is where the emptied field has
  // to show up. The card's own notice speaks of "payment details" as a group and would say
  // nothing here — which is precisely why the old behaviour was invisible.
  await nav(desktop.page, "Invoices");
  await desktop.page.getByRole("button", { name: "New invoice" }).click();
  check(
    "a payment field cleared on purpose is cleared, and the refusal names it",
    await until(
      "bsb missing",
      desktop.page,
      async (p) => (await p.getByText(/BSB/).count()) > 0,
    ),
    await visibleText(desktop.page),
  );

  // And put it back. Leaving the screen re-masks the group — the card is remounted and the
  // clearing was a decision made in this sitting — so it has to be unlocked a second time, which
  // is itself the behaviour 25.43 asks for.
  await nav(desktop.page, "Settings");
  await desktop.page.getByRole("button", { name: /^BSB — stored and hidden/ }).click();
  await desktop.page.getByRole("button", { name: "Clear and re-enter" }).click();
  await desktop.page.getByLabel("Payment method", { exact: true }).fill("Bank transfer");
  await desktop.page.getByLabel("Account name", { exact: true }).fill("Wren & Co");
  await desktop.page.getByLabel("BSB", { exact: true }).fill("000-000");
  await desktop.page.getByLabel("Account number", { exact: true }).fill("00000000");
  await desktop.page.getByLabel("Bank", { exact: true }).fill("Bank of Nowhere");
  await desktop.page.getByRole("button", { name: "Save invoice details" }).click();
  await desktop.page.waitForTimeout(700);

  await nav(desktop.page, "Invoices");
  await desktop.page.getByRole("button", { name: "New invoice" }).click();
  check(
    "and typing it back is enough to prepare one again",
    await until(
      "bsb back",
      desktop.page,
      async (p) => (await p.getByText(/BSB/).count()) === 0,
    ),
    await visibleText(desktop.page),
  );
  await nav(desktop.page, "Settings");

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

  const invoiceRow = () =>
    desktop.page.locator(".stacked-row").filter({ hasText: preparing }).first();

  /*
   * The row for *this* month, in draft — not "a row somewhere in draft".
   *
   * This asked whether the first row in the list was a draft, and the seed ships an August draft
   * that sits there from the moment the screen loads. So it answered yes before the click had
   * reached the server, and every check below it began against a September row that did not exist
   * yet. Most passed anyway, because a Playwright action auto-waits for its element to arrive; the
   * one that did not wait — a `count() === 0` — was green for the whole run for want of anything
   * to count.
   */
  check(
    "a prepared invoice appears in the list as a draft",
    await until(
      "draft",
      desktop.page,
      async (p) =>
        (await p.locator(".stacked-row").filter({ hasText: preparing }).count()) === 1 &&
        (await stateOf(invoiceRow())) === "draft",
    ),
  );

  // 26.10 — the list offers reading, not saving. Saving is in the viewer the browser supplies.
  check(
    "26.10 — no download control on the list",
    (await invoiceRow().getByRole("button", { name: /download/i }).count()) === 0,
  );

  // 8.33 / 26.11 — the document itself, in the viewer, over a blob URL.
  const draftPdf = await viewPdf(desktop.page, invoiceRow());
  check(
    "26.11 — a draft's PDF opens in the viewer over a blob URL",
    draftPdf.src?.startsWith("blob:") === true,
    String(draftPdf.src).slice(0, 24),
  );
  check(
    "and it is a PDF",
    draftPdf.bytes?.subarray(0, 5).toString("latin1") === "%PDF-",
    JSON.stringify(draftPdf.bytes?.subarray(0, 5).toString("latin1")),
  );

  // 11.4 — generating changed no state.
  check(
    "generating did not issue anything",
    (await stateOf(invoiceRow())) === "draft",
  );

  // 26.13 — issuing asks nothing. The dialog that used to warn about the PDF freezing was warning
  // about the feature working, so setting the state is the whole interaction.
  await setStateTo(invoiceRow(), "issued");
  check(
    "26.13 — issuing does not stop to warn about the PDF freezing",
    (await desktop.page.getByRole("dialog").count()) === 0,
  );
  check(
    "and issuing moves it out of draft",
    await until(
      "issued",
      desktop.page,
      async (p) =>
        (await p.locator(".stacked-row").first().getByRole("combobox").inputValue()) === "issued",
    ),
  );

  // 24.30 — the frozen document. Issued invoices serve the stored file rather than re-rendering,
  // so downloading twice must give the same bytes even though nothing stops the config changing
  // in between. Byte equality is the only assertion that distinguishes the two.
  const frozenBytes = (await viewPdf(desktop.page, invoiceRow())).bytes;
  check(
    "an issued invoice's PDF opens",
    frozenBytes?.subarray(0, 5).toString("latin1") === "%PDF-",
  );

  const again = (await viewPdf(desktop.page, invoiceRow())).bytes;
  check(
    "and it is frozen: the same bytes every time",
    again !== undefined && frozenBytes !== undefined &&
      Buffer.compare(frozenBytes, again) === 0,
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

  const draftRow = desktop.page.locator(".stacked-row")
    .filter({ has: desktop.page.locator('option[value="draft"]:checked') }).first();
  await setStateTo(draftRow, "issued");
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

  /*
   * And Escape, with an edit in it.
   *
   * `Sheet` makes backdrop dismissal opt-in and says why — a stray click at the edge of a long
   * invoice discards every edit — and Escape did exactly that on the same screen.
   */
  await desktop.page.getByLabel("Hours on line 1", { exact: true }).fill("3.25");
  await desktop.page.keyboard.press("Escape");
  check(
    "an edited invoice asks before throwing the edits away",
    await until(
      "editor discard asked",
      desktop.page,
      async (p) => (await p.getByRole("button", { name: "Throw them away" }).count()) > 0,
    ),
    await visibleText(desktop.page),
  );
  await desktop.page.getByRole("button", { name: "Not now" }).click();

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
  // Checked, not merely awaited: everything below addresses `invoiceRow()`, which is `.first()`
  // of the rows for this month. While the deleted draft is still there that is a coin flip
  // between two rows in different states, and the failure surfaces as a confusing one further on.
  check(
    "the deleted draft leaves the list",
    await until(
      "second draft gone",
      desktop.page,
      async (p) => (await p.locator(".stacked-row").filter({ hasText: preparing }).count()) === 1,
    ),
  );

  // 24.27 — paid, and back again, from the row.
  await setStateTo(invoiceRow(), "paid");
  check(
    "marking paid works from the row",
    await until(
      "paid",
      desktop.page,
      async () => (await stateOf(invoiceRow())) === "paid",
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
  check(
    "and the month can be prepared again",
    await until(
      "re-prepared",
      desktop.page,
      async () => (await stateOf(invoiceRow())) === "draft",
    ),
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
  /*
   * A minute before it started, rather than a time of day written down here.
   *
   * This filled in `06:15` on the reasoning that a session begun moments ago started later than
   * that. True for eighteen hours a day: run it between midnight and quarter past six and 06:15 is
   * in the *future*, which the server refuses — correctly, and the check then reads as a broken
   * feature. It failed three times in a row at ten past midnight before anybody looked at the
   * clock rather than at the diff.
   */
  const shown = (await startLink.textContent())?.trim() ?? "";
  const [hh, mm] = shown.split(":").map(Number);
  const earlier = (hh ?? 0) * 60 + (mm ?? 0) - 1;
  const target = `${String(Math.floor(earlier / 60)).padStart(2, "0")}:${
    String(earlier % 60).padStart(2, "0")
  }`;
  await startLink.click();
  await desktop.page.getByLabel("Started at").fill(target);
  await desktop.page.getByRole("button", { name: "Move the start" }).click();
  check(
    "25.27 — and it can be moved",
    earlier >= 0 && await until(
      "start moved",
      desktop.page,
      async (p) => (await p.locator(".muted button.link").first().textContent())?.trim() === target,
    ),
    `${shown} -> ${target}: ${await desktop.page.locator(".card.session").innerText()}`,
  );
  // A future start is refused rather than making every figure below it negative. 23:59 is in the
  // future at every moment of the day except the last minute of it, which is the narrowest this
  // gets without inventing a clock — see the relative target above for why that matters.
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
  await desktop.page.getByLabel("From", { exact: true }).fill("09:00");
  await desktop.page.getByLabel("To", { exact: true }).fill("11:30");
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

    /*
     * 26.9 — and Escape, while it is still recording.
     *
     * The confirmation covers typed words and a finished recording. A recording in progress is
     * neither until it stops, so a note dismissed with the microphone open used to close without
     * asking and take however long somebody had been talking with it.
     */
    await desktop.page.keyboard.press("Escape");
    check(
      "26.9 — dismissing mid-recording asks before throwing it away",
      await until(
        "discard asked",
        desktop.page,
        async (p) => (await p.getByRole("button", { name: "Throw it away" }).count()) > 0,
      ),
      await visibleText(desktop.page),
    );
    /*
     * And Escape again, with the confirmation open over the note.
     *
     * Two sheets, both listening on `window` in the capture phase, and `stopPropagation` does not
     * stop a listener on the same node — so the note's handler runs as well as the dialog's. What
     * has to come out of that is the inner one closing and the outer one staying, which is what
     * `Sheet`'s "one Escape closes one sheet" claims and what nothing had checked.
     */
    await desktop.page.keyboard.press("Escape");
    check(
      "and Escape over a confirmation closes the confirmation, not what it is asking about",
      await until(
        "confirmation gone",
        desktop.page,
        async (p) =>
          (await p.getByRole("button", { name: "Throw it away" }).count()) === 0 &&
          (await p.getByText(/● recording/).count()) > 0,
      ),
      await visibleText(desktop.page),
    );
    check(
      "and keeping it leaves the recording running",
      await until(
        "still recording",
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
    /*
     * 26.18 — and what is *drawn* is what was set.
     *
     * The check below reads `style.height`, which is the value the app asked for, and it has
     * passed throughout — while the trace on screen was reported as broken twice. `.trace span`
     * carried `transition: height 60ms` and gets a new height every animation frame, so every
     * transition was retargeted a quarter of the way through and no bar ever arrived: the picture
     * was smeared toward its own mean and read as flat with occasional spikes.
     *
     * Measured on the old code the rendered height was 5.7px from the set height on average and
     * 36px at worst, on a box 44px tall. Asserting the model and calling it the view is how a
     * display bug survives two rounds of fixing the data behind it.
     */
    const drawn = await desktop.page.locator(".trace").evaluate((trace) => {
      const bars = [...trace.querySelectorAll("span")];
      const box = trace.getBoundingClientRect().height;
      let worst = 0;
      for (const b of bars) {
        const want = (parseFloat(b.style.height) || 0) / 100 * box;
        worst = Math.max(worst, Math.abs(want - b.getBoundingClientRect().height));
      }
      return +worst.toFixed(2);
    });
    // Three pixels of slack: the markup's own floor and sub-pixel rounding, nothing like 36.
    check("and the trace drawn is the trace measured", drawn < 3.5, `worst bar off by ${drawn}px`);

    /*
     * 27.8 — every bar the same width.
     *
     * `flex: 1 1 0` over 120 children divides the track into fractional widths, and each one is
     * rounded for painting on its own, so the row came out as a mix of two-pixel and three-pixel
     * bars — reported as looking odd, which it is: a meter whose bars vary reads as a fault in the
     * drawing rather than in the sound.
     */
    const bars = await desktop.page.locator(".trace span").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: +r.x.toFixed(3), w: +r.width.toFixed(3) };
      })
    );
    /*
     * Whole pixels, not merely equal ones.
     *
     * The first version of this compared widths and passed: `flex: 1 1 0` divides the track
     * evenly, so every bar was the same *fractional* width. What varies is where each lands on
     * the device's pixel grid — a 2.35px bar starting at x.4 paints across three columns and one
     * starting at x.0 across two — and the DOM cannot see that at all. A bar an exact number of
     * pixels wide at an exact offset has nothing to round.
     */
    const whole = bars.every((b) => Number.isInteger(b.w) && Number.isInteger(b.x));
    const steps = new Set(bars.slice(1).map((b, i) => +(b.x - bars[i].x).toFixed(3)));
    check(
      "27.8 — every bar is a whole number of pixels wide, at a whole-pixel offset",
      bars.length > 2 && whole && steps.size === 1,
      `${bars.length} bars, widths ${[...new Set(bars.map((b) => b.w))].join("/")}, steps ${
        [...steps].join("/")
      }`,
    );

    check(
      "and it moves with the input rather than sitting flat",
      new Set(heights).size > 3,
      `${new Set(heights).size} distinct heights`,
    );

    await desktop.page.getByRole("button", { name: "Stop", exact: true }).click();

    /*
     * 27.7 — the button that says "Record again" records again.
     *
     * It discarded the take and left a Record button to press separately, which is how it was
     * reported as "there is no way to record another".
     */
    await desktop.page.getByRole("button", { name: "Record again" }).click();
    check(
      "27.7 — Record again starts another take",
      await until(
        "recording again",
        desktop.page,
        (p) => p.getByText(/● recording/).isVisible(),
      ),
      await visibleText(desktop.page),
    );
    await desktop.page.waitForTimeout(1_200);

    /*
     * 27.6 — and Save finishes it, rather than refusing because it is running.
     *
     * Left running deliberately: the previous take is gone, so if Save refuses there is nothing
     * to fall back on and the checks below fail on an empty note.
     */
    await desktop.page.getByRole("button", { name: "Save note" }).click();
    check(
      "27.6 — Save stops a running recording and keeps it",
      await until(
        "note saved",
        desktop.page,
        async (p) => (await p.getByRole("button", { name: /▶ Play \d+s/ }).count()) > 0,
      ),
      await visibleText(desktop.page),
    );

    // And again, the ordinary way, for the checks below that read a stopped take back.
    await desktop.page.getByRole("button", { name: "New work note" }).click();
    await desktop.page.getByRole("button", { name: /Record$/ }).click();
    await desktop.page.waitForTimeout(1_500);
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
    name: "loop.wav",
    mimeType: "audio/wav",
    buffer: LOOP_BYTES,
  });
  check(
    "a chosen file is copied onto this device",
    await until(
      "loop stored",
      desktop.page,
      (p) => p.getByText(/loop\.wav/).isVisible(),
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
      (p) => p.getByText(/loop\.wav/).isVisible(),
    ),
  );

  /*
   * 26.3, 26.5, 26.6 — playing, and staying that way.
   *
   * The reported fault was that walking to the settings screen silenced a loop that was running.
   * `LoopPlayer.load` began with `stop()`, and the settings card loads the stored file when it
   * mounts, so opening the screen that configures the audio was the thing that stopped it.
   *
   * `new Audio()` makes a *detached* element, so there is nothing in the DOM to query about it.
   * The card's own rendering is the surface that matters anyway: the hint appears exactly when
   * the app believes the loop is playing.
   */
  const playingNow = () => desktop.page.getByText("playing now").count();

  /*
   * 26.1 — and whether it is *actually* playing, which the app's own rendering cannot say.
   *
   * Everything else here reads the card: the hint appears when the app believes the loop is
   * playing. That belief has been wrong twice, reported twice, and was four separate silent faults
   * the second time — so a check that consults it is a check that agrees with the bug.
   *
   * Chromium's media pipeline is a second opinion that owes the app nothing. The `Media` CDP
   * domain reports what the decoder is doing: a player created, a pipeline state, an audio track
   * with a codec and a sample rate. `kPlaying` there means bytes are being decoded, whatever the
   * interface says about it.
   */
  const media = await desktop.page.context().newCDPSession(desktop.page);
  const pipeline = [];
  const played = [];
  await media.send("Media.enable");
  media.on("Media.playerEventsAdded", ({ events }) => {
    for (const e of events) {
      let body;
      try {
        body = JSON.parse(e.value ?? "{}");
      } catch {
        continue;
      }
      if (body.pipeline_state) pipeline.push(body.pipeline_state);
      if (body.event === "kPlay" || body.event === "kPause") played.push(body.event);
    }
  });

  await desktop.page.getByRole("button", { name: "▶ Preview" }).click();
  check(
    "the preview starts the loop",
    await until(
      "loop playing",
      desktop.page,
      async (p) => (await p.getByText("playing now").count()) > 0,
    ),
  );

  check(
    "26.1 — and the media pipeline agrees: something is being decoded and played",
    await until(
      "pipeline playing",
      desktop.page,
      () => Promise.resolve(pipeline.includes("kPlaying")),
      15_000,
    ),
    `pipeline states: ${JSON.stringify(pipeline)}`,
  );

  const pausesBefore = played.filter((e) => e === "kPause").length;
  await nav(desktop.page, "Timer");
  await nav(desktop.page, "Settings");
  await desktop.page.waitForTimeout(600);
  check("26.3 — and a visit to another screen does not stop it", (await playingNow()) > 0);
  check(
    "and the pipeline was not paused by the visit either",
    played.filter((e) => e === "kPause").length === pausesBefore,
    JSON.stringify(played),
  );

  check(
    "26.5 — Preview is unavailable while it plays",
    await desktop.page.getByRole("button", { name: "▶ Preview" }).isDisabled(),
  );
  await desktop.page.getByText("playing now").click();
  check(
    "26.6 — and says why, with somewhere to report it if the sound is missing",
    await until(
      "preview explained",
      desktop.page,
      async (p) => (await p.getByRole("button", { name: "Report it" }).count()) > 0,
    ),
  );
  await desktop.page.getByRole("button", { name: "Not now" }).click();

  /*
   * 27.2 — off and on again, with a timer running the whole time.
   *
   * The reported sequence exactly: the loop plays when a timer starts, unchecking Enabled stops it
   * — and checking it again did nothing at all, because the effect that starts playback was keyed
   * on the timer, and the timer had not moved. Stopping and starting the timer recovered it, which
   * is how it was diagnosed as "the path back is broken" rather than "audio is broken".
   *
   * Asserted against the media pipeline as well as the card: this is the fault where what the app
   * believes and what the speakers are doing came apart.
   */
  /*
   * Enabled, which nothing had ever switched on.
   *
   * Every audio check up to here went through Preview, which plays whatever the setting says — so
   * the path the *timer* takes, which is the one every complaint has been about, had never been
   * run. That is why "off and on again" could be broken without anything noticing.
   */
  const enabledBox = desktop.page.getByLabel("Enabled", { exact: true });
  await enabledBox.check();

  await nav(desktop.page, "Timer");
  await clearSheets(desktop.page);
  // Whatever the run left behind: this block needs a timer running and does not care which.
  const stopIfRunning = desktop.page.getByRole("button", { name: /Stop/ });
  if (await stopIfRunning.count()) {
    await stopIfRunning.click();
    await desktop.page.waitForTimeout(400);
  }
  await desktop.page.getByLabel("Billing tag").fill("Audio toggle");
  await desktop.page.getByRole("button", { name: /Start/ }).click();
  await nav(desktop.page, "Settings");
  check(
    "the loop plays while a timer runs",
    await until(
      "loop playing",
      desktop.page,
      async (p) => (await p.getByText("playing now").count()) > 0,
    ),
  );

  await enabledBox.uncheck();
  check(
    "unchecking Enabled stops it",
    await until(
      "loop stopped",
      desktop.page,
      async (p) => (await p.getByText("playing now").count()) === 0,
    ),
  );

  const playsBeforeToggle = played.filter((e) => e === "kPlay").length;
  await enabledBox.check();
  check(
    "27.2 — and checking it again starts it, with the timer never having moved",
    await until(
      "loop playing again",
      desktop.page,
      async (p) => (await p.getByText("playing now").count()) > 0,
    ),
    await visibleText(desktop.page),
  );
  check(
    "and the pipeline played again rather than the card merely saying so",
    // Waited for, not read once: the card updates from a React state change and this arrives over
    // the debugger protocol, so the two are not ordered against each other.
    await until(
      "pipeline played again",
      desktop.page,
      () => Promise.resolve(played.filter((e) => e === "kPlay").length > playsBeforeToggle),
      10_000,
    ),
    JSON.stringify(played),
  );

  // Left as it was found, so what follows is not running a timer nobody started.
  await nav(desktop.page, "Timer");
  await desktop.page.getByRole("button", { name: /Stop/ }).click();
  await desktop.page.waitForTimeout(400);
  await nav(desktop.page, "Settings");

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
  // `exact`, because 25.15 put "Hourly rate in" — the currency — on the same screen, and
  // `getByLabel` matches substrings: the ambiguity reads as "not visible", which sent me looking
  // at the element that was in fact perfectly fine.
  const rate = desktop.page.getByLabel("Hourly rate", { exact: true });
  await rate.waitFor({ timeout: 15_000 });
  await rate.fill("");
  await rate.pressSequentially("125");
  check(
    "25.44 — typing 125 leaves 125 in the field",
    await rate.inputValue() === "125",
    await rate.inputValue(),
  );

  // 25.15 renamed this to what the document calls it, which is the whole point of that change.
  await desktop.page.getByLabel("Hourly rate in").click();
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
    "25.4 — deleting a note asks first, in a dialog",
    await until(
      "note confirm",
      desktop.page,
      async (p) =>
        (await p.getByRole("dialog").count()) > 0 &&
        (await p.getByText("Delete this note?").count()) > 0,
    ),
  );
  const notesBefore = await desktop.page.locator(".stacked-row").count();
  // The dialog's button, not the row's. This was scoped to the row when the confirmation was two
  // links in the row itself; now the row is behind an overlay that intercepts the click, which is
  // most of why 25.4 wanted a dialog.
  await desktop.page.getByRole("button", { name: "Delete it" }).click();
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
  const segmentsBefore = await desktop.page.locator(".bar-fill > span").count();
  await desktop.page.getByRole("button", { name: /Start/ }).click();
  await desktop.page.waitForTimeout(1200);
  await desktop.page.getByRole("button", { name: /Stop/ }).click();
  const grew = await until(
    "segment added",
    desktop.page,
    async (p) => (await p.locator(".bar-fill > span").count()) > segmentsBefore,
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

  // ------------------------------------------------------------ you can see where you are
  //
  // Fields had an explicit focus ring and controls did not, so a keyboard walking this app got 2px
  // of accent blue on an input and the browser's default — 1px of near-black — on every button and
  // link. Faint on the dark sidebar; in dark mode, black on near-black, which is no indicator.
  //
  // Tabbed rather than focused programmatically, because `:focus-visible` is exactly the
  // distinction between the two and it is the one that decides whether a ring is drawn.
  console.log("\nfocus:");
  await nav(desktop.page, "Timer");
  await desktop.page.evaluate(() => document.activeElement?.blur?.());
  const ringless = [];
  for (let i = 0; i < 12; i++) {
    await desktop.page.keyboard.press("Tab");
    const at = await desktop.page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const drawn = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2;
      return drawn
        ? null
        : `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 16)}"`;
    });
    if (at) ringless.push(at);
  }
  check(
    "every control shows where the keyboard is",
    ringless.length === 0,
    [...new Set(ringless)].join("; "),
  );

  // ------------------------------------------------------------ text you can actually read
  //
  // Measured on the rendered page rather than argued from the palette, because what a colour is
  // read against depends on what it happens to be sitting inside. The tightest case in this app is
  // a *pill*: `--good` cleared 4.5:1 on the page and only managed 4.43:1 on `--good-wash`, which
  // is the one place it appears as 12px text.
  //
  // Two tokens failed when this was first run. `--ink-faint` was 3.03:1 on white and is used for
  // every column heading, field hint and legend in the app, at 11–13px — the size band where the
  // threshold matters most and the one it was furthest from clearing.
  console.log("\ncontrast:");
  const lowContrast = (page, where) =>
    page.evaluate((where) => {
      const rgb = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]) => {
        const c = [r, g, b].map((x) => x / 255)
          .map((x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      // Up the tree until something is actually painted: a transparent background means the
      // colour behind this text belongs to an ancestor.
      const behind = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const bg = rgb(getComputedStyle(n).backgroundColor);
          if (bg.length >= 3 && (bg[3] === undefined || bg[3] > 0.5)) return bg.slice(0, 3);
        }
        return [255, 255, 255];
      };
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        // Only elements with text of their own, or every ancestor is reported for its children.
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || Number(style.opacity) < 0.9) continue;
        // Something that is on the page rather than merely in the document. `<title>` has a text
        // node and a computed colour, and in the dark theme that colour came out white against the
        // white this falls back to for an element with nothing painted behind it: 1.00:1, reported
        // on every screen, for a string that is drawn in the browser's tab bar.
        if (el.getClientRects().length === 0) continue;
        const size = parseFloat(style.fontSize);
        const large = (Number(style.fontWeight) >= 700 && size >= 18.66) || size >= 24;
        const need = large ? 3 : 4.5;
        const got = ratio(rgb(style.color).slice(0, 3), behind(el));
        // A hundredth of slack, because these are floats and the palette is tuned to the line.
        if (got + 0.005 < need) {
          // Named as well as quoted. "Worklog 1.00:1" was reported for something that is plainly
          // legible on screen, and there was no way to tell from the message which of the several
          // elements carrying that word was meant, or what either colour was.
          const at = `${el.tagName.toLowerCase()}${
            el.className ? `.${String(el.className).trim().split(/\s+/).join(".")}` : ""
          }`;
          out.push(
            `${where}: ${at} "${(el.textContent ?? "").trim().slice(0, 24)}" ${got.toFixed(2)}:1 ` +
              `needs ${need} at ${Math.round(size)}px ` +
              `(${style.color} on rgb(${behind(el).join(" ")}))`,
          );
        }
      }
      return out;
    }, where);

  const dim = [];

  const leaks = [];
  const offLine = [];
  /*
   * A third device, in the other theme.
   *
   * The harness pins `colorScheme: "light"` so a run does not depend on the machine's preference,
   * which means every check above has only ever seen half the stylesheet. The dark palette is a
   * second value for every colour in this app and the only thing that has ever looked at it is a
   * person looking at a screenshot — which is how `button.link.danger` rendered four Delete
   * controls in accent blue for as long as it did.
   *
   * `colorScheme` is fixed when a context is made, so this is a device rather than a toggle.
   */
  /*
   * 13.32 — and a device that can only read, which nothing had ever drawn.
   *
   * Its controls are disabled all over the app, and a disabled control does not say why: it looks
   * the same as one that is broken. The app says it once, in the header every screen carries.
   */
  const reader = await rig.open("reader", DESKTOP, "Read Only Laptop");
  await reader.page.getByRole("button", { name: "Ask for access" }).waitFor({ timeout: 30_000 });
  await reader.page.getByLabel("Access needed").selectOption("read");
  await reader.page.getByRole("button", { name: "Ask for access" }).click();
  await desktop.page.getByRole("button", { name: "Admin", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Device access" }).click();
  await desktop.page.getByRole("row", { name: /Read Only Laptop/ })
    .getByRole("button", { name: /^Approve as/ }).click();
  const readerIn = reader.page.getByRole("button", { name: "Continue" });
  await readerIn.waitFor({ timeout: 30_000 });
  await readerIn.click();
  await reader.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });

  check(
    "a read-only device says so, once, where every screen carries it",
    (await reader.page.getByText("read-only access").count()) === 1,
    await visibleText(reader.page),
  );
  check(
    "and it cannot start a timer",
    await reader.page.getByRole("button", { name: /Start/ }).isDisabled(),
  );
  check(
    "and access administration is not in its navigation",
    (await reader.page.getByRole("button", { name: "Admin", exact: true }).count()) === 0,
  );

  const dark = await rig.open("dark", DESKTOP, "Night Desktop", { colorScheme: "dark" });
  await dark.page.getByRole("button", { name: "Ask for access" }).waitFor({ timeout: 30_000 });
  await dark.page.getByLabel("Access needed").selectOption("admin");
  await dark.page.getByRole("button", { name: "Ask for access" }).click();
  await desktop.page.getByRole("button", { name: "Admin", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Device access" }).click();
  await desktop.page.getByRole("row", { name: /Night Desktop/ })
    .getByRole("button", { name: /^Approve as/ }).click();
  const continueIn = dark.page.getByRole("button", { name: "Continue" });
  await continueIn.waitFor({ timeout: 30_000 });
  await continueIn.click();
  await dark.page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });

  for (const screen of ["Timer", "Notes", "History", "Pacing", "Invoices", "Admin", "Settings"]) {
    await nav(desktop.page, screen);
    await desktop.page.waitForTimeout(300);
    dim.push(...await lowContrast(desktop.page, screen));
    leaks.push(...await sourceOnScreen(desktop.page, screen));
    offLine.push(...await checkboxAlignment(desktop.page, screen));
    // The phone renders the same palette in a different shell, and the dark device is a third set
    // of colours entirely — the theme nobody looked at for two months.
    if (await mobile.page.getByRole("button", { name: screen, exact: true }).count()) {
      await nav(mobile.page, screen);
      await mobile.page.waitForTimeout(250);
      dim.push(...await lowContrast(mobile.page, `${screen} (phone)`));
      leaks.push(...await sourceOnScreen(mobile.page, `${screen} (phone)`));
      offLine.push(...await checkboxAlignment(mobile.page, `${screen} (phone)`));
    }
    await nav(dark.page, screen);
    await dark.page.waitForTimeout(250);
    dim.push(...await lowContrast(dark.page, `${screen} (dark)`));
    leaks.push(...await sourceOnScreen(dark.page, `${screen} (dark)`));
    offLine.push(...await checkboxAlignment(dark.page, `${screen} (dark)`));
  }
  check(
    "every piece of text clears its contrast threshold",
    dim.length === 0,
    [...new Set(dim)].join("; "),
  );
  check(
    "no source text is rendered as content",
    leaks.length === 0,
    [...new Set(leaks)].join("; "),
  );
  check(
    "26.17 — a checkbox sits on the same line as the fields beside it",
    offLine.length === 0,
    [...new Set(offLine)].join("; "),
  );

  // ------------------------------------------------------------ a modal that behaves like one
  //
  // Four sheets declared `role="dialog" aria-modal="true"` — a promise that the rest of the page
  // is inert — and then handled no keys at all. Escape did nothing, focus stayed wherever it was,
  // and Tab wandered off behind the overlay into the controls the overlay exists to cover.
  // Announcing yourself as a modal and not being one is worse than not announcing it, because the
  // announcement is what stops somebody looking for another way out.
  console.log("\nsheets:");
  const openSheets = () => desktop.page.getByRole("dialog").count();

  await nav(desktop.page, "History");
  await desktop.page.getByRole("button", { name: "Add past time" }).click();
  await desktop.page.getByRole("dialog").waitFor({ timeout: 15_000 });
  check(
    "opening a sheet puts focus inside it",
    await desktop.page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null),
  );
  // The other half of the promise: Tab stays inside. Twenty-five presses is well past the number
  // of controls in this sheet, so a trap that only works for one lap still fails.
  let escaped = 0;
  for (let i = 0; i < 25; i++) {
    await desktop.page.keyboard.press("Tab");
    if (
      !(await desktop.page.evaluate(() =>
        document.activeElement?.closest("[role=dialog]") !== null
      ))
    ) {
      escaped = i + 1;
      break;
    }
  }
  check("and Tab cannot walk out of it into the page behind", escaped === 0, `after ${escaped}`);

  await desktop.page.keyboard.press("Escape");
  await desktop.page.waitForTimeout(300);
  check("Escape closes it", (await openSheets()) === 0);
  check(
    "and focus goes back to what opened it",
    (await desktop.page.evaluate(() => document.activeElement?.textContent?.trim())) ===
      "Add past time",
  );

  // A confirmation may also be dismissed by the backdrop; an editor may not, because a stray
  // click at the edge of a long invoice would discard every edit with no warning and no undo.
  await nav(desktop.page, "Invoices");
  await desktop.page.getByRole("button", { name: "Edit lines" }).first().click();
  await desktop.page.getByRole("button", { name: "Add a line" }).waitFor({ timeout: 15_000 });
  await desktop.page.mouse.click(20, 20);
  await desktop.page.waitForTimeout(300);
  check("a backdrop click does not discard an editor's unsaved edits", (await openSheets()) === 1);
  await desktop.page.keyboard.press("Escape");
  await desktop.page.waitForTimeout(300);
  check("but Escape does close it", (await openSheets()) === 0);

  // ------------------------------------------------------------ nothing hidden sideways
  //
  // 23.x. A container with `overflow-x: auto` never makes the *document* overflow, so every
  // structural check passes while most of a table sits off the right-hand edge with nothing drawn
  // to say it is there. Two faults of exactly that shape were live at once: the invoice line
  // editor showed a phone two of its seven columns, and the About card was 557px wide in a 390px
  // viewport because a KPS address is forty unbroken characters and had nowhere to wrap.
  //
  // Neither was visible in a screenshot — one was inside a dialog, the other below the fold.
  console.log("\nnothing clipped on a phone:");

  /*
   * Given something hostile to lay out first, because the default fixture is polite.
   *
   * Every value this app shows is something somebody typed, and the shape that breaks a layout is
   * a long run with no space in it — which is what a project name often is. A 62-character tag
   * made a 492px row in a 390px viewport, and the note body reached 900px. Both were invisible to
   * this scan until the scan had something to find.
   */
  await nav(desktop.page, "History");
  await desktop.page.getByRole("button", { name: "Add past time" }).click();
  await desktop.page.getByRole("dialog").waitFor({ timeout: 15_000 });
  await desktop.page.getByLabel("How long").fill("2h");
  await desktop.page.getByLabel("Billing tag").fill(
    "ReconciliationOfQuarterlySubcontractorInvoicingAndDisbursements",
  );
  await desktop.page.getByRole("button", { name: "Add", exact: true }).click();
  // On the phone, and waited for there: the scan below must have the awkward value in front of it
  // or it passes by having nothing to find, which is the failure mode of every check like this.
  await nav(mobile.page, "History");
  check(
    "the awkward entry reached the phone, so the scan has something to fail on",
    await until(
      "the awkward entry",
      mobile.page,
      async (p) => (await p.getByText(/ReconciliationOfQuarterly/).count()) > 0,
    ),
  );
  const hiddenOn = async (where) =>
    await mobile.page.evaluate((where) => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll("*")) {
        const style = getComputedStyle(el);
        const scrolls = style.overflowX === "auto" || style.overflowX === "scroll";
        // Eight pixels of slack: a scrollbar gutter and sub-pixel rounding are not a fault.
        if (scrolls && el.scrollWidth - el.clientWidth > 8) {
          out.push(
            `${where}: ${el.tagName.toLowerCase()}.${[...el.classList].join(".")} hides ${
              el.scrollWidth - el.clientWidth
            }px`,
          );
        }
        if (el.getBoundingClientRect().width > vw + 4 && el.children.length === 0) {
          out.push(`${where}: ${el.tagName.toLowerCase()} is wider than the viewport`);
        }
      }
      return out;
    }, where);

  const hidden = [];
  for (const screen of ["Timer", "Notes", "History", "Pacing", "Invoices", "Settings"]) {
    await nav(mobile.page, screen);
    await mobile.page.waitForTimeout(400);
    hidden.push(...await hiddenOn(screen));
  }
  // And a dialog, which is on no screen until it is opened — where the worse of the two was.
  await nav(mobile.page, "History");
  await mobile.page.getByRole("button", { name: "Add past time" }).click();
  await mobile.page.getByRole("dialog").waitFor({ timeout: 15_000 });
  hidden.push(...await hiddenOn("the entry editor"));
  await mobile.page.getByRole("button", { name: "Cancel" }).click();

  check("no phone screen hides content off to the right", hidden.length === 0, hidden.join("; "));

  // ------------------------------------------------------------ every field says what it is
  //
  // A control with no accessible name is announced as "time" or "edit text" and nothing else. It
  // is invisible to a screenshot by definition — the *sighted* layout is what makes it look fine,
  // because the thing naming it is a heading two elements away.
  //
  // Written after 25.15 left two inputs under a column heading with an empty `<label>`, which I
  // caught by reading the diff. Run against the whole app it found ten more: every weekday time
  // field on the settings screen, which had been that way since the schedule was built.
  const unnamed = (page, where) =>
    page.evaluate((where) => {
      const out = [];
      for (const el of document.querySelectorAll("input, select, textarea")) {
        const input = el;
        if (input.type === "hidden") continue;
        if (input.getAttribute("aria-label")?.trim()) continue;
        const byId = input.id
          ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
          : null;
        // A wrapping `<label>` counts, which is how most of this app labels a field.
        const holder = byId ?? input.closest("label");
        // The value is inside the label's `textContent` when the label wraps the input, so it has
        // to come out or every filled-in field looks named.
        const text = (holder?.textContent ?? "").replace(input.value ?? "", "").trim();
        if (text) continue;
        out.push(`${where}: <${input.tagName.toLowerCase()} type=${input.type ?? "?"}>`);
      }
      return out;
    }, where);

  const nameless = [];
  for (const screen of ["Timer", "Notes", "History", "Pacing", "Invoices", "Admin", "Settings"]) {
    await nav(desktop.page, screen);
    await desktop.page.waitForTimeout(300);
    nameless.push(...await unnamed(desktop.page, screen));
  }
  await nav(desktop.page, "Invoices");
  await desktop.page.getByRole("button", { name: "Edit lines" }).first().click();
  await desktop.page.getByRole("button", { name: "Add a line" }).waitFor({ timeout: 15_000 });
  nameless.push(...await unnamed(desktop.page, "the invoice editor"));
  await desktop.page.getByRole("button", { name: "Discard these changes" }).click();

  check("every field has a name to be announced by", nameless.length === 0, nameless.join("; "));

  // And the same question of the controls. A button whose whole label is a glyph is announced as
  // that glyph: the month arrows said "‹" and "›", which is exactly what they say and nothing
  // about what they do. `MonthNav` had gone to some trouble to stop them *moving* and none at all
  // to make them nameable.
  const mute = (page, where) =>
    page.evaluate((where) => {
      const out = [];
      for (const b of document.querySelectorAll("button, a[href]")) {
        const name = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
        // At least one letter or digit. A name of only symbols is read out as those symbols.
        if (name && /[\p{L}\p{N}]/u.test(name)) continue;
        out.push(`${where}: <${b.tagName.toLowerCase()}> named ${JSON.stringify(name)}`);
      }
      return out;
    }, where);

  const glyphs = [];
  for (const screen of ["Timer", "Notes", "History", "Pacing", "Invoices", "Admin", "Settings"]) {
    await nav(desktop.page, screen);
    await desktop.page.waitForTimeout(250);
    glyphs.push(...await mute(desktop.page, screen));
  }
  check(
    "and every control has a name that can be pronounced",
    glyphs.length === 0,
    [...new Set(glyphs)].join("; "),
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
  const askSpare = spare.page.getByRole("button", { name: "Ask for access" });
  await askSpare.waitFor({ timeout: 30_000 });
  // 25.32 — approving grants what was asked for, so a device that should end up read-only asks
  // for read. The admin's choice is whether, not which; a wrong request is denied and asked again.
  await spare.page.getByLabel("Access needed").selectOption("read");
  await askSpare.click();
  check(
    "a request arrives on an admin screen nobody navigated",
    await until(
      "pending row",
      desktop.page,
      async (p) => (await p.getByText("Spare Tablet").count()) > 0,
    ),
  );

  /*
   * 12.4, 22.10 — and a device that is waiting says nothing while it waits.
   *
   * The spare has a live transport and no authentication: it needs the connection to ask, and the
   * server will answer nothing else until an admin approves it. The heartbeat added for 22.10 would
   * have pinged from it every eight seconds, each one refused and each refusal written to the log,
   * for as long as somebody left the tablet on that screen.
   *
   * The revoked phone below does not show this, and not for the reason it first looked like: the
   * server de-authenticates the *session* and leaves the connection up, so there is plenty left to
   * ping with. What stops it there is the client — `access-revoked` moves it off `ready`, and the
   * heartbeat only beats while the connection is one the server will answer. A device that never
   * got that event is caught by the ladder instead: an `unauthenticated` refusal is the one
   * refusal that does mean reconnect.
   *
   * In front, because Chromium throttles a hidden page's timers to about one a minute and the
   * heartbeat is a timer; backgrounded, the tab is quiet whether this is fixed or not.
   */
  await spare.page.bringToFront();
  await spare.page.waitForTimeout(20_000);
  await desktop.page.bringToFront();
  await nav(desktop.page, "Admin");
  await desktop.page.getByRole("button", { name: "Server logs" }).click();
  await desktop.page.getByRole("button", { name: "Refresh" }).click();
  await desktop.page.waitForTimeout(800);
  // The whole log. `visibleText` truncates to three hundred characters to keep a failure message
  // readable, which of a two-hundred-line log is the page heading.
  const logText = await desktop.page.locator("body").innerText();
  check(
    "a device waiting for approval does not fill the log with refusals",
    !/refused a ping/.test(logText),
    logText.split("\n").filter((l) => /refused/.test(l)).slice(0, 4).join(" | "),
  );
  await desktop.page.getByRole("button", { name: "Device access" }).click();

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

  // 25.35 — revoking asks first. It cuts a device off mid-session and cannot be undone by
  // clicking again: the device has to ask and be approved from scratch.
  check(
    "25.35 — revoking asks before it revokes",
    await until(
      "revoke dialog",
      desktop.page,
      async (p) => (await p.getByRole("button", { name: "Revoke it" }).count()) > 0,
    ),
  );
  await desktop.page.getByRole("button", { name: "Revoke it" }).click();

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
    .getByRole("button", { name: /^Approve as/ }).click();
  // 25.33 again, on a second device: it is told, and goes in on a press rather than a reload.
  await spare.page.getByRole("button", { name: "Continue" }).waitFor({ timeout: 30_000 });
  await spare.page.getByRole("button", { name: "Continue" }).click();
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

  /*
   * 22.8 — the server goes away and comes back, and the app is still there.
   *
   * The reconnect ladder in `state.tsx` — five delays, a twelve-second connect timeout, a
   * `reconnecting` flag that keeps the interface on screen behind an amber dot — has never been
   * driven by anything. It exists because the alternative, which is what the app used to do, is to
   * replace every screen with a failure page the moment a stream ends; on a local network that is
   * almost never a real outage.
   *
   * Last, because it stops and starts the one server every other check is talking to.
   */
  console.log("\nlosing the server:");
  // Foregrounded first: Chromium throttles timers in a hidden page to about one a minute, and by
  // this point in the run the last page opened is somebody else. The heartbeat below is a timer.
  await desktop.page.bringToFront();
  await nav(desktop.page, "Timer");
  await clearSheets(desktop.page);
  const addressBefore = rig.server.address;

  /*
   * 2.2, 17.x — with a timer running, because that is the state a restart can lose.
   *
   * The authoritative timer is a row, so it ought to survive; nothing had ever checked, and the
   * failure would be a person's afternoon. Started here rather than earlier so that the only thing
   * between the start and the restart is the restart.
   */
  await desktop.page.getByLabel("Billing tag").fill("Survives a restart");
  await desktop.page.getByRole("button", { name: /Start/ }).click();
  await until(
    "timer running",
    desktop.page,
    (p) => p.getByText("Working on Survives a restart").isVisible(),
  );
  const startedAt = await desktop.page.locator(".muted button.link").first().textContent();

  await rig.stopServer();

  // While it is down. The claim is not that a loss is invisible — it is that the interface is
  // still there and says what is happening, rather than being replaced by a failure page.
  check(
    "the app stays on screen while the connection is gone",
    await until(
      "noticed",
      desktop.page,
      async (p) =>
        (await p.getByRole("button", { name: "Timer", exact: true }).count()) > 0 &&
        (await p.getByText(/Reconnecting|Disconnected/).count()) > 0,
      // A beat every eight seconds and six for the answer that never comes; twice that is slack.
      30_000,
    ),
    await visibleText(desktop.page),
  );

  const addressAfter = await rig.startServerAgain();
  check(
    "the server's address survives a restart",
    addressAfter === addressBefore,
    `${addressBefore} -> ${addressAfter}`,
  );
  check(
    "and it comes back on its own, without a reload",
    await until(
      "reconnected",
      desktop.page,
      async (p) => (await p.getByText("Connected", { exact: true }).count()) > 0,
      40_000,
    ),
    await visibleText(desktop.page),
  );
  check(
    "the timer that was running is still running, from the same start",
    await until(
      "timer survived",
      desktop.page,
      async (p) =>
        (await p.getByText("Working on Survives a restart").count()) > 0 &&
        (await p.locator(".muted button.link").first().textContent())?.trim() ===
          startedAt?.trim(),
      25_000,
    ),
    `was ${startedAt?.trim()}`,
  );

  check(
    "and it can be used again once it is back",
    await until(
      "usable",
      desktop.page,
      async (p) => await p.getByRole("button", { name: /Start|Stop/ }).isEnabled(),
      20_000,
    ),
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
