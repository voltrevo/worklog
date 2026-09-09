/**
 * What the configuration lets out, and what it lets in.
 *
 * Both directions are "the code satisfies this by *not* doing something", which is the shape of
 * rule that no ordinary test touches: the read path holds because a field is deleted, and the
 * write path holds because a field is skipped. Neither has a line anybody would think to call.
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { open } from "./db.ts";
import { getConfig, type InvoiceConfig, publicInvoiceConfig, setConfig } from "./config.ts";

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
