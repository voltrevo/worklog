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

  // 23.6 — the phone has been a `write` device up to here, so its tab bar has five tabs and the
  // admin screen has never been photographed on a phone at all. Promote it and look: six tabs is
  // the widest that bar ever gets, and the admin screen is the densest thing in the app.
  console.log("  promoting the phone to admin, for the one layout nothing else reaches…");
  // `capture` walked the desktop's whole navigation, so it is sitting on Settings. The device list
  // is two clicks away, and asking for a row that is not on screen just times out.
  await desktop.page.getByRole("button", { name: "Admin", exact: true }).click();
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
  const adminTab = mobile.page.getByRole("button", { name: "Admin", exact: true });
  try {
    await adminTab.waitFor({ timeout: 30_000 });
  } catch (e) {
    throw new Error(
      `the phone never grew an Admin tab after being promoted. Showing: ${await visibleText(
        mobile.page,
      )} (${e.message})`,
    );
  }
  await adminTab.click();
  await mobile.page.waitForTimeout(400);
  await shot(mobile.page, "admin-mobile");

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

  const failures = rig.errors.length;
  console.log(
    failures === 0 ? "\nall screens captured, no page errors" : `\n${failures} page errors`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Ask from `page`, approve from `admin`. The dark device needs the same route in as the phone. */
async function approveFrom(admin, page, name) {
  await page.getByRole("button", { name: "Ask for access" }).waitFor({ timeout: 30_000 });
  await page.getByLabel("Access needed").selectOption("admin");
  await page.getByRole("button", { name: "Ask for access" }).click();
  await admin.getByRole("button", { name: "Admin", exact: true }).click();
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

async function shot(page, name) {
  const dir = COMMITTED.has(name) ? outDir : scratchDir;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  console.log(`  ${name}.png${COMMITTED.has(name) ? "" : "  (scratch)"}`);
}

await main().catch((err) => {
  // The stack, not just the message: "Timeout 30000ms exceeded" is the same sentence for every
  // locator in the file, and the line number is the only thing that says which one.
  console.error(`screenshots: ${err.stack ?? err.message}`);
  process.exit(1);
});
