import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import { decibelsFor, gainFor, labelFor, RANGE_DB } from "./gain.ts";

Deno.test("14.22 -- zero is silence, exactly, and not a small number", () => {
  assertEquals(gainFor(0), 0);
  assertEquals(
    gainFor(-1),
    0,
    "and below zero is still silence rather than an error",
  );
  assertEquals(labelFor(0), "off");
});

Deno.test("the top of the travel is unity, with no headroom to trip over", () => {
  assertEquals(gainFor(1), 1);
  assertEquals(gainFor(2), 1);
  assertEquals(labelFor(1), "0 dB");
});

Deno.test("14.23 -- the travel spans sixty decibels", () => {
  assertAlmostEquals(decibelsFor(0), -RANGE_DB, 1e-9);
  assertAlmostEquals(decibelsFor(1), 0, 1e-9);
  assertAlmostEquals(decibelsFor(0.5), -RANGE_DB / 2, 1e-9);
  // A half-way slider is -30 dB, which is about a thirtieth of the amplitude -- correct, and the
  // number that makes people think a linear control is "broken" when it is merely linear.
  assertAlmostEquals(gainFor(0.5), 10 ** -1.5, 1e-12);
});

Deno.test("14.19/14.20 -- equal movement is equal change, everywhere on the slider", () => {
  // The property a linear slider fails: the ratio between two positions a step apart is the same
  // at the bottom of the travel as at the top, so the quiet end is as controllable as the loud.
  const step = 0.05;
  const ratios: number[] = [];
  for (let p = step; p < 1; p += step) {
    ratios.push(gainFor(p + step) / gainFor(p));
  }
  const first = ratios[0]!;
  for (const [i, r] of ratios.entries()) {
    assertAlmostEquals(
      r,
      first,
      1e-9,
      `step ${i} changed by a different factor`,
    );
  }
});

Deno.test("14.21 -- there is no floor: the bottom of the travel keeps getting quieter", () => {
  // The failure this guards against is a control that bottoms out at a few percent amplitude and
  // calls it quiet. A tenth of the way up should be far below a hundredth of full scale.
  assertEquals(
    gainFor(0.1) < 0.002,
    true,
    `${gainFor(0.1)} is not quiet enough`,
  );
  assertEquals(gainFor(0.02) < gainFor(0.05), true);
  assertEquals(
    gainFor(0.001) > 0,
    true,
    "and it is still audible, not silently clamped to zero",
  );
});

Deno.test("gain rises monotonically across the whole slider", () => {
  let previous = -1;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const g = gainFor(p);
    assertEquals(g > previous, true, `gain did not rise at ${p.toFixed(2)}`);
    previous = g;
  }
});

Deno.test("the label reads as decibels below unity", () => {
  assertEquals(labelFor(0.5), "-30 dB");
  assertEquals(labelFor(0.25), "-45 dB");
  assertEquals(labelFor(0.9), "-6 dB");
});
