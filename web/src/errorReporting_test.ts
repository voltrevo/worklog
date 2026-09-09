import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  describeError,
  flushQueue,
  queuedCount,
  report,
  type ReportedError,
  type Sender,
} from "./errorReporting.ts";

/**
 * A stand-in for `localStorage`, because these functions are about what survives a failure and
 * that is exactly what a real one would make hard to observe.
 *
 * **`globalThis.localStorage = …` does not work**, which is how this was written first. Deno
 * defines it as a getter with no setter, so the assignment is a silent no-op outside strict mode
 * and every test then read Deno's *real* localStorage — a file on disk that persists between runs.
 * The tests passed, then failed a run later with counts that had climbed. Hence `defineProperty`,
 * and hence the assertion below: an instrument that can fail to install has to say so.
 */
function fakeStorage(): void {
  const held = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => held.set(k, v),
      removeItem: (k: string) => held.delete(k),
      clear: () => held.clear(),
    },
  });
  localStorage.setItem("worklog.storageProbe", "1");
  assertEquals(
    held.get("worklog.storageProbe"),
    "1",
    "the fake did not take, so the rest of this test would measure the real store",
  );
  held.clear();
}

const ok: Sender = () => Promise.resolve();
const broken: Sender = () => Promise.reject(new Error("not connected"));

Deno.test("12.8/16.4 -- the report carries the failure and nothing about the device", () => {
  const described = describeError(
    new TypeError("cannot read property"),
    "render:Invoices",
  );
  assertEquals(described.message, "TypeError: cannot read property");
  assertEquals(described.context.where, "render:Invoices");
  assertEquals(typeof described.context.uptimeMs, "number");

  // An allow-list, so a field cannot join by accident. These are all of them.
  assertEquals(
    Object.keys(described.context).sort(),
    ["stack", "uptimeMs", "where"],
  );
});

Deno.test("something thrown that is not an Error still describes as something", () => {
  assertEquals(describeError("just a string", "x").message, "just a string");
  assertEquals(describeError(undefined, "x").message, "undefined");
  assertEquals("stack" in describeError("nope", "x").context, false);
});

Deno.test("a long stack is trimmed to the part that says where the fault is", () => {
  const err = new Error("deep");
  err.stack = [
    "Error: deep",
    ...Array.from({ length: 40 }, (_, i) => `    at frame${i}`),
  ].join(
    "\n",
  );
  const lines = String(describeError(err, "x").context.stack).split("\n");
  assertEquals(lines.length, 12);
  assertStringIncludes(lines[0]!, "Error: deep");
});

Deno.test("12.14 -- a report that cannot be sent is kept, and goes out later", async () => {
  fakeStorage();
  await report(broken, describeError(new Error("while offline"), "x"));
  assertEquals(queuedCount(), 1);

  const sent: ReportedError[] = [];
  const record: Sender = (r) => {
    sent.push(r);
    return Promise.resolve();
  };
  assertEquals(await flushQueue(record), 1);
  assertEquals(queuedCount(), 0);
  assertEquals(sent[0]?.message, "Error: while offline");
});

Deno.test("a flush that fails puts the reports back rather than losing them", async () => {
  fakeStorage();
  await report(broken, describeError(new Error("a"), "x"));
  await report(broken, describeError(new Error("b"), "x"));
  assertEquals(queuedCount(), 2);

  assertEquals(await flushQueue(broken), 0, "still nowhere to send them");
  assertEquals(queuedCount(), 2, "and they are still here");

  assertEquals(await flushQueue(ok), 2);
  assertEquals(queuedCount(), 0);
});

Deno.test("the queue is bounded, and it is the oldest that goes", async () => {
  fakeStorage();
  for (let i = 0; i < 30; i++) {
    await report(broken, describeError(new Error(`e${i}`), "x"));
  }
  assertEquals(queuedCount(), 20);

  const sent: ReportedError[] = [];
  await flushQueue((r) => {
    sent.push(r);
    return Promise.resolve();
  });
  // The newest survived: an error from a session that has since restarted is the least
  // interesting thing in a bounded list.
  assertEquals(sent[0]?.message, "Error: e10");
  assertEquals(sent.at(-1)?.message, "Error: e29");
});

Deno.test("reporting never throws, whatever the sender does", async () => {
  fakeStorage();
  const hostile: Sender = () => {
    throw new Error("synchronous, even");
  };
  await report(hostile, describeError(new Error("x"), "x"));
  assertEquals(queuedCount(), 1, "and it was still kept");
});

Deno.test("flushing an empty queue does nothing and says so", async () => {
  fakeStorage();
  assertEquals(await flushQueue(broken), 0);
});

Deno.test("a report that arrives during a flush is not lost", async () => {
  /*
   * The queue's whole job is not to lose reports, and it had a window where it did.
   *
   * `flushQueue` empties the store before it starts sending, so that a report arriving mid-flush
   * is not sent twice. But it then wrote the failures back with `writeQueue(failed)` — a
   * *replacement* — and anything `report` had added in the meantime was replaced along with it.
   *
   * Narrow, and it is precisely the case the queue exists for: the connection is down, so sending
   * fails, so the flush is slow, so there is time for another error. The moment it is most likely
   * to happen is the moment it costs something.
   */
  fakeStorage();
  await report(broken, describeError(new Error("queued before"), "x"));
  assertEquals(queuedCount(), 1);

  const racing: Sender = async () => {
    await report(broken, describeError(new Error("arrived during"), "x"));
    throw new Error("still not connected");
  };
  assertEquals(await flushQueue(racing), 0);
  assertEquals(queuedCount(), 2, "the report that arrived during the flush was dropped");

  // And both are the real ones, in the order they happened.
  const sent: ReportedError[] = [];
  await flushQueue((e) => {
    sent.push(e as ReportedError);
    return Promise.resolve();
  });
  assertEquals(sent.map((e) => e.message), [
    "Error: queued before",
    "Error: arrived during",
  ]);
});
