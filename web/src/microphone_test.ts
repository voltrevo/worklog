/**
 * 5.32 — a voice note must not be degraded by the background loop.
 *
 * A source check rather than a call, for `idb_test.ts`'s reason: `microphone.ts` is DOM-typed,
 * `deno test` has no DOM, and `deno task check` deliberately names only the two frontend files that
 * are free of it. The frontend's types are `tsc`'s job and its behaviour is the journey's; what is
 * left for this suite is the shape of the decision, which is what went wrong here.
 *
 * And the shape is the whole of it. These are three booleans that would not deserve a test if they
 * had been chosen — but each was a default that survived being read. `echoCancellation` and
 * `noiseSuppression` arrived with the feature under a comment citing 5.26, which asks for
 * low-bitrate mono and says nothing about processing. `autoGainControl` was never written here at
 * all, so the value in force was Chromium's, which is on: a flag nobody in this codebase had
 * chosen, indistinguishable from one somebody had (27.33). What announced it was a voice note
 * ruined by this app's own background loop, in headphones, where there was no echo to cancel.
 *
 * The journey checks the same thing where it cannot be faked — on a live track's own settings.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";

const SOURCE = new URL("./microphone.ts", import.meta.url).pathname;

Deno.test({
  name: "5.32 -- the three processing flags are off where the constraints are built",
  async fn() {
    const src = await Deno.readTextFile(SOURCE);
    const body = src.slice(src.indexOf("export function micConstraints"));
    assert(body.length > 0, "micConstraints is still where this expects it");

    for (const flag of ["echoCancellation", "noiseSuppression", "autoGainControl"]) {
      const at = body.indexOf(flag);
      assert(at >= 0, `${flag} is named explicitly rather than left to the browser's default`);
      const value = body.slice(at + flag.length, at + flag.length + 8);
      assert(
        value.includes("false"),
        `${flag} is \`${value.trim()}\` — 5.32 wants it off. Echo cancellation subtracts what the ` +
          `page is playing from what the microphone hears, keyed on the render stream rather than ` +
          `on any sound in the room, so in headphones it gouges the speech instead of protecting ` +
          `it (GitHub #3). Noise suppression is tuned for stationary noise and the loop is music; ` +
          `gain control rides the level against it, which is what pumps.`,
      );
    }
  },
});

Deno.test({
  name: "5.26 -- and it is still mono, which is the part that was actually required",
  async fn() {
    const src = await Deno.readTextFile(SOURCE);
    assert(
      /channelCount:\s*1/.test(src),
      "5.26 asks for mono; it is the requirement the processing flags were filed under and the " +
        "only one of the four that came from it",
    );
  },
});

Deno.test({
  name:
    "27.5 -- a chosen microphone is still `exact`, so a stale choice fails rather than swapping",
  async fn() {
    const src = await Deno.readTextFile(SOURCE);
    assertEquals(
      /deviceId:\s*\{\s*exact:/.test(src),
      true,
      "`ideal` would record through the laptop lid while the screen named a headset",
    );
  },
});
