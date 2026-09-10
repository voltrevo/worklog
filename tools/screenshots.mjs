/**
 * 23.5 — screenshots of both presentations, from a real browser against a real server.
 *
 *     deno task shots
 *
 * Nothing is mocked; `harness.mjs` has the reasons and the setup. This file is only the part that
 * differs from `journey.mjs`: walk each shell's navigation and take a picture of every screen in
 * it. If a screen throws while rendering, the run fails rather than saving a broken image.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { claimAndApprove, DESKTOP, MOBILE, root, startRig, visibleText } from "./harness.mjs";

const outDir = join(root, "docs");
/** Captured for the validation, not for the repository. Gitignored. */
const scratchDir = join(root, ".screenshots");
const dataDir = join(root, ".screenshots-data");
const PORT = 41777;
const HTTP_PORT = 5399;

const SCREENS = ["timer", "notes", "history", "pacing", "invoices", "admin", "settings"];

/**
 * The four that are committed, because the README embeds them.
 *
 * Everything else is captured — walking every screen in both shells is what 23.5 actually
 * validates, and a screen that throws while rendering still fails the run — but written to a
 * scratch directory instead of into the repository. Nothing read the other fourteen. They were
 * eleven megabytes of git history that no file referenced and no routine compared, and there has
 * never been a baseline to compare them against: `shots` overwrites, it does not diff.
 *
 * An older version's screenshots are recoverable by checking that commit out and regenerating,
 * which is a thing I verified rather than assumed.
 */
const COMMITTED = new Set([
  "timer-desktop",
  "timer-mobile",
  "pacing-desktop",
  "invoices-desktop",
]);

