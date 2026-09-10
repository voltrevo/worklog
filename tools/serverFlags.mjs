/**
 * The permissions the server runs with, read from the one place they are declared (27.25).
 *
 * The harness spawns `deno run server/main.ts` itself rather than going through `deno task serve`,
 * because it has to kill that exact process — a task wrapper leaves a server holding the port when
 * the run dies, which this harness has been bitten by before. But a second copy of the flag list
 * is a second thing to forget, and the copy that would go stale is the one under test: the journey
 * would keep passing on `-A` while the shipped task was missing a permission the product needs.
 *
 * So the flags come out of `deno.json`. The task is a fixed shape — `deno run <flags>
 * server/main.ts` — and if it ever is not, this throws at startup rather than quietly falling back
 * to something permissive.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function serverFlags() {
  const config = JSON.parse(
    readFileSync(fileURLToPath(new URL("../deno.json", import.meta.url)), "utf8"),
  );
  const task = config.tasks?.serve;
  const found = /^deno run (.+) server\/main\.ts$/.exec(task ?? "");
  if (!found) {
    throw new Error(
      `the "serve" task is not the shape tools/serverFlags.mjs reads: ${task}`,
    );
  }
  return found[1].split(" ").filter(Boolean);
}
