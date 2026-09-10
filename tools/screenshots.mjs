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

  const failures = rig.errors.length + bare.errors.length;
  console.log(
    failures === 0 ? "\nall screens captured, no page errors" : `\n${failures} page errors`,
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
