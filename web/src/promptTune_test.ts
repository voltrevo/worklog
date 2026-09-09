/// <reference lib="dom" />
// `promptTune.ts` is browser code — `AudioContext`, `OscillatorNode` — so the DOM lib is needed to
// reach it from the Deno side at all. Same reason as `levels_test.ts`.

import { assertEquals } from "jsr:@std/assert@^1";
import {
  MAX_SECONDS,
  NOTE_S,
  PHRASE_HZ,
  REPEAT_EVERY_S,
  STEP_S,
  tuneSchedule,
} from "./promptTune.ts";

Deno.test("25.39 -- the phrase repeats rather than sounding once", () => {
  const notes = tuneSchedule();
  // The fault this replaces: two notes, a quarter of a second, and then nothing. You had to be
  // within earshot at that instant, which is the one thing a prompt cannot assume.
  assertEquals(notes.length > PHRASE_HZ.length, true, `${notes.length} notes`);
  assertEquals(notes.length % PHRASE_HZ.length, 0, "whole phrases only");
});

Deno.test("and it stops after a minute", () => {
  const notes = tuneSchedule();
  const last = notes.at(-1)!;
  assertEquals(last.at + NOTE_S <= MAX_SECONDS, true, `last note ends at ${last.at + NOTE_S}`);
  // Not far short of it either — a tune that gave up after ten seconds would pass the line above
  // and fail the requirement.
  assertEquals(last.at > MAX_SECONDS - REPEAT_EVERY_S * 2, true, `last note at ${last.at}`);
});

Deno.test("a phrase that would be cut off is not begun", () => {
  // Half a phrase reads as a fault rather than as an ending.
  const short = tuneSchedule(REPEAT_EVERY_S + 0.01);
  assertEquals(short.length, PHRASE_HZ.length);
  const tooShort = tuneSchedule(0.1);
  assertEquals(tooShort, []);
});

Deno.test("the notes are in order and evenly spaced", () => {
  const notes = tuneSchedule(REPEAT_EVERY_S * 2 + 1);
  for (let i = 1; i < notes.length; i++) {
    assertEquals(notes[i]!.at > notes[i - 1]!.at, true, `note ${i} is not after note ${i - 1}`);
  }
  // Within a phrase, one step; between phrases, the repeat gap.
  const within = notes[1]!.at - notes[0]!.at;
  assertEquals(Math.abs(within - STEP_S) < 1e-9, true, `${within}`);
  const across = notes[PHRASE_HZ.length]!.at - notes[0]!.at;
  assertEquals(Math.abs(across - REPEAT_EVERY_S) < 1e-9, true, `${across}`);
});

Deno.test("every phrase is the same phrase", () => {
  const notes = tuneSchedule(REPEAT_EVERY_S * 3 + 1);
  for (let i = 0; i < notes.length; i++) {
    assertEquals(notes[i]!.hz, PHRASE_HZ[i % PHRASE_HZ.length]);
  }
});

Deno.test("the phrase fits inside its repeat gap", () => {
  // Otherwise the tune overlaps itself, which is a chord and not a repetition. A property of the
  // constants rather than of the function, and the reason to state it here is that changing
  // `STEP_S` to something that sounds better is exactly how it would stop being true.
  const phraseLength = (PHRASE_HZ.length - 1) * STEP_S + NOTE_S;
  assertEquals(phraseLength < REPEAT_EVERY_S, true, `${phraseLength}s in a ${REPEAT_EVERY_S}s gap`);
});
