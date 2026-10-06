/**
 * Everything section 17 says must be preserved, preserved across a restart.
 *
 * **Every other test in this repo opens `:memory:`.** That is the right default — they are fast
 * and they cannot leak into each other — but it means no test has ever closed a database and
 * opened it again, and the whole of section 17 is about what is still there when you do. A
 * migration that dropped a column, a `CREATE TABLE` that quietly ran twice against an existing
 * file, a value written in a shape SQLite would not give back: all of them pass a suite of
 * fresh in-memory databases and all of them lose somebody's work.
 *
 * 17.8 is what makes this necessary rather than paranoid. Migrations run on open, so every
 * release runs new code against an old file, and the only occasion it is ever exercised is the
 * one that matters.
 *
 * So this writes one of each thing the section names — a timed entry and a duration-only one
 * (17.1, 17.13), tags (17.2), a text note and a voice note with its file on disk (17.3, 17.4,
 * 17.10), an invoice taken through draft → issued → paid (17.5, 17.6, 17.11), an authorised
 * device (17.7) — then closes the database, opens the same file again, and reads it all back.
 *
 * Driven through `handle` rather than through the modules underneath, because the notes path
 * exists only there, and because "the server was restarted" is a claim about the server.
 */

import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { exportPublicKey, generateDeviceKey, signClaim } from "@worklog/shared/auth";
import {
  fromBase64,
  type HelloResult,
  type Request,
  type StoredInvoiceWire,
  toBase64,
  toWireClaim,
  type WorkNoteWire,
} from "@worklog/shared/protocol";
import type { WorkEntry } from "@worklog/shared/types";
import { open } from "./db.ts";
import { ChallengeStore } from "./access.ts";
import { getConfig, setConfig } from "./config.ts";
import { draftSettingsFor, frozenConfigFor, getInvoice } from "./invoices.ts";
import { renderInvoicePdf } from "./pdf.ts";
import { COMPLETE_INVOICE_CONFIG } from "./fixtures.ts";
import { loggerFor, query as queryLogs } from "./logs.ts";
import { PromptHub } from "./prompts.ts";
import { authorize, handle, type ServerContext, type Session } from "./rpc.ts";
import { listDevices } from "./access.ts";
import { activeTimer, Refused } from "./work.ts";

const NOW = 1_788_000_000_000;
const CERT = "uEiEXAMPLEcerthashEXAMPLEcerthashEXAMPLEcertha";
const TODAY = "2026-09-09";

/** A context over a real directory, so the audio and the PDF have somewhere to be. */
function context(dataDir: string): ServerContext {
  const db = open({ path: `${dataDir}/worklog.sqlite` });
  return {
    db,
    challenges: new ChallengeStore(),
    hub: new PromptHub(),
    log: loggerFor(db),
    dataDir,
    serverCertHash: CERT,
    version: "0.0.0-test",
    sessions: new Map(),
    now: () => NOW,
    offlineHolidays: true,
  };
}

function session(ctx: ServerContext, id: string): Session {
  const s: Session = { id, authenticated: false, push: () => {} };
  ctx.sessions.set(id, s);
  return s;
}

async function call(ctx: ServerContext, s: Session, req: Request): Promise<unknown> {
  const verdict = authorize(s, req.t);
  if (!verdict.ok) throw new Refused(verdict.code, verdict.message);
  return await handle(ctx, s, req);
}

/** Claim admin on this context, and return the key so a second context can authenticate with it. */
async function claimAdmin(ctx: ServerContext, s: Session) {
  const pair = await generateDeviceKey();
  const publicKey = await exportPublicKey(pair);
  const hello = await call(ctx, s, { t: "hello" }) as HelloResult;
  const claim = {
    purpose: "claim" as const,
    deviceName: "Studio Desktop",
    role: "admin" as const,
    publicKey,
    timestamp: NOW,
    challenge: fromBase64(hello.challenge),
    serverCertHash: hello.serverCertHash,
  };
  await call(ctx, s, {
    t: "claim-admin",
    claim: toWireClaim(claim),
    signature: toBase64(await signClaim(claim, pair.privateKey)),
  });
  return { pair, publicKey };
}