async function main() {
  const rig = await startRig({ dataDir, port: PORT, httpPort: HTTP_PORT });

  const { desktop, mobile } = await claimAndApprove(rig, {
    onClaimScreen: (page) => shot(page, "claim-desktop"),
    onRequestScreen: (page) => shot(page, "request-mobile"),
    onAccessScreen: (page) => shot(page, "access-desktop"),
  });

  // The desktop's own screens are captured after the approval rather than before, so `admin` shows
  // a device list with something in it.
  await capture(desktop.page, "desktop");
  await capture(mobile.page, "mobile");

  /*
   * 26.11 — the PDF viewer, which is the one screen in this app that is not a screen.
   *
   * `capture` walks navigation, and a dialog is not in any navigation, so the largest surface in
   * the app was the only one never photographed. It is also the one most likely to be wrong: an
   * iframe with no explicit height collapses to 150px and looks like a rendering failure.
   */
  await desktop.page.getByRole("button", { name: "Invoices", exact: true }).click();
  const viewButton = desktop.page.locator(".stacked-row").first()
    .getByRole("button", { name: "View" });
  await viewButton.waitFor({ timeout: 20_000 }).catch(() => {});
  if (await viewButton.isVisible().catch(() => false)) {
    await viewButton.click();
    await desktop.page.locator("iframe.viewer-frame").waitFor({ timeout: 30_000 });
    // The PDF plugin paints on its own schedule; a shot taken the instant the iframe exists is of
    // a white rectangle, which is indistinguishable from the bug this picture is here to catch.
    await desktop.page.waitForTimeout(2_500);
    await shot(desktop.page, "invoice-viewer-desktop");
    await desktop.page.getByRole("button", { name: "Close" }).click();
  } else {
    throw new Error("no invoice to view: the seed should ship a draft");
  }

  /*
   * 27.19 — the entry editor, on both presentations, in the shape with the most in it.
   *
   * The same reasoning as the viewer above: it is a dialog, `capture` walks navigation, so the
   * form where a start and an end sit beside a date, a shape, a duration and a tag has never been
   * photographed. It is also six fields in an `auto-fit` grid, which is precisely the kind of
   * layout that is fine at the width you developed it at.
   */
  for (const [label, device] of [["desktop", desktop], ["mobile", mobile]]) {
    await device.page.getByRole("button", { name: "History", exact: true }).click();
    await device.page.getByRole("button", { name: "Add past time" }).click();
    await device.page.getByRole("dialog").waitFor({ timeout: 20_000 });
    await device.page.getByLabel("Record as").selectOption({ label: "start and end" });
    await shot(device.page, `entry-editor-${label}`);
    await device.page.getByRole("button", { name: "Cancel" }).click();
  }

  /*
   * 27.5 — the note, with the microphone picker open.
   *
   * Another dialog `capture` cannot reach, and the one place in the app with a disclosure inside a
   * sheet: a card of radios opening inside a card inside an overlay is exactly the nesting that
   * looks fine in the markup and like a mistake on screen.
   */
  await desktop.page.getByRole("button", { name: "Notes", exact: true }).click();
  await desktop.page.getByRole("button", { name: "New work note" }).click();
  await desktop.page.getByRole("dialog").waitFor({ timeout: 20_000 });
  const cog = desktop.page.getByRole("button", { name: "Choose a microphone" });
  if (await cog.count()) {
    await cog.click();
    await desktop.page.getByRole("radio").first().waitFor({ timeout: 10_000 });
  }
  await shot(desktop.page, "work-note-desktop");
  await desktop.page.keyboard.press("Escape");
  await desktop.page.getByRole("button", { name: "Throw it away" }).click().catch(() => {});

  /*
   * 27.17, 27.34 — a month with a public holiday in it, which the current month has not got.
   *
   * `.day.holiday`, `.swatch.holiday` and `.holidaylist` exist for exactly one state and the walk
   * never entered it: every picture is of the seeded month. October 2026 has Labour Day in AU-NSW,
   * which is the region the seed configures.
   */
  await desktop.page.getByRole("button", { name: "Pacing", exact: true }).click();
  await desktop.page.getByRole("button", { name: /Go to October 2026/ }).click();
  await desktop.page.locator(".day.holiday").first().waitFor({ timeout: 20_000 });
  await shot(desktop.page, "pacing-holiday-desktop");
  await desktop.page.getByRole("button", { name: /Go to September 2026/ }).click();

  /*
   * 27.34 — the invoice editor, which nothing had ever photographed.
   *
   * Found by the selector walk below: `.linetable`, `.linerow`, `.linehead`, `.linecell` and
   * `.sheet > .card.editor` matched nothing on any screen of any run, because the only way in is a
   * button inside a row of a list and `capture` walks navigation. It is the densest table in the
   * product and it is where invoice *lines* are edited — the numbers that go on the document.
   */
  await desktop.page.getByRole("button", { name: "Invoices", exact: true }).click();
  const editLine = desktop.page.locator(".stacked-row").first()
    .getByRole("button", { name: "Edit lines" });
  /*
   * Waited for, then counted. `count()` does not auto-wait — it answers about the moment it is
   * asked — so asking it straight after a navigation reads zero from a screen that is still
   * rendering, and the `else` branch below then reports the row as missing. It took a diagnostic
   * printing the row's own buttons to see that "Edit lines" had been there the whole time.
   */
  await editLine.waitFor({ timeout: 20_000 }).catch(() => {});
  if (await editLine.count()) {
    await editLine.click();
    await desktop.page.locator(".linetable").waitFor({ timeout: 20_000 });
    await shot(desktop.page, "invoice-editor-desktop");
    // 26.26 asks before throwing edits away, and nothing has been typed, so Escape is enough.
    await desktop.page.keyboard.press("Escape");
    await desktop.page.locator(".linetable").waitFor({ state: "detached", timeout: 15_000 });
  } else {
    // Says what it found, not just that it found nothing: "no draft" and "the screen had not
    // rendered" look identical from a count, and only one of them is about the product.
    throw new Error(
      `no invoice to edit: row says "${
        (await desktop.page.locator(".stacked-row").first().innerText().catch(() => "no rows"))
          .replace(/\s+/g, " ")
      }"`,
    );
  }

  /*
   * 27.34 — and the waveform, which only exists while a microphone is open.
   *
   * `.trace` and `.trace span` are 24.5's "something that moves when you speak", drawn from the
   * same stream the recorder uses. The browser here has a synthetic microphone, so this is a
   * picture of the real thing rather than of a mock.
   */
  await desktop.page.getByRole("button", { name: "Notes", exact: true }).click();
  await desktop.page.getByRole("button", { name: "New work note" }).click();
  const recordHere = desktop.page.getByRole("button", { name: /Record$/ });
  if (await recordHere.count()) {
    await recordHere.click();
    await desktop.page.locator(".trace span").first().waitFor({ timeout: 20_000 });
    // Long enough for the trace to have more than its first bar in it.
    await desktop.page.waitForTimeout(1_500);
    await shot(desktop.page, "recording-desktop");
    await desktop.page.getByRole("button", { name: "Stop", exact: true }).click();
  }
  await desktop.page.keyboard.press("Escape");
  await desktop.page.getByRole("button", { name: "Throw it away" }).click().catch(() => {});

  /*
   * 19.17 — and the other half of the CSS.
   *
   * The dark palette is a second set of every colour in this app and went unlooked-at for its
   * whole life, because the harness pins `colorScheme: "light"` so a run does not depend on the
   * machine's preference. Looking once found `button.link.danger` had no rule at all: four
   * Delete controls rendering in the same accent blue as the Edit beside them.
   *
   * A third device rather than a second theme on an existing one, because `colorScheme` is fixed
   * when a browser context is made.
   */
  const dark = await rig.open("dark", DESKTOP, "Dark Desktop", { colorScheme: "dark" });
  await approveFrom(desktop.page, dark.page, "Dark Desktop");
  await capture(dark.page, "dark");

  /*
   * 13.33 — and the third role, which nothing has ever drawn.
   *
   * A `read` device is a whole presentation: no Start, no Save, no Delete, no editor. Every
   * screenshot in this repo is of a device that can write, so the screens as somebody with a
   * read-only key sees them have never been looked at — and "the control is hidden" and "the
   * control is there and does nothing" look identical until somebody presses it.
   */
  const viewer = await rig.open("viewer", DESKTOP, "Read Only Laptop");
  await approveFrom(desktop.page, viewer.page, "Read Only Laptop", "read");
  await capture(viewer.page, "readonly");

  // 23.6 — the phone has been a `write` device up to here, so its tab bar has five tabs and the
  // admin screen has never been photographed on a phone at all. Promote it and look: six tabs is
  // the widest that bar ever gets, and the admin screen is the densest thing in the app.
  console.log("  promoting the phone to admin, for the one layout nothing else reaches…");
  // `capture` walked the desktop's whole navigation, so it is sitting on Settings. The device list
  // is two clicks away, and asking for a row that is not on screen just times out.
  await desktop.page.getByRole("button", { name: "Users", exact: true }).click();
  await desktop.page.getByRole("button", { name: "Device access" }).click();
  // A *pending* device is promoted with buttons; an already-authorised one has a `<select>`. They
  // are different tables and the first attempt here used the wrong one, which times out silently.
  await desktop.page.getByRole("row", { name: /Pixel Phone/ })
    .getByRole("combobox")
    .selectOption("admin");
  // 25.35 — choosing a role now asks first, so the `<select>` snaps back to the old value until
  // this is pressed. That reversion is correct and it is also exactly what "the promotion did not
  // take" looked like when this script was still clicking nothing.
  await desktop.page.getByRole("button", { name: "Make it admin" }).click();
  // Confirm on the side that made the change before blaming the side that should see it.
  await desktop.page.waitForTimeout(800);
  const nowRole = await desktop.page.getByRole("row", { name: /Pixel Phone/ })
    .getByRole("combobox").inputValue();
  if (nowRole !== "admin") {
    throw new Error(`the promotion did not take: the phone is still ${nowRole}`);
  }

  await mobile.page.reload();
  const usersTab = mobile.page.getByRole("button", { name: "Users", exact: true });
  try {
    await usersTab.waitFor({ timeout: 30_000 });
  } catch (e) {
    throw new Error(
      `the phone never grew the admin half of Users after being promoted. Showing: ${await visibleText(
        mobile.page,
      )} (${e.message})`,
    );
  }
  await usersTab.click();
  await mobile.page.waitForTimeout(400);
  await shot(mobile.page, "users-mobile");

  /*
   * 27.23 — the invitation, on a phone.
   *
   * The one dialog in the app with a fixed-size image in it, on the presentation where fixed sizes
   * go wrong: a 320px QR inside a sheet inside a 390px screen, with a link that is a hundred
   * characters long in a field beside it.
   */
  await mobile.page.getByRole("button", { name: "Invite a device" }).click();
  await mobile.page.locator(".qr img").waitFor({ timeout: 20_000 });
  await shot(mobile.page, "invite-mobile");
  await mobile.page.getByRole("button", { name: "Done" }).click();

  // 13.27, 13.28, 23.5 — the pending-request layout on a phone, which nothing else reaches: the
  // only device that has ever been pending here *is* the phone, and it cannot photograph its own
  // request while making it. A third context supplies one.
  //
  // An earlier attempt at a third context hung forever because it was made the *admin* and nobody
  // could approve it. This one stays pending on purpose, which is the whole point of it.
  const spare = await rig.open("spare", MOBILE, "Spare Tablet");
  const askSpare = spare.page.getByRole("button", { name: "Ask for access" });
  await askSpare.waitFor({ timeout: 30_000 });
  await askSpare.click();
  await spare.page.getByText("Waiting for approval").waitFor({ timeout: 15_000 });

  await mobile.page.getByText("Spare Tablet").waitFor({ timeout: 20_000 });
  await shot(mobile.page, "pending-mobile");

  /*
   * 27.34 — and the screens when something is wrong, which are the least-looked-at in any product.
   *
   * Every picture above is of things going right. `input.invalid` and `.field-note.bad` were
   * excused as states the walk does not enter, and they are a keystroke away — that is not a state
   * nobody photographs, it is a state nobody had bothered to.
   *
   * Trying to add `.pill.warn` to this is what taught me the excuse beside it was wrong. A device
   * that can write never sees a status *pill* at all: 24.26 replaced Issue/Mark paid/Revert with
   * one `<select>`, and the pill is the read-only rendering of the same fact. So it needs an
   * issued invoice *and* a read-only device, and issuing is not reversible from here while every
   * other picture wants the draft.
   */
  await desktop.page.getByRole("button", { name: "Settings", exact: true }).click();
  await desktop.page.getByLabel("Monthly target (hours)").fill("not a number");
  await desktop.page.locator("input.invalid").first().waitFor({ timeout: 15_000 });
  await shot(desktop.page, "settings-invalid-desktop");
  await desktop.page.getByLabel("Monthly target (hours)").fill("160");

  await rig.close();

  /*
   * And the same walk on a server nobody has put anything into yet.
   *
   * Every picture above is of the seed, which has a month of work, an invoice, a note and a
   * configured region — so the screens as a new arrival meets them had never been looked at. The
   * first thing that walk found was the app telling somebody who had just claimed admin that a
   * holiday source was unreachable: 24.33 forbids defaulting the region, so a fresh server has
   * none, and it asked the source for country "" anyway (6.39).
   *
   * A second rig rather than a flag on the first, because "unseeded" is a property of the
   * database and the database is made when the server starts.
   */

  console.log("\n  and the same screens on a server with nothing in it…");
  const bare = await startRig({
    dataDir: `${dataDir}-firstrun`,
    port: PORT + 1,
    httpPort: HTTP_PORT + 1,
    seed: false,
  });
  const { desktop: fresh } = await claimAndApprove(bare);
  await capture(fresh.page, "firstrun");

  /*
   * 27.30 — and the one first-run state that has a rule of its own.
   *
   * The prompt interval has no default any more, so on this server the box is empty and the switch
   * cannot be turned on. That is the state the seed can never show, and the whole point of the
   * change is what it looks like: a screen that says it has nothing rather than a screen with a
   * number in it that nobody chose.
   */
  /*
   * 27.31, 27.32 — the pacing screen before anything is configured, which is the state that used
   * to say "12h behind" against 160 hours and 22 workdays nobody had chosen.
   *
   * With no schedule the projection card is not drawn at all, so the notice is what to wait for.
   */
  await fresh.page.getByRole("button", { name: "Pacing", exact: true }).click();
  await fresh.page.getByText(/No working hours are set/).waitFor({ timeout: 20_000 });
  await shot(fresh.page, "pacing-firstrun");

  await fresh.page.getByRole("button", { name: "Settings", exact: true }).click();
  await fresh.page.getByText("Work-detail prompts").waitFor({ timeout: 20_000 });
  const freshInterval = await fresh.page.getByLabel("About every (minutes)").inputValue();
  const freshSwitch = await fresh.page.getByLabel("Ask me sometimes").isDisabled();
  if (freshInterval !== "" || !freshSwitch) {
    throw new Error(
      `a fresh server should offer no interval and no switch, and offered ` +
        `"${freshInterval}" with the switch ${freshSwitch ? "off" : "available"}`,
    );
  }
  await bare.close();

  const dead = [...seenSelectors]
    .filter((selector) => !matchedSelectors.has(selector) && !UNPHOTOGRAPHED.has(selector))
    .sort();
  // The other direction too: an excuse for a selector that no longer exists, or that has started
  // matching, is a line nobody will delete unless something says so.
  const stale = [...UNPHOTOGRAPHED.keys()].filter((selector) =>
    !seenSelectors.has(selector) || matchedSelectors.has(selector)
  ).sort();
  console.log(
    `\n${seenSelectors.size} selectors, ${matchedSelectors.size} matched something on some screen`,
  );
  for (const selector of dead) {
    console.error(
      `  ✗ nothing matched ${selector} — a dead rule, or a state to photograph, ` +
        `or a line for UNPHOTOGRAPHED in tools/screenshots.mjs`,
    );
  }
  for (const selector of stale) {
    console.error(`  ✗ UNPHOTOGRAPHED names ${selector}, which no longer needs excusing`);
  }

  const failures = rig.errors.length + bare.errors.length + dead.length + stale.length;
  console.log(
    failures === 0
      ? "\nall screens captured, no page errors, every rule matched something"
      : `\n${failures} problems`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Ask from `page`, approve from `admin`. The dark device needs the same route in as the phone. */
async function approveFrom(admin, page, name, role = "admin") {
  await page.getByRole("button", { name: "Ask for access" }).waitFor({ timeout: 30_000 });
  await page.getByLabel("Access needed").selectOption(role);
  await page.getByRole("button", { name: "Ask for access" }).click();
  await admin.getByRole("button", { name: "Users", exact: true }).click();
  await admin.getByRole("button", { name: "Device access" }).click();
  await admin.getByRole("row", { name: new RegExp(name) })
    .getByRole("button", { name: /^Approve as/ }).click();
  await page.getByRole("button", { name: "Continue" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Today", { exact: true }).waitFor({ timeout: 30_000 });
}

async function capture(page, label) {
  for (const screen of SCREENS) {
    const nav = page.getByRole("button", { name: navLabel(screen), exact: true }).first();
    if (!(await nav.isVisible().catch(() => false))) {
      console.log(`  [${label}] ${screen} is not in this shell's navigation, skipping`);
      continue;
    }
    await nav.click();
    await page.waitForTimeout(400);
    await shot(page, `${screen}-${label}`);
  }
}

function navLabel(screen) {
  return screen.charAt(0).toUpperCase() + screen.slice(1);
}

/**
 * A picture of the whole screen, which `fullPage: true` does not take here.
 *
 * `fullPage` grows the shot to the *document's* scroll height, and this document never scrolls:
 * the app is a fixed-height grid and `.main` is the element with `overflow: auto`. So every
 * screenshot ever taken by this tool — including the four in `docs/` that the README embeds — was
 * the first 1000px of its screen and nothing below. Settings is about four times that, and the
 * invoice details this was written to inspect start below the fold.
 *
 * The viewport is grown to fit the content instead, and put back afterwards. Width is untouched,
 * so the shell does not switch layouts underneath the picture.
 */
const MAX_SHOT_HEIGHT = 6_000;

/**
 * Every selector in the app's own stylesheet, and which of them matched something (27.34).
 *
 * **A rule that matches nothing is invisible.** `.bar > span` was one for several commits — 26.19
 * moved the segments inside `.bar-fill`, the descendant combinator stopped applying, and the bar
 * painted nothing while a check that measured its *width* stayed green. Nothing in the repo asks
 * whether a rule still has a job.
 *
 * This walk is the cheapest place to ask it: `capture` already drives every screen in both shells,
 * both themes, three roles and a server with nothing in it, and the dialogs are opened by hand
 * alongside. A selector that matches on none of that is either dead or is a state nobody
 * photographs, and the difference is worth having to write down.
 *
 * Pseudo-classes are stripped before testing. `:hover` and `:focus-visible` never hold during a
 * screenshot, and a rule that only exists for them would otherwise read as dead for ever.
 */
/**
 * Selectors that legitimately match nothing on a walk of the screens, and why.
 *
 * The point of the list is that it has to be *written*. A rule that stops matching — `.bar > span`
 * did, for several commits, when 26.19 moved the segments inside `.bar-fill` — looks exactly like
 * a rule for a state nobody photographs, and only one of the two is a bug. Adding a line here is
 * cheap; the sentence beside it is the check.
 *
 * Two of these were photographable and are photographed now rather than excused: the invoice
 * editor's line table, and a month with a public holiday in it.
 */
const UNPHOTOGRAPHED = new Map([
  [".audio-blocked", "the banner for a loop the browser refused to autoplay (14.16)"],
  [".bar span.over", "today's bar past its scheduled hours"],
  [".barline .bar > span.bad", "a pacing bar behind its target; the seeded month is ahead"],
  [".brand .dot.bad", "the connection dot when the server is gone"],
  [".brand .dot.warn", "the connection dot while reconnecting"],
  [".day.missed", "a past workday with nothing recorded; the seed fills every one"],
  [".dropzone.over", "a file being dragged over the audio drop target"],
  [".notice.bad", "a failed save; every save in this walk succeeds"],
  [
    ".pill.warn",
    "an issued invoice seen by a read-only device — a writable one gets a <select>, not a pill",
  ],
  ["i.swatch.missed", "the legend entry for .day.missed, and 27.32 shows only present states"],
]);

const seenSelectors = new Set();
const matchedSelectors = new Set();

async function recordSelectors(page) {
  const [all, matched] = await page.evaluate(() => {
    const every = [];
    const hit = [];
    const visit = (rule) => {
      // A grouping rule holds its own list; `cssRules` on a plain style rule is undefined, and an
      // *empty* CSSRuleList is truthy, so the length is what decides.
      if (rule.cssRules && rule.cssRules.length >= 0 && rule.selectorText === undefined) {
        for (const inner of Array.from(rule.cssRules)) visit(inner);
        return;
      }
      if (typeof rule.selectorText !== "string") return;
      for (const one of rule.selectorText.split(",")) {
        const selector = one.trim();
        if (!selector) continue;
        every.push(selector);
        // `:hover`, `::before`, `:focus-visible` — states a still photograph cannot be in.
        const testable = selector.replace(/::?[a-z-]+(\([^)]*\))?/g, "").trim();
        if (!testable) {
          hit.push(selector);
          continue;
        }
        try {
          if (document.querySelector(testable)) hit.push(selector);
        } catch {
          // Not a selector this browser can run; not evidence of anything.
          hit.push(selector);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = Array.from(sheet.cssRules);
      } catch {
        continue; // A cross-origin sheet. There are none, but this must not throw the run.
      }
      for (const rule of rules) visit(rule);
    }
    return [every, hit];
  }).catch(() => [[], []]);
  for (const selector of all) seenSelectors.add(selector);
  for (const selector of matched) matchedSelectors.add(selector);
}

async function shot(page, name) {
  const dir = COMMITTED.has(name) ? outDir : scratchDir;
  await mkdir(dir, { recursive: true });

  const viewport = page.viewportSize();
  const needed = await page.evaluate(() => {
    const main = document.querySelector(".main");
    if (!main) return 0;
    // The chrome above and beside `.main` stays put; only the scrolling part has to grow.
    return Math.ceil(main.scrollHeight - main.clientHeight);
  }).catch(() => 0);

  const grown = viewport && needed > 0;
  if (grown) {
    await page.setViewportSize({
      width: viewport.width,
      height: Math.min(viewport.height + needed, MAX_SHOT_HEIGHT),
    });
    // A reflow, and any lazy measurement that keys off the resize.
    await page.waitForTimeout(250);
  }

  // Before the viewport is put back, so a rule that only applies at the grown height still counts.
  await recordSelectors(page);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  if (grown) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
  }
  console.log(
    `  ${name}.png${COMMITTED.has(name) ? "" : "  (scratch)"}${grown ? `  +${needed}px` : ""}`,
  );
}

await main().catch((err) => {
  // The stack, not just the message: "Timeout 30000ms exceeded" is the same sentence for every
  // locator in the file, and the line number is the only thing that says which one.
  console.error(`screenshots: ${err.stack ?? err.message}`);
  process.exit(1);
});
