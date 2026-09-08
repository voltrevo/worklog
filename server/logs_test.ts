import { assertEquals } from "jsr:@std/assert@^1";
import { type Db, open } from "./db.ts";
import { append, loggerFor, prune, query, scrubForReader, scrubForStorage } from "./logs.ts";

const T0 = 1_788_000_000_000;
const DAY = 86_400_000;

function fresh(): Db {
  return open({ path: ":memory:" });
}

Deno.test("12.15 -- payment details never reach the table, whoever writes them", () => {
  const db = fresh();
  append(db, {
    level: "error",
    source: "invoice",
    message: "render failed",
    context: { config: { clientName: "Acme", paymentDetails: "BSB 000-000 Acct 12345678" } },
    now: T0,
  });
  const stored = db.prepare("SELECT context_json FROM log").get() as { context_json: string };
  assertEquals(stored.context_json.includes("12345678"), false);
  assertEquals(stored.context_json.includes("[redacted]"), true);
  assertEquals(stored.context_json.includes("Acme"), true, "the diagnostic value survives");
  db.close();
});

Deno.test("the deny-list matches a key containing the word, not only the word", () => {
  // `clientPaymentDetails` and `PRIVATEKEY` have to be caught as well, or the list protects only
  // the exact spelling someone happened to think of.
  const scrubbed = scrubForStorage({
    clientPaymentDetails: "x",
    PRIVATEKEY: "y",
    apiKeyForThing: "z",
    harmless: "kept",
  }) as Record<string, unknown>;
  assertEquals(scrubbed.clientPaymentDetails, "[redacted]");
  assertEquals(scrubbed.PRIVATEKEY, "[redacted]");
  assertEquals(scrubbed.apiKeyForThing, "[redacted]");
  assertEquals(scrubbed.harmless, "kept");
});

Deno.test("nesting does not smuggle a secret past the scrubber", () => {
  const scrubbed = scrubForStorage({
    outer: { inner: [{ paymentDetails: "BSB 000" }] },
  }) as { outer: { inner: Array<{ paymentDetails: string }> } };
  assertEquals(scrubbed.outer.inner[0]?.paymentDetails, "[redacted]");
});

Deno.test("a cycle does not hang the scrubber", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  const scrubbed = scrubForStorage(a) as Record<string, unknown>;
  assertEquals(scrubbed.name, "a");
});

Deno.test("12.11/12.17 -- an admin sees the stack, a write device does not", () => {
  const db = fresh();
  append(db, {
    level: "error",
    source: "client",
    message: "TypeError: cannot read property",
    context: { stack: "at foo (bundle.js:1:1)", route: "/invoices" },
    now: T0,
  });

  const asAdmin = query(db, { admin: true });
  assertEquals(asAdmin[0]?.context?.stack, "at foo (bundle.js:1:1)");

  const asWriter = query(db, { admin: false });
  assertEquals(asWriter[0]?.context?.stack, "[redacted]");
  assertEquals(asWriter[0]?.context?.route, "/invoices", "12.12's ordinary detail still shows");
  assertEquals(asWriter[0]?.message, "TypeError: cannot read property", "as does the message");
  db.close();
});

Deno.test("scrubForReader withholds more than scrubForStorage, and never less", () => {
  const context = { stack: "s", paymentDetails: "p", route: "/x" };
  const stored = scrubForStorage(context) as Record<string, string>;
  const read = scrubForReader(stored) as Record<string, string>;
  assertEquals(stored.paymentDetails, "[redacted]");
  assertEquals(stored.stack, "s", "an admin needs this");
  assertEquals(read.stack, "[redacted]");
  assertEquals(read.paymentDetails, "[redacted]");
  assertEquals(read.route, "/x");
});

Deno.test("12.12 -- filters on level, source and a half-open time range", () => {
  const db = fresh();
  const log = loggerFor(db);
  for (const [i, level] of (["debug", "info", "warn", "error"] as const).entries()) {
    append(db, { level, source: i % 2 ? "timer" : "invoice", message: level, now: T0 + i });
  }

  assertEquals(query(db, { admin: true }).length, 4);
  assertEquals(query(db, { admin: true, minLevel: "warn" }).map((e) => e.level), ["error", "warn"]);
  assertEquals(query(db, { admin: true, source: "timer" }).length, 2);
  assertEquals(query(db, { admin: true, from: T0 + 1, to: T0 + 3 }).length, 2, "half-open");

  log("info", "prompt", "fired");
  assertEquals(query(db, { admin: true, source: "prompt" }).length, 1);
  db.close();
});

Deno.test("the newest entries come first, and the limit takes them from that end", () => {
  const db = fresh();
  for (let i = 0; i < 10; i++) {
    append(db, { level: "info", source: "s", message: `m${i}`, now: T0 + i });
  }
  const page = query(db, { admin: true, limit: 3 });
  assertEquals(page.map((e) => e.message), ["m9", "m8", "m7"]);
  db.close();
});

Deno.test("12.7 -- a device's report is attributed, as a fingerprint rather than a key", () => {
  const db = fresh();
  append(db, {
    level: "warn",
    source: "client",
    message: "failed to reconnect",
    deviceKey: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6]),
    now: T0,
  });
  const entry = query(db, { admin: true })[0];
  assertEquals(entry?.deviceFingerprint, "de:ad:be:ef:01:02:03:04");
  db.close();
});

Deno.test("12.13 -- retention is bounded by age and by count, because either alone fails", () => {
  const db = fresh();
  // An age bound alone would keep everything a crash loop wrote in the last hour...
  for (let i = 0; i < 100; i++) {
    append(db, { level: "error", source: "loop", message: "again", now: T0 + i });
  }
  // ...and a count bound alone would keep a year of silence forever.
  append(db, { level: "info", source: "old", message: "ancient", now: T0 - 400 * DAY });

  const gone = prune(db, { keepDays: 30, keepRows: 10, now: T0 + 1000 });
  assertEquals(gone, 91, "the ancient one, and ninety of the hundred");
  const left = query(db, { admin: true, limit: 1000 });
  assertEquals(left.length, 10);
  assertEquals(left.some((e) => e.source === "old"), false);
  db.close();
});

Deno.test("unparseable context is reported as such rather than crashing the viewer", () => {
  const db = fresh();
  db.prepare("INSERT INTO log (at, level, source, message, context_json) VALUES (?,?,?,?,?)")
    .run(T0, "info", "s", "m", "{not json");
  assertEquals(query(db, { admin: true })[0]?.context, { unparseable: true });
  db.close();
});
