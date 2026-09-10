/**
 * What the configuration lets out, and what it lets in.
 *
 * Both directions are "the code satisfies this by *not* doing something", which is the shape of
 * rule that no ordinary test touches: the read path holds because a field is deleted, and the
 * write path holds because a field is skipped. Neither has a line anybody would think to call.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { Refused } from "./work.ts";
import { open } from "./db.ts";
import {
  getConfig,
  type InvoiceConfig,
  missingInvoiceConfig,
  publicInvoiceConfig,
  setConfig,
} from "./config.ts";

Deno.test("25.42 -- the address is hidden like the payment block, with a flag for each group", () => {
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", {
    fromName: "Wren Consulting",
    fromAddress: "12 Fictional Way, Nowhere",
    payName: "Wren & Co",
    payAccountNumber: "00000000",
  });

  const wire = publicInvoiceConfig(getConfig(db, "invoice"));
  // Not merely absent from the *type*: absent from the object, so nothing that serialises it can
  // carry the value by accident.
  assertEquals("fromAddress" in wire, false);
  assertEquals("payAccountNumber" in wire, false);
  assertEquals(wire.addressSet, true);
  assertEquals(wire.paymentDetailsSet, true);
  assertEquals(wire.fromName, "Wren Consulting");
  db.close();
});

Deno.test("the payment flag ignores the method, which is not an account", () => {
  const db = open({ path: ":memory:" });
  // "Wire Transfer" is not a detail anybody can be paid with. A block that reads as configured
  // because somebody typed the method is a block that prints an invoice with no account on it.
  setConfig(db, "invoice", { payMethod: "Wire Transfer" });
  assertEquals(publicInvoiceConfig(getConfig(db, "invoice")).paymentDetailsSet, false);
  assertEquals(publicInvoiceConfig(getConfig(db, "invoice")).addressSet, false);
  db.close();
});

Deno.test("setConfig keeps only the fields the section has", () => {
  const db = open({ path: ":memory:" });
  // The settings screen sends its whole draft back, and that draft contains the derived flags from
  // the read path. They were kept out by the frontend remembering to blank them, which stopped
  // being a plan the moment there were two of them.
  setConfig(db, "invoice", {
    fromName: "Wren Consulting",
    paymentDetailsSet: true,
    addressSet: true,
    somethingElse: 1,
  } as unknown as Partial<InvoiceConfig>);

  const stored = getConfig(db, "invoice") as unknown as Record<string, unknown>;
  assertEquals(stored.fromName, "Wren Consulting");
  assertEquals("paymentDetailsSet" in stored, false);
  assertEquals("addressSet" in stored, false);
  assertEquals("somethingElse" in stored, false);
  db.close();
});

Deno.test("25.3 -- a configuration value that cannot be meant is refused", () => {
  /*
   * Every one of these was accepted and stored, reachable from the settings screen with a
   * keyboard, with the frontend's own checks the only thing in the way.
   *
   * The money ones matter most. A negative rate produces a negative invoice. A tax rate of 12 is
   * a percentage typed into a fraction and would treble the total — and `updateDraft` already
   * refused exactly that for a *per-invoice* rate, which is what a rule written at the second
   * call site instead of the first looks like.
   */
  const db = open({ path: ":memory:" });
  const bad = (why: string, section: "pacing" | "prompt" | "invoice", value: object) =>
    assertThrows(() => setConfig(db, section, value as never), Refused, why);

  bad("rateMinor", "invoice", { rateMinor: -5000 });
  bad("taxRate", "invoice", { taxRate: 12 });
  bad("taxRate", "invoice", { taxRate: -0.1 });
  bad("bonusMinor", "invoice", { bonusMinor: -1 });
  bad("monthlyTargetHours", "pacing", { monthlyTargetHours: -50 });
  bad("monthlyTargetHours", "pacing", { monthlyTargetHours: 1e9 });
  bad("meanIntervalMs", "prompt", { meanIntervalMs: -1 });
  bad("meanIntervalMs", "prompt", { meanIntervalMs: 0 });
  // ...but a very short one is allowed: the journey seeds one so a prompt fires while it watches,
  // and refusing it was a plausibility judgement, not a coherence check.
  setConfig(db, "prompt", { meanIntervalMs: 800 });
  bad("ends before it starts", "pacing", { schedule: { mon: { start: "17:00", end: "09:00" } } });
  bad("two times as HH:MM", "pacing", { schedule: { mon: { start: "noon", end: "later" } } });
  bad("two times as HH:MM", "pacing", { schedule: { mon: { start: "25:00", end: "26:00" } } });

  // And the ordinary values still go in, or the above is just a wall.
  setConfig(db, "invoice", { rateMinor: 12_000, taxRate: 0.1 });
  setConfig(db, "pacing", {
    monthlyTargetHours: 160,
    schedule: { mon: { start: "09:00", end: "17:00" } } as never,
  });
  setConfig(db, "prompt", { meanIntervalMs: 45 * 60_000 });
  assertEquals(getConfig(db, "invoice").rateMinor, 12_000);
  assertEquals(getConfig(db, "pacing").monthlyTargetHours, 160);
  db.close();
});