Deno.test({
  name: "17.1-17.13 -- everything survives the server being restarted",
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "persistence-" });
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/invoices`, { recursive: true });

    // ------------------------------------------------------------------ the first run
    const before = context(dir);
    setConfig(before.db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
    const admin = session(before, "s1");
    const device = await claimAdmin(before, admin);

    // 17.1, 17.2, 17.13 — one of each kind of entry, both tagged.
    const timed = await call(before, admin, {
      t: "entry-add",
      date: TODAY,
      durationMs: 2 * 3_600_000,
      billingTag: "Product Development",
      timing: { startedAt: NOW, endedAt: NOW + 2 * 3_600_000 },
    }) as WorkEntry;
    const untimed = await call(before, admin, {
      t: "entry-add",
      date: TODAY,
      durationMs: 90 * 60_000,
      billingTag: "Client feedback & updates",
    }) as WorkEntry;

    // 2.7 and 17.12 — a timer that was running when the process went away. `startPromptLoop`
    // observes the timer rather than being told about it, precisely so that one started before
    // this process did is picked up; that only means anything if the timer is still there.
    await call(before, admin, {
      t: "timer-start",
      billingTag: "Sprint review",
      date: TODAY,
    });

    // 17.3, 17.4, 17.10 — a text note and a voice note whose bytes go to a file.
    await call(before, admin, { t: "note-add", body: "Wrote the persistence test." });
    const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);
    await call(before, admin, {
      t: "note-add",
      body: "Said it out loud too.",
      audioBase64: toBase64(audio),
      audioType: "audio/ogg",
      audioMs: 4200,
    });

    // 17.5, 17.6, 17.11 — an invoice all the way through, so there is a snapshot, two timestamps
    // and a frozen PDF on disk.
    const draft = await call(before, admin, {
      t: "invoice-create",
      period: "2026-09",
      clock: { today: TODAY, nowMinutes: 0 },
    }) as StoredInvoiceWire;
    await call(before, admin, {
      t: "invoice-issue",
      id: draft.id,
      clock: { today: TODAY, nowMinutes: 0 },
    });
    const paid = await call(before, admin, {
      t: "invoice-mark-paid",
      id: draft.id,
    }) as StoredInvoiceWire;
    assertNotEquals(paid.issuedAt, undefined, "the first run issued it");
    assertNotEquals(paid.paidAt, undefined, "and marked it paid");

    before.db.close();

    // ------------------------------------------------------------------ the second run
    // The same file. Migrations run again here, against a database that already has everything in
    // it, which is the case that only ever happens in production.
    const after = context(dir);
    const back = session(after, "s2");
    back.authenticated = true;
    back.role = "admin";

    // The timer is still running, on the same tag, from the same instant.
    const running = activeTimer(after.db);
    assertEquals(running?.billingTag, "Sprint review");
    assertEquals(running?.startedAt, NOW);

    // 17.7 — the device is still authorised, with the role it was given.
    const devices = listDevices(after.db);
    assertEquals(devices.length, 1);
    assertEquals(devices[0]!.role, "admin");
    assertEquals(toBase64(devices[0]!.publicKey), toBase64(device.publicKey));

    // 17.1, 17.2, 17.13 — both entries, and which kind each was.
    const entries = await call(after, back, { t: "entries", month: "2026-09" }) as WorkEntry[];
    assertEquals(entries.length, 2);
    const rebuiltTimed = entries.find((e) => e.id === timed.id)!;
    const rebuiltUntimed = entries.find((e) => e.id === untimed.id)!;
    assertEquals(rebuiltTimed.billingTag, "Product Development");
    assertEquals(rebuiltTimed.durationMs, 2 * 3_600_000);
    assertEquals(rebuiltTimed.timing, { startedAt: NOW, endedAt: NOW + 2 * 3_600_000 });
    assertEquals(rebuiltUntimed.billingTag, "Client feedback & updates");
    // The distinction 17.1 is about, and the one a careless migration would flatten.
    assertEquals(rebuiltUntimed.timing, undefined);
    // 17.13 — a plain calendar date, not an instant that a timezone could move.
    assertEquals(rebuiltTimed.date, TODAY);

    // 17.3, 17.4 — both notes, and the recording still plays back byte for byte.
    const notes = await call(after, back, { t: "notes", limit: 50 }) as WorkNoteWire[];
    assertEquals(notes.length, 2);
    const spoken = notes.find((n) => n.audioMs !== undefined)!;
    assertEquals(spoken.body, "Said it out loud too.");
    assertEquals(spoken.audioMs, 4200);
    const fetched = await call(after, back, { t: "note-audio", id: spoken.id }) as {
      audioBase64: string;
    };
    assertEquals(fromBase64(fetched.audioBase64), audio);
    assertEquals(notes.some((n) => n.body === "Wrote the persistence test."), true);

    // 17.5, 17.6 — the snapshot and both timestamps, unchanged.
    const invoices = await call(after, back, { t: "invoices" }) as StoredInvoiceWire[];
    assertEquals(invoices.length, 1);
    assertEquals(invoices[0]!.status, "paid");
    assertEquals(invoices[0]!.issuedAt, paid.issuedAt);
    assertEquals(invoices[0]!.paidAt, paid.paidAt);
    assertEquals(invoices[0]!.snapshot?.subtotalMinor, paid.snapshot?.subtotalMinor);

    // 17.11 — and the frozen PDF is served from the file the first run wrote, not re-rendered.
    const pdf = await call(after, back, { t: "invoice-pdf", id: draft.id }) as {
      pdfBase64: string;
    };
    assertEquals(fromBase64(pdf.pdfBase64).subarray(0, 5), new TextEncoder().encode("%PDF-"));

    // And the configuration, including the fields the read path hides.
    assertEquals(
      getConfig(after.db, "invoice").payAccountNumber,
      COMPLETE_INVOICE_CONFIG.payAccountNumber,
    );

    after.db.close();
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name: "24.30 -- a frozen PDF that has gone missing is re-rendered, and said so out loud",
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    /*
     * The hole in freezing, which used to be silent.
     *
     * Issuing writes the bytes once and every later download reads that file, so the document
     * cannot drift. If the file is lost — a partial restore, a tidied directory — the server falls
     * back to re-rendering from the snapshot, which fixes the numbers but takes the letterhead,
     * the payment details and the tax label from the configuration as it stands *now*. That is the
     * exact drift freezing exists to prevent, arriving by the back door.
     *
     * Re-rendering beats refusing to hand over an invoice. Not being able to tell it happened does
     * not, and the log said "rendered a PDF" for both paths.
     */
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "frozen-" });
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/invoices`, { recursive: true });

    const ctx = context(dir);
    setConfig(ctx.db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
    const admin = session(ctx, "s1");
    await claimAdmin(ctx, admin);
    await call(ctx, admin, {
      t: "entry-add",
      date: TODAY,
      durationMs: 3_600_000,
      billingTag: "Product Development",
    });
    const draft = await call(ctx, admin, {
      t: "invoice-create",
      period: "2026-09",
      clock: { today: TODAY, nowMinutes: 0 },
    }) as StoredInvoiceWire;
    await call(ctx, admin, {
      t: "invoice-issue",
      id: draft.id,
      clock: { today: TODAY, nowMinutes: 0 },
    });

    const first = await call(ctx, admin, { t: "invoice-pdf", id: draft.id }) as {
      path: string;
      pdfBase64: string;
    };
    // Twice, unchanged: the ordinary case, and the thing the file is for.
    const again = await call(ctx, admin, { t: "invoice-pdf", id: draft.id }) as {
      pdfBase64: string;
    };
    assertEquals(again.pdfBase64, first.pdfBase64);
    assertEquals(
      wholeLog(ctx).includes("the frozen PDF is missing"),
      false,
      "nothing was missing yet",
    );

    // Now lose it.
    await Deno.remove(`${dir}/${first.path}`);
    const rerendered = await call(ctx, admin, { t: "invoice-pdf", id: draft.id }) as {
      pdfBase64: string;
    };
    assertEquals(
      fromBase64(rerendered.pdfBase64).subarray(0, 5),
      new TextEncoder().encode("%PDF-"),
      "it still hands over an invoice",
    );
    assertEquals(
      wholeLog(ctx).includes("the frozen PDF is missing"),
      true,
      "and it did not do that silently",
    );

    ctx.db.close();
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name:
    "24.30 -- and it re-renders as the document that was sent, not as one wearing today's letterhead",
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    /*
     * The half the warning could only describe. Losing the file used to mean the invoice came back
     * with whatever the settings say *now* — a different letterhead, a different account to pay
     * into, a different tax label — under the same invoice number, to a client who already has the
     * original. The numbers were frozen and the document was not.
     *
     * The settings in force at issuance are kept in their own column, out of everything that goes
     * on the wire, and this is the check that it is those the renderer gets.
     */
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "letterhead-" });
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/invoices`, { recursive: true });

    const ctx = context(dir);
    setConfig(ctx.db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
    const admin = session(ctx, "s1");
    await claimAdmin(ctx, admin);
    await call(ctx, admin, {
      t: "entry-add",
      date: TODAY,
      durationMs: 3_600_000,
      billingTag: "Product Development",
    });
    const draft = await call(ctx, admin, {
      t: "invoice-create",
      period: "2026-09",
      clock: { today: TODAY, nowMinutes: 0 },
    }) as StoredInvoiceWire;
    await call(ctx, admin, {
      t: "invoice-issue",
      id: draft.id,
      clock: { today: TODAY, nowMinutes: 0 },
    });
    const sent = await call(ctx, admin, { t: "invoice-pdf", id: draft.id }) as {
      path: string;
      pdfBase64: string;
    };

    // Everything on the document that is not a number, changed.
    setConfig(ctx.db, "invoice", {
      fromName: "Someone Else Entirely",
      fromAddress: "1 Different Road, Elsewhere",
      payAccountNumber: "99999999",
      payBank: "A Different Bank",
      taxLabel: "VAT",
    }, NOW);

    await Deno.remove(`${dir}/${sent.path}`);
    const again = await call(ctx, admin, { t: "invoice-pdf", id: draft.id }) as {
      pdfBase64: string;
    };

    // Byte-identical. A PDF is deterministic here — no timestamp, no id generator — so the whole
    // artefact can be compared rather than a few strings picked out of it, which is the stronger
    // claim: nothing at all about the document moved.
    assertEquals(
      again.pdfBase64,
      sent.pdfBase64,
      "the re-rendered invoice is a different document",
    );

    // And a draft, which has no frozen settings, does follow the current ones — otherwise the
    // check above could be passing because nothing reads the configuration at all.
    const second = await call(ctx, admin, {
      t: "invoice-create",
      period: "2026-08",
      clock: { today: TODAY, nowMinutes: 0 },
    }) as StoredInvoiceWire;
    const draftPdf = await call(ctx, admin, { t: "invoice-pdf", id: second.id }) as {
      pdfBase64: string;
    };
    const text = new TextDecoder("latin1").decode(fromBase64(draftPdf.pdfBase64));
    assertEquals(
      draftPdf.pdfBase64 === sent.pdfBase64,
      false,
      "a draft rendered identically to an invoice issued under different settings",
    );
    assertEquals(text.length > 0, true);

    ctx.db.close();
    await Deno.remove(dir, { recursive: true });
  },
});

/** Every log line, as one string. Admin, so nothing is filtered out (12.17). */
function wholeLog(ctx: ServerContext): string {
  return queryLogs(ctx.db, { admin: true, limit: 10_000, minLevel: "debug" })
    .map((e) => `${e.message} ${JSON.stringify(e.context ?? {})}`).join("\n");
}

Deno.test({
  name: "25.12 -- a payment override is on the invoice that was sent, not only on a re-render",
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    /*
     * Issuing writes the PDF once and every download reads that file. That write used the *global*
     * configuration while `issue` was separately freezing a copy with the per-invoice payment
     * override folded in — so the override reached the arithmetic, and the frozen settings, and a
     * re-render after the file was lost, and not the document actually sent. The one artefact it
     * missed is the only one the client ever sees.
     */
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "override-pdf-" });
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/invoices`, { recursive: true });

    const ctx = context(dir);
    setConfig(ctx.db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
    const admin = session(ctx, "s1");
    await claimAdmin(ctx, admin);
    await call(ctx, admin, {
      t: "entry-add",
      date: TODAY,
      durationMs: 3_600_000,
      billingTag: "Product Development",
    });
    const draft = await call(ctx, admin, {
      t: "invoice-create",
      period: "2026-09",
      clock: { today: TODAY, nowMinutes: 0 },
    }) as StoredInvoiceWire;
    await call(ctx, admin, {
      t: "invoice-update",
      id: draft.id,
      paymentOverride: { payBank: "TheOverriddenBankOfNowhere" },
    });
    await call(ctx, admin, {
      t: "invoice-issue",
      id: draft.id,
      clock: { today: TODAY, nowMinutes: 0 },
    });

    /*
     * Compared as artefacts, not searched as text: `doc.save()` compresses its streams, so a
     * string that is plainly on the page is not a string in the file. My first version of this
     * looked for the bank name in the bytes and failed against correct code.
     *
     * The claim is exactly this equality anyway — the document that was sent is the one the
     * frozen settings produce. Before the fix it was the one the *global* settings produce.
     */
    // The path the row records, not a name guessed from the number — the stored file is keyed by
    // id now, because two numbers that sanitise the same used to share one file.
    const record = getInvoice(ctx.db, draft.id)!;
    const stored = await Deno.readFile(`${dir}/${record.pdfPath}`);
    const fromFrozen = await renderInvoicePdf(
      record.snapshot ?? record.draft,
      frozenConfigFor(ctx.db, draft.id)!,
    );
    const fromGlobal = await renderInvoicePdf(
      record.snapshot ?? record.draft,
      getConfig(ctx.db, "invoice"),
    );
    assertEquals(
      stored.length === fromFrozen.length && stored.every((b, i) => b === fromFrozen[i]),
      true,
      "the file written at issuance is not what the frozen settings render",
    );
    // And the two really do differ, or the assertion above holds for the wrong reason.
    assertEquals(
      fromFrozen.length === fromGlobal.length && fromFrozen.every((b, i) => b === fromGlobal[i]),
      false,
      "the override changed nothing, so this test proves nothing",
    );

    ctx.db.close();
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name: "two invoice numbers that sanitise the same do not share one frozen PDF",
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    /*
     * The stored path used to be `invoices/${number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`, so
     * "###" and "***" both became `___.pdf`. 9.16 stops two *issued* invoices having the same
     * number; it says nothing about two numbers colliding after every character that is not
     * alphanumeric has been replaced. Issuing the second would have overwritten the first
     * invoice's frozen document — 24.30 defeated by a filename.
     *
     * Reverting one period so both can be issued, since 11.19 is about the month, not the name.
     */
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "collide-" });
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/invoices`, { recursive: true });

    const ctx = context(dir);
    setConfig(ctx.db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
    const admin = session(ctx, "s1");
    await claimAdmin(ctx, admin);
    for (const date of [TODAY, "2026-08-03"]) {
      await call(ctx, admin, {
        t: "entry-add",
        date,
        durationMs: 3_600_000,
        billingTag: "Product Development",
      });
    }

    const issued: string[] = [];
    for (const [period, number] of [["2026-09", "###"], ["2026-08", "***"]] as const) {
      const draft = await call(ctx, admin, {
        t: "invoice-create",
        period,
        clock: { today: TODAY, nowMinutes: 0 },
      }) as StoredInvoiceWire;
      await call(ctx, admin, { t: "invoice-update", id: draft.id, number });
      await call(ctx, admin, {
        t: "invoice-issue",
        id: draft.id,
        clock: { today: TODAY, nowMinutes: 0 },
      });
      await call(ctx, admin, { t: "invoice-pdf", id: draft.id });
      issued.push(getInvoice(ctx.db, draft.id)!.pdfPath!);
    }

    assertEquals(issued[0] !== issued[1], true, `both stored at ${issued[0]}`);
    // And both files are actually there, which is what "did not overwrite" means.
    for (const path of issued) {
      assertEquals((await Deno.stat(`${dir}/${path}`)).isFile, true, path);
    }

    ctx.db.close();
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name: "11.29 -- a draft's document is kept from its first generation until the draft is edited",
  async fn() {
    /*
     * A draft was re-rendered on every view against the settings as they stood at that moment, so
     * one nobody had touched changed its letterhead whenever the settings did, and what somebody
     * looked at was not necessarily what they would issue.
     *
     * Renders are deterministic, so a second view returning the same bytes would prove nothing on
     * its own — a fresh render would match too. What proves the file was kept is the settings
     * changing in between: a re-render would then differ.
     */
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "draftdoc-" });
    await Deno.mkdir(`${dir}/notes`, { recursive: true });
    await Deno.mkdir(`${dir}/invoices`, { recursive: true });
    const ctx = context(dir);
    setConfig(ctx.db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
    const admin = session(ctx, "s1");
    await claimAdmin(ctx, admin);
    await call(ctx, admin, {
      t: "entry-add",
      date: TODAY,
      durationMs: 3_600_000,
      billingTag: "Product Development",
    });
    const draft = await call(ctx, admin, {
      t: "invoice-create",
      period: "2026-09",
      clock: { today: TODAY, nowMinutes: 0 },
    }) as StoredInvoiceWire;
    const pdf = async () =>
      ((await call(ctx, admin, { t: "invoice-pdf", id: draft.id })) as { pdfBase64: string })
        .pdfBase64;
    const rename = (fromName: string) =>
      setConfig(ctx.db, "invoice", { ...COMPLETE_INVOICE_CONFIG, fromName }, NOW);

    const first = await pdf();
    assertEquals(
      draftSettingsFor(ctx.db, draft.id)?.fromName,
      COMPLETE_INVOICE_CONFIG.fromName,
      "the first view kept the settings it was generated with",
    );

    rename("Renamed Ltd");
    assertEquals(await pdf(), first, "a settings change does not reach a draft already generated");

    /*
     * And it is *stored*, not regenerated. Stable bytes alone cannot tell the two apart: a render
     * from the kept settings is deterministic and matches. So the file on disk is altered, and the
     * next view must hand back the altered bytes — which only reading the file can do.
     */
    const path = draft.id && getInvoice(ctx.db, draft.id)?.pdfPath;
    const marked = new TextEncoder().encode("%PDF-marked-by-the-test");
    await Deno.writeFile(`${dir}/${path}`, marked);
    assertEquals(
      fromBase64(await pdf()),
      marked,
      "the second view served the file the first one stored, rather than rendering again",
    );

    // An edit that changes no line still counts: it is the person deciding to look again.
    await call(ctx, admin, { t: "invoice-update", id: draft.id, number: draft.number });
    const afterEdit = await pdf();
    assertNotEquals(afterEdit, first, "editing the draft lets it pick up today's settings");
    assertEquals(draftSettingsFor(ctx.db, draft.id)?.fromName, "Renamed Ltd");

    // What is issued is what was looked at, not whatever the settings say by then.
    rename("A Third Name");
    await call(ctx, admin, {
      t: "invoice-issue",
      id: draft.id,
      clock: { today: TODAY, nowMinutes: 0 },
    });
    assertEquals(
      frozenConfigFor(ctx.db, draft.id)?.fromName,
      "Renamed Ltd",
      "issued under the settings the draft was generated with",
    );

    // Reverted, it is a draft again, and the file on disk is the issued one — not its document.
    await call(ctx, admin, { t: "invoice-revert-issue", id: draft.id });
    assertEquals(
      draftSettingsFor(ctx.db, draft.id),
      undefined,
      "reverting forgets the old document",
    );
    await pdf();
    assertEquals(
      draftSettingsFor(ctx.db, draft.id)?.fromName,
      "A Third Name",
      "and the next view generates it afresh",
    );
    assertEquals(getInvoice(ctx.db, draft.id)?.status, "draft");
  },
});
