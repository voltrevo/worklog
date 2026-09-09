/**
 * The two numbers a voice note has to fit inside.
 *
 * `MAX_REQUEST_BYTES` bounds what the server will read; a note travels as base64 inside the JSON,
 * so what the recorder may collect is smaller than that by a third plus room for the rest of the
 * message. The arithmetic is three lines and it decides when a recording stops, which is a thing
 * somebody is doing at the time — so it is worth pinning rather than re-deriving.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import { MAX_NOTE_AUDIO_BYTES, MAX_REQUEST_BYTES } from "./protocol.ts";

Deno.test("a note that fills the recorder's budget still fits in a request", () => {
  // What the wire actually carries: base64 of the audio, plus the JSON around it.
  const base64 = Math.ceil(MAX_NOTE_AUDIO_BYTES / 3) * 4;
  assert(
    base64 < MAX_REQUEST_BYTES,
    `${base64} bytes of base64 does not fit in ${MAX_REQUEST_BYTES}`,
  );
  // And with a few kilobytes to spare for the body, the tag and the timestamps.
  assert(MAX_REQUEST_BYTES - base64 > 4_000, "no room left for the rest of the message");
});

Deno.test("and the budget is worth something in minutes", () => {
  // 5.27's 20 kbit/s is 2,500 bytes a second.
  const seconds = MAX_NOTE_AUDIO_BYTES / 2_500;
  assert(seconds > 240, `only ${Math.round(seconds)}s of speech fits`);
  assertEquals(seconds < 900, true, "a limit this large is not the one being described");
});
