/**
 * The recording meter's arithmetic (24.5).
 *
 * Unit-tested because the display is the point and the display is derived: if `barHeight` is wrong
 * the trace either sits flat while somebody speaks or pins to the top on room noise, and both look
 * like a broken microphone — which is the confusion the trace exists to remove. The stream
 * plumbing is not tested here; there is nothing to assert about it that is not the browser's.
 */

/// <reference lib="dom" />
// `levels.ts` is browser code — `MediaStream`, `AudioContext` — so the DOM lib is needed to reach
// it from the Deno side at all. Same reason as `localAudio_test.ts`.

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import { barHeight, RANGE_DB, rms } from "./levels.ts";

/** `getByteTimeDomainData` centres silence on 128. */
function samples(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

Deno.test("silence is zero, and silence is 128 rather than 0", () => {
  assertEquals(rms(samples(128, 128, 128, 128)), 0);
  // A buffer of literal zeros is not silence, it is the waveform pinned to the negative rail.
  assertEquals(rms(samples(0, 0, 0, 0)), 1);
});

Deno.test("a full-scale square wave is one", () => {
  assertEquals(rms(samples(0, 255, 0, 255)) > 0.99, true);
});

Deno.test("rms is the root mean square, not the peak", () => {
  // Half the samples at full deflection, half silent: rms = sqrt(1/2).
  assertAlmostEquals(rms(samples(0, 128, 0, 128)), Math.SQRT1_2, 1e-9);
});

Deno.test("an empty buffer is zero rather than NaN", () => {
  assertEquals(rms(new Uint8Array()), 0);
});

Deno.test("the bar is logarithmic, so ordinary speech is not pinned to the floor", () => {
  assertEquals(barHeight(0), 0);
  assertEquals(barHeight(1), 1);

  // The failure this guards against: on a linear scale a quiet-but-audible voice around -30 dB
  // draws a bar 3% tall and the trace looks dead. On this curve it is a fifth of the way up.
  const speech = Math.pow(10, -30 / 20);
  assertEquals(speech < 0.04, true, "that really is a tiny linear value");
  assertAlmostEquals(barHeight(speech), 1 - 30 / RANGE_DB, 1e-12);
  assertEquals(barHeight(speech) > 0.35, true);
});

Deno.test("anything below the range floor clamps to zero rather than going negative", () => {
  const inaudible = Math.pow(10, -(RANGE_DB + 20) / 20);
  assertEquals(barHeight(inaudible), 0);
});
