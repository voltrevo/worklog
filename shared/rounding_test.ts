import { assertEquals } from "jsr:@std/assert@^1";
import { hoursOf, roundHours } from "./rounding.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;

Deno.test("hoursOf rounds to a tenth", () => {
  assertEquals(hoursOf(0), 0);
  assertEquals(hoursOf(HOUR), 1);
  assertEquals(hoursOf(2 * HOUR + 30 * MINUTE), 2.5);
  assertEquals(hoursOf(14 * MINUTE), 0.2); // 0.2333… → 0.2
  assertEquals(hoursOf(17 * MINUTE), 0.3); // 0.2833… → 0.3
});

Deno.test("hoursOf sends an exact half to the even tenth", () => {
  // Three minutes is exactly half a tenth of an hour, which is the only input where the choice of
  // rule is visible. Half-up would give 0.3, 0.5, 0.7, 0.9 — all four in the same direction.
  assertEquals(hoursOf(15 * MINUTE), 0.2, "0.25h → 0.2");
  assertEquals(hoursOf(21 * MINUTE), 0.4, "0.35h → 0.4");
  assertEquals(hoursOf(27 * MINUTE), 0.4, "0.45h → 0.4");
  assertEquals(hoursOf(33 * MINUTE), 0.6, "0.55h → 0.6");
  // Which is the point: they split two and two rather than all rounding up.
});

Deno.test("hoursOf is exact on the boundary rather than nearly exact", () => {
  // `0.25 * 10` and `2.5 * 10` are not the same kind of question to a float, and rounding on the
  // hours value instead of the milliseconds gets one of them wrong. Every one of these is dead on
  // a boundary and every one must take the half-to-even branch, not the > or < branch.
  for (let tenths = 0; tenths < 60; tenths++) {
    const ms = tenths * 360_000 + 180_000;
    const expected = (tenths % 2 === 0 ? tenths : tenths + 1) / 10;
    assertEquals(hoursOf(ms), expected, `${ms}ms`);
  }
});

Deno.test("hoursOf is symmetric about zero", () => {
  // Pacing runs negative — "behind" is a real value, not an error — and half-to-even has to mean
  // the same thing on both sides or the two directions round differently.
  assertEquals(hoursOf(-15 * MINUTE), -0.2);
  assertEquals(hoursOf(-21 * MINUTE), -0.4);
  assertEquals(hoursOf(-(2 * HOUR + 30 * MINUTE)), -2.5);
});

Deno.test("roundHours agrees with hoursOf", () => {
  assertEquals(roundHours(0.25), 0.2);
  assertEquals(roundHours(0.35), 0.4);
  assertEquals(roundHours(7.5), 7.5);
  assertEquals(roundHours(-0.25), -0.2);
  // A float clear of the boundary must not be treated as one.
  assertEquals(roundHours(0.2501), 0.3);
});

Deno.test("roundHours quantises to the millisecond before deciding", () => {
  // 0.2500001h is 900000.36ms, and a duration is a whole number of milliseconds — so this is the
  // boundary, and it takes the half-to-even branch rather than counting as "just past". Recorded
  // because it is the one place the float path and the millisecond path can be told apart, and
  // because I wrote the opposite expectation first and had to be corrected by the test.
  assertEquals(roundHours(0.2500001), 0.2);
  assertEquals(roundHours(0.25 + 0.4 / 3_600_000), 0.2, "under half a millisecond over");
  assertEquals(roundHours(0.25 + 0.6 / 3_600_000), 0.3, "over half a millisecond over");
});

Deno.test("a rounded value survives being rounded again", () => {
  // The invoice freezes the rounded hours and computes from them (25.7); anything that re-rounds
  // a stored value must not move it a second time.
  for (let tenths = 0; tenths < 200; tenths++) {
    const h = tenths / 10;
    assertEquals(roundHours(h), h, `${h}`);
  }
});
