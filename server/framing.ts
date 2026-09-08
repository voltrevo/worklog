/**
 * The one place that knows the subscribe stream is line-delimited.
 *
 * An ordinary request gets a bare JSON body and the closing of the write half is the delimiter —
 * `protocol.ts` says so, and `Transport.request` reads to end-of-stream. A subscription cannot work
 * that way: the stream stays open, so every message on it needs a boundary of its own, and the
 * boundary is a newline.
 *
 * The acknowledgement is the first message on that stream and therefore needs the newline too. It
 * did not have one, because it was written by the same line as every other response — and the
 * result was that each subscription lost its first event to a failed `JSON.parse`, which the client
 * swallows by design. Giving it a named function is the fix and the reminder: the two framings look
 * identical at the call site and are not interchangeable.
 */

import { encodeJson } from "@worklog/shared/protocol";
import type { Response } from "@worklog/shared/protocol";

/** The subscribe response, framed as the line the client's reader is looking for. */
export function encodeSubscribeAck(response: Response): Uint8Array {
  const body = encodeJson(response);
  const out = new Uint8Array(body.length + 1);
  out.set(body);
  out[body.length] = 0x0a; // "\n"
  return out;
}
