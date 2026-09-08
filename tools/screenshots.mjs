/**
 * 23.5 — screenshots of both presentations, from a real browser against a real server.
 *
 *     deno task shots
 *
 * Nothing is mocked; `harness.mjs` has the reasons and the setup. This file is only the part that
 * differs from `journey.mjs`: walk each shell's navigation and take a picture of every screen in
 * it. If a screen throws while rendering, the run fails rather than saving a broken image.
 */

import { join } from "node:path";
import { claimAndApprove, root, startRig } from "./harness.mjs";

const outDir = join(root, "docs");
const dataDir = join(root, ".screenshots-data");
const PORT = 41777;
const HTTP_PORT = 5399;

const SCREENS = ["timer", "history", "pacing", "invoices", "admin", "settings"];

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

  await rig.close();

  const failures = rig.errors.length;
  console.log(
    failures === 0 ? "\nall screens captured, no page errors" : `\n${failures} page errors`,
  );
  process.exit(failures === 0 ? 0 : 1);
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
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });
  console.log(`  ${name}.png`);
}

await main().catch((err) => {
  console.error(`screenshots: ${err.message}`);
  process.exit(1);
});
