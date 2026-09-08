import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import { POLL_INTERVAL_MS, PromptHub, PromptScheduler } from "./prompts.ts";

const T0 = 1_788_000_000_000;
const MEAN = 45 * 60_000;

/** A `random` that returns exactly what the test wants, in order. */
function scripted(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 1;
}

Deno.test("nothing fires while no timer is running", () => {
  const s = new PromptScheduler();
  assertEquals(s.running, false);
  assertEquals(s.poll(T0, MEAN, scripted(0)), false, "5.6 -- even with a certain draw");
  assertEquals(s.probabilityFor(T0, MEAN), 0);
});

Deno.test("5.11 -- the first poll after a start prices only the time since the start", () => {
  // Without the clamp this would price however long the server had been idle, and a prompt would
  // fire almost immediately every time work began.
  const s = new PromptScheduler();
  s.onTimerStarted(T0);
  assertEquals(s.elapsedFor(T0), 0);
  assertEquals(s.elapsedFor(T0 + POLL_INTERVAL_MS), POLL_INTERVAL_MS);
  assertEquals(s.probabilityFor(T0, MEAN), 0, "no time has passed, so no chance");
});

Deno.test("5.12 -- the probability is the elapsed fraction of the mean interval", () => {
  const s = new PromptScheduler();
  s.onTimerStarted(T0);
  assertAlmostEquals(s.probabilityFor(T0 + POLL_INTERVAL_MS, MEAN), 10 / 2700, 1e-12);
  assertAlmostEquals(s.probabilityFor(T0 + MEAN / 2, MEAN), 0.5, 1e-12);
});

Deno.test("5.31 -- a delayed poll is capped at certainty rather than exceeding it", () => {
  const s = new PromptScheduler();
  s.onTimerStarted(T0);
  // A suspended laptop: three hours between polls, against a 45-minute mean.
  assertEquals(s.probabilityFor(T0 + 3 * 3_600_000, MEAN), 1);
  // ...and being capped, a draw of exactly 1 still does not fire, so it is a probability rather
  // than a guarantee dressed up as arithmetic.
  assertEquals(s.poll(T0 + 3 * 3_600_000, MEAN, scripted(1)), false);
});

Deno.test("a poll advances the clock whether or not it fired", () => {
  // The elapsed seconds have been priced either way; not advancing would count them twice.
  const s = new PromptScheduler();
  s.onTimerStarted(T0);
  s.poll(T0 + 60_000, MEAN, scripted(1)); // did not fire
  assertEquals(s.elapsedFor(T0 + 70_000), 10_000, "only the new ten seconds are left to price");

  s.poll(T0 + 70_000, MEAN, scripted(0)); // fired
  assertEquals(s.elapsedFor(T0 + 80_000), 10_000);
});

Deno.test("5.13 -- stopping the timer discards the state entirely", () => {
  const s = new PromptScheduler();
  s.onTimerStarted(T0);
  s.poll(T0 + 60_000, MEAN, scripted(1));
  s.onTimerStopped();
  assertEquals(s.running, false);
  assertEquals(s.elapsedFor(T0 + 10 * 3_600_000), 0, "ten hours later there is nothing to resume");

  // 5.14 -- and restarting does not inherit anything from the previous session.
  s.onTimerStarted(T0 + 10 * 3_600_000);
  assertEquals(s.elapsedFor(T0 + 10 * 3_600_000), 0);
});

Deno.test("over a long run the rate is about one prompt per mean interval", () => {
  // Not a distribution test -- just a check that the arithmetic is not out by an order of
  // magnitude, which is the failure a clamp or a units slip would actually produce.
  const s = new PromptScheduler();
  s.onTimerStarted(T0);
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let fired = 0;
  const polls = 8 * 3_600_000 / POLL_INTERVAL_MS; // eight hours
  for (let i = 1; i <= polls; i++) {
    if (s.poll(T0 + i * POLL_INTERVAL_MS, MEAN, random)) fired++;
  }
  const expected = (8 * 3_600_000) / MEAN; // ~10.7
  assertEquals(fired > expected / 3 && fired < expected * 3, true, `fired ${fired}`);
});

// ------------------------------------------------------------------ delivery

Deno.test("5.16 -- every listening frontend gets the event", () => {
  const hub = new PromptHub();
  const got: string[] = [];
  hub.add({ id: "a", deliver: (e) => got.push(`a:${e.id}`) });
  hub.add({ id: "b", deliver: (e) => got.push(`b:${e.id}`) });

  const event = hub.fire(T0, "p1");
  assertEquals(event?.id, "p1");
  assertEquals(got, ["a:p1", "b:p1"]);
});

Deno.test("5.18-5.20 -- with nobody listening the prompt is dropped, logged and not kept", () => {
  const warnings: string[] = [];
  const hub = new PromptHub((reason) => warnings.push(reason));

  assertEquals(hub.fire(T0, "p1"), null);
  assertEquals(hub.droppedCount, 1);
  assertEquals(warnings.length, 1, "5.19/12.5");

  // 5.20 -- a frontend arriving afterwards hears nothing about it.
  const got: string[] = [];
  hub.add({ id: "late", deliver: (e) => got.push(e.id) });
  assertEquals(got, [], "no replay");
});

Deno.test("a listener that throws is dropped without silencing the others", () => {
  const hub = new PromptHub();
  const got: string[] = [];
  hub.add({
    id: "broken",
    deliver: () => {
      throw new Error("socket closed");
    },
  });
  hub.add({ id: "fine", deliver: (e) => got.push(e.id) });

  const event = hub.fire(T0, "p1");
  assertEquals(event?.id, "p1", "the event still counts as delivered");
  assertEquals(got, ["p1"]);
  assertEquals(hub.listenerCount, 1, "the broken one is gone");
});

Deno.test("removing a listener stops delivery, by handle or by id", () => {
  const hub = new PromptHub();
  const got: string[] = [];
  const off = hub.add({ id: "a", deliver: (e) => got.push(e.id) });
  hub.add({ id: "b", deliver: (e) => got.push(e.id) });

  off();
  hub.remove("b");
  assertEquals(hub.listenerCount, 0);
  assertEquals(hub.fire(T0, "p1"), null, "and now there is nobody to deliver to");
  assertEquals(got, []);
});