Deno.test("27.30 -- there is no default prompt interval, and none can be invented", () => {
  const db = open({ path: ":memory:" });

  /*
   * A cadence nobody chose is not a cadence. This was `45 * 60_000`, and the settings box could
   * not tell you whether 45 was your answer or the code's — which is how a screen that had never
   * been used came to write 45 back over somebody's 60 (27.29).
   */
  assertEquals(getConfig(db, "prompt").meanIntervalMs, null);
  assertEquals(getConfig(db, "prompt").enabled, false);

  // And the state that removing it creates is refused rather than stored: prompts on, with no
  // interval, would poll `null` for ever and never fire while the switch said they were on.
  assertThrows(
    () => setConfig(db, "prompt", { enabled: true }),
    Refused,
    "interval",
  );
  assertEquals(getConfig(db, "prompt").enabled, false);

  // With one set, it goes on.
  setConfig(db, "prompt", { meanIntervalMs: 30 * 60_000 });
  setConfig(db, "prompt", { enabled: true });
  assertEquals(getConfig(db, "prompt").enabled, true);

  // And `null` is where an interval starts, not somewhere it can be put back to: the number check
  // refuses it like any other non-number, so "unset" is reachable only by never having set one.
  // Worth pinning, because it is what makes `enabled: true` the single way to reach the bad pair.
  assertThrows(
    () => setConfig(db, "prompt", { meanIntervalMs: null }),
    Refused,
    "meanIntervalMs must be a number",
  );
  assertEquals(getConfig(db, "prompt").meanIntervalMs, 30 * 60_000);

  db.close();
});

Deno.test("27.44 -- exactly these fields cross to a device, and no others", () => {
  /*
   * `publicInvoiceConfig` spreads everything that is not sensitive, and a spread is not checked
   * for excess properties against its return type. So a column added to `InvoiceConfig` is
   * published to every device by default, and the type says nothing about it — which is the
   * opposite of how the payment block is handled two functions up.
   *
   * The list is the check. Adding a field here is a decision; forgetting to is a red test.
   */
  const db = open({ path: ":memory:" });
  const wire = publicInvoiceConfig(getConfig(db, "invoice"));
  assertEquals(Object.keys(wire).sort(), [
    "addressSet",
    "approver",
    "bonusMinor",
    "bonusTeamProject",
    "clientAddress",
    "clientName",
    "currency",
    "fromAbn",
    "fromEmail",
    "fromName",
    "fromPhone",
    "note",
    "paymentDetailsComplete",
    "paymentDetailsSet",
    "rateMinor",
    "taxLabel",
    "taxRate",
    "teamProject",
  ]);
  db.close();
});

Deno.test("27.44 -- a part-filled payment block is not a complete one", () => {
  /*
   * `paymentDetailsSet` is `.some(...)`, for masking: is there anything here to hide. The invoices
   * screen asked it a different question — may an invoice be made — so typing only an account name
   * made that screen report nothing missing, and then rendering refused for the BSB, the account
   * number and the bank.
   */
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", { payName: "Wren & Co" });

  const partial = publicInvoiceConfig(getConfig(db, "invoice"));
  assertEquals(partial.paymentDetailsSet, true, "there is something to mask");
  assertEquals(partial.paymentDetailsComplete, false, "and it is not a usable payment block");

  setConfig(db, "invoice", {
    payMethod: "Wire Transfer",
    payBsb: "000-000",
    payAccountNumber: "00000000",
    payBank: "Example Bank",
  });
  const full = publicInvoiceConfig(getConfig(db, "invoice"));
  assertEquals(full.paymentDetailsComplete, true);

  // And the two agree with the authority, which is the whole point of deriving one from it.
  const stillMissing = missingInvoiceConfig(getConfig(db, "invoice"))
    .filter((w) => /payment|account|BSB|bank/i.test(w));
  assertEquals(stillMissing, []);
  db.close();
});
