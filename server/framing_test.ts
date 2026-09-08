/**
 * The subscribe stream's framing, checked against the *real* server's writes.
 *
 * This exists because a fake was more correct than the thing it stood in for. `client_test.ts`
 * drives a transport that writes the subscribe acknowledgement as `JSON.stringify(...) + "\n"`,
 * matching what `WorklogClient.subscribe` parses. `main.ts` writes it with `encodeJson`, which has
 * no newline, and then writes every event after it with `encodeEvent`, which does. So the ack and
 * the first event arrive as one unparseable string, the client's `catch` treats it as one event
 * lost, and every subscription silently drops its first event.
 *
 * Nothing failed. The device that made a change refreshed itself locally and looked fine; the
 * second device was one event behind forever, and only a two-browser test could see it.
 *
 * So the assertions below are on bytes rather than on behaviour, because the defect was in a
 * delimiter and behaviour is exactly what hid it.
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { encodeEvent, splitLines } from "@worklog/shared/protocol";
import type { Event, Response } from "@worklog/shared/protocol";
import { encodeSubscribeAck } from "./framing.ts";

const decoder = new TextDecoder();

Deno.test("the subscribe acknowledgement ends in a newline, like everything after it", () => {
  const bytes = encodeSubscribeAck({ ok: true, result: null } satisfies Response);
  assertEquals(decoder.decode(bytes).endsWith("\n"), true);
});

Deno.test("the first event after the acknowledgement survives the split", () => {
  // Exactly what the client sees when both writes land in one chunk, which is the common case:
  // the ack goes out and an event follows before the reader has been scheduled.
  const event: Event = { e: "changed", area: "entries" };
  const chunk = decoder.decode(encodeSubscribeAck({ ok: true, result: null })) +
    decoder.decode(encodeEvent(event));

  const { lines, rest } = splitLines(chunk);
  assertEquals(lines.length, 2, "the ack and the event are two lines, not one");
  assertEquals(rest, "");

  const parsed = lines.map((l) => JSON.parse(l));
  assertEquals("ok" in parsed[0]!, true, "the first line is the acknowledgement");
  assertEquals(parsed[1], event, "and the second is the event, intact");
});

Deno.test("an acknowledgement carrying a result is still one line", () => {
  // The subscribe result is `null` today, but nothing in the protocol says it must be, and a
  // multi-line ack would resynchronise the stream onto the wrong boundary for good.
  const bytes = encodeSubscribeAck({ ok: true, result: { nested: ["a\nb", 1] } });
  const text = decoder.decode(bytes);
  assertEquals(text.split("\n").length, 2, "one newline, at the end");
  // JSON escapes the interior newline, which is what makes line-delimiting safe at all.
  assertEquals(text.includes("a\\nb"), true);
});
