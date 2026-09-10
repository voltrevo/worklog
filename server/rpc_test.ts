import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { exportPublicKey, generateDeviceKey, signClaim } from "@worklog/shared/auth";
import {
  type Event,
  fromBase64,
  type HelloResult,
  type Request,
  REQUIRED_ROLE,
  type SnapshotResult,
  toBase64,
  toWireClaim,
} from "@worklog/shared/protocol";
import type { AccessRole, AuthPurpose } from "@worklog/shared/auth";
import { monthOf } from "@worklog/shared/dates";
import { open } from "./db.ts";
import { ChallengeStore } from "./access.ts";
import { setConfig } from "./config.ts";
import { COMPLETE_INVOICE_CONFIG } from "./fixtures.ts";
import { loggerFor } from "./logs.ts";
import { PromptHub } from "./prompts.ts";
import { authorize, handle, OPEN, type ServerContext, type Session } from "./rpc.ts";
import { Refused } from "./work.ts";

const NOW = 1_788_000_000_000; // 2026-08-25T...
const CERT = "uEiEXAMPLEcerthashEXAMPLEcerthashEXAMPLEcertha";
const CLOCK = { today: "2026-09-08", nowMinutes: 10 * 60 };

function context(): ServerContext {
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", COMPLETE_INVOICE_CONFIG, NOW);
  return {
    db,
    challenges: new ChallengeStore(),
    hub: new PromptHub(),
    log: loggerFor(db),
    serverCertHash: CERT,
    version: "0.0.0-test",
    sessions: new Map(),
    now: () => NOW,
    // 6.34 -- the shipped snapshot, so no test reaches the network.
    offlineHolidays: true,
  };
}

function session(ctx: ServerContext, id: string): Session & { events: Event[] } {
  const events: Event[] = [];
  const s: Session & { events: Event[] } = {
    id,
    authenticated: false,
    events,
    push: (e) => events.push(e),
  };
  ctx.sessions.set(id, s);
  return s;
}

/** What `main.ts` will do per stream: check the role, then dispatch. */
async function call(ctx: ServerContext, s: Session, req: Request): Promise<unknown> {
  const verdict = authorize(s, req.t);
  if (!verdict.ok) throw new Refused(verdict.code, verdict.message);
  return await handle(ctx, s, req);
}

async function device() {
  const pair = await generateDeviceKey();
  return { pair, publicKey: await exportPublicKey(pair) };
}

/** hello, then a signed request of the given purpose, exactly as a frontend would. */
async function signedCall(
  ctx: ServerContext,
  s: Session,
  dev: { pair: CryptoKeyPair; publicKey: Uint8Array },
  purpose: AuthPurpose,
  opts: { deviceName?: string; role?: AccessRole } = {},
): Promise<unknown> {
  const hello = await call(ctx, s, { t: "hello" }) as HelloResult;
  const claim = {
    purpose,
    deviceName: opts.deviceName ?? "MacBook Pro",
    role: opts.role ?? "write" as AccessRole,
    publicKey: dev.publicKey,
    timestamp: NOW,
    challenge: fromBase64(hello.challenge),
    serverCertHash: hello.serverCertHash,
  };
  const signature = toBase64(await signClaim(claim, dev.pair.privateKey));
  const t = purpose === "claim"
    ? "claim-admin" as const
    : purpose === "request"
    ? "request-access" as const
    : "authenticate" as const;
  return await call(ctx, s, { t, claim: toWireClaim(claim), signature });
}

Deno.test("hello offers a claim on an empty server and a request once one is taken", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const alice = await device();
  const bob = await device();

  assertEquals(((await call(ctx, a, { t: "hello" })) as HelloResult).offer, "claim");
  await signedCall(ctx, a, alice, "claim");

  const b = session(ctx, "b");
  // The offer is per device, so it only changes once the server has seen this one's key.
  await signedCall(ctx, b, bob, "request");
  assertEquals(((await call(ctx, b, { t: "hello" })) as HelloResult).offer, "request");
  assertEquals(((await call(ctx, a, { t: "hello" })) as HelloResult).offer, "auth");
  ctx.db.close();
});

Deno.test("an unauthenticated device is refused everything except the four that let it in", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await assertRejects(
    () => call(ctx, a, { t: "snapshot", month: "2026-09", clock: CLOCK }),
    Refused,
    "has not authenticated",
  );
  await assertRejects(() => call(ctx, a, { t: "logs" }), Refused, "has not authenticated");
  // 12.16 -- an unauthorized device cannot fill the log either.
  await assertRejects(
    () => call(ctx, a, { t: "client-error", message: "x" }),
    Refused,
    "has not authenticated",
  );
  ctx.db.close();
});

Deno.test("claiming admin authenticates the connection it was claimed on", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await signedCall(ctx, a, await device(), "claim");
  assertEquals(a.authenticated, true);
  assertEquals(a.role, "admin");
  const snap = await call(ctx, a, {
    t: "snapshot",
    month: "2026-09",
    clock: CLOCK,
  }) as SnapshotResult;
  assertEquals(snap.month, "2026-09");
  ctx.db.close();
});

Deno.test("13.39 -- a second device's claim is refused, and it can still ask", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const b = session(ctx, "b");
  await signedCall(ctx, a, await device(), "claim");

  const bob = await device();
  await assertRejects(() => signedCall(ctx, b, bob, "claim"), Refused, "already has an authorized");
  assertEquals(b.authenticated, false);
  // 13.40 -- and the fallback works on the same connection.
  const outcome = await signedCall(ctx, b, bob, "request", { deviceName: "Windows Laptop" });
  assertEquals((outcome as { outcome: string }).outcome, "request-recorded");
  ctx.db.close();
});

Deno.test("the device that claims admin has been seen, because claiming is being seen", async () => {
  // It read "last seen never" for the admin's own row until it happened to reconnect -- which is
  // the one line on that screen whose reader can personally disprove it. `authenticate` had always
  // recorded it and `claim-admin` had not, so it was wrong exactly on a fresh server.
  const ctx = context();
  const a = session(ctx, "a");
  const dev = await device();
  await signedCall(ctx, a, dev, "claim");

  const devices = await call(ctx, a, { t: "access-devices" }) as { lastSeenAt?: number }[];
  assertEquals(devices.length, 1);
  assertEquals(typeof devices[0]!.lastSeenAt, "number");
  ctx.db.close();
});

Deno.test("13.28/13.32-13.34 -- an approved read device reads and cannot write", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const b = session(ctx, "b");
  await signedCall(ctx, a, await device(), "claim");

  const bob = await device();
  await signedCall(ctx, b, bob, "request", { deviceName: "iPad", role: "admin" });
  const pending = await call(ctx, a, { t: "access-pending" }) as Array<{ publicKey: string }>;
  assertEquals(pending.length, 1);
  await call(ctx, a, { t: "access-approve", publicKey: pending[0]!.publicKey, role: "read" });

  await signedCall(ctx, b, bob, "auth");
  assertEquals(b.role, "read");
  await call(ctx, b, { t: "snapshot", month: "2026-09", clock: CLOCK });
  await assertRejects(
    () => call(ctx, b, { t: "timer-start", billingTag: "Admin", date: "2026-09-08" }),
    Refused,
    "needs write access",
  );
  await assertRejects(() => call(ctx, b, { t: "access-devices" }), Refused, "needs admin access");
  ctx.db.close();
});

Deno.test("an authorized device that has not authenticated on this connection gets nothing", async () => {
  // 13.30 -- possession is proved per connection, so knowing the key is not enough.
  const ctx = context();
  const a = session(ctx, "a");
  const alice = await device();
  await signedCall(ctx, a, alice, "claim");

  const second = session(ctx, "a2");
  second.publicKey = alice.publicKey; // as if the transport knew who it was
  await assertRejects(
    () => call(ctx, second, { t: "snapshot", month: "2026-09", clock: CLOCK }),
    Refused,
    "has not authenticated",
  );
  ctx.db.close();
});

Deno.test("1.12 -- a change on one connection reaches the others", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const b = session(ctx, "b");
  await signedCall(ctx, a, await device(), "claim");

  const bob = await device();
  await signedCall(ctx, b, bob, "request");
  const pending = await call(ctx, a, { t: "access-pending" }) as Array<{ publicKey: string }>;
  await call(ctx, a, { t: "access-approve", publicKey: pending[0]!.publicKey, role: "write" });
  await signedCall(ctx, b, bob, "auth");

  a.events.length = 0;
  b.events.length = 0;
  await call(ctx, b, { t: "timer-start", billingTag: "Product Development", date: "2026-09-08" });

  assertEquals(a.events.some((e) => e.e === "timer" && e.timer.active !== undefined), true);
  assertEquals(b.events.some((e) => e.e === "timer"), true, "including the one that did it");

  await call(ctx, b, { t: "timer-stop" });
  assertEquals(a.events.some((e) => e.e === "changed" && e.area === "entries"), true);
  ctx.db.close();
});

Deno.test("13.36 -- revoking a device cuts its live session, not just its next connection", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const b = session(ctx, "b");
  await signedCall(ctx, a, await device(), "claim");
  const bob = await device();
  await signedCall(ctx, b, bob, "request");
  const pending = await call(ctx, a, { t: "access-pending" }) as Array<{ publicKey: string }>;
  await call(ctx, a, { t: "access-approve", publicKey: pending[0]!.publicKey, role: "write" });
  await signedCall(ctx, b, bob, "auth");
  assertEquals(b.authenticated, true);

  await call(ctx, a, { t: "access-revoke", publicKey: toBase64(bob.publicKey) });
  assertEquals(b.authenticated, false);
  assertEquals(b.events.some((e) => e.e === "access-revoked"), true);
  await assertRejects(
    () => call(ctx, b, { t: "snapshot", month: "2026-09", clock: CLOCK }),
    Refused,
  );
  ctx.db.close();
});

Deno.test("13.37 -- a role change reaches a connected device without a reconnect", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const b = session(ctx, "b");
  await signedCall(ctx, a, await device(), "claim");
  const bob = await device();
  await signedCall(ctx, b, bob, "request");
  const pending = await call(ctx, a, { t: "access-pending" }) as Array<{ publicKey: string }>;
  await call(ctx, a, { t: "access-approve", publicKey: pending[0]!.publicKey, role: "read" });
  await signedCall(ctx, b, bob, "auth");

  await assertRejects(() =>
    call(ctx, b, { t: "timer-start", billingTag: "x", date: "2026-09-08" })
  );
  await call(ctx, a, { t: "access-set-role", publicKey: toBase64(bob.publicKey), role: "write" });
  assertEquals(b.role, "write");
  await call(ctx, b, { t: "timer-start", billingTag: "x", date: "2026-09-08" });
  ctx.db.close();
});

Deno.test("20.3 -- payment details never come back on a read", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await signedCall(ctx, a, await device(), "claim");
  await call(ctx, a, {
    t: "config-set",
    section: "invoice",
    value: { payBank: "Bank of Nowhere", payAccountNumber: "00000000" },
  });

  const cfg = await call(ctx, a, { t: "config-get" }) as {
    invoice: Record<string, unknown>;
  };
  assertEquals("paymentDetails" in cfg.invoice, false);
  assertEquals(cfg.invoice.paymentDetailsSet, true, "but the UI can tell it is set");
  assertEquals(JSON.stringify(cfg).includes("00000000"), false);
  ctx.db.close();
});

Deno.test("the snapshot carries the whole home screen, from the shipped holiday data", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await signedCall(ctx, a, await device(), "claim");
  await call(ctx, a, {
    t: "entry-add",
    date: "2026-09-08",
    durationMs: 2 * 3_600_000,
    billingTag: "Product Development",
  });

  const snap = await call(ctx, a, {
    t: "snapshot",
    month: "2026-09",
    clock: CLOCK,
  }) as SnapshotResult;
  assertEquals(snap.today.length, 1);
  assertEquals(snap.entries.length, 1);
  assertEquals(snap.recentTags, ["Product Development"]);
  assertEquals(snap.pacing.actualToday, 2);
  assertEquals(snap.timer.active, undefined);
  // September 2026 has no NSW public holiday. `pacing.holidays` is the month's, not the year's --
  // reading a year-wide list here is what this test caught the first time it ran.
  assertEquals(snap.pacing.holidays.length, 0);
  assertEquals(typeof snap.holidayWarning, "string", "6.36 -- it is not live data, and it says so");
  ctx.db.close();
});

Deno.test("2.16 -- a timer running for a day and a half is flagged, not touched", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await signedCall(ctx, a, await device(), "claim");
  await call(ctx, a, { t: "timer-start", billingTag: "Admin", date: "2026-09-08" });

  const later: ServerContext = { ...ctx, now: () => NOW + 36 * 3_600_000 };
  const snap = await handle(later, a, {
    t: "snapshot",
    month: "2026-09",
    clock: CLOCK,
  }) as SnapshotResult;
  assertEquals(snap.timer.implausible, true);
  assertEquals(snap.timer.active?.startedAt, NOW, "2.17 -- and it has not been corrected");
  ctx.db.close();
});

Deno.test("the whole invoice lifecycle over the protocol", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await signedCall(ctx, a, await device(), "claim");
  await call(ctx, a, {
    t: "entry-add",
    date: "2026-09-08",
    durationMs: 8 * 3_600_000,
    billingTag: "Product Development",
  });

  const draft = await call(ctx, a, {
    t: "invoice-create",
    period: "2026-09",
    clock: { today: "2026-10-01", nowMinutes: 0 },
  }) as { id: string; number: string; draft: { totalMinor: number; dueDate: string } };
  assertEquals(draft.number, "INV-2026-09");
  assertEquals(draft.draft.totalMinor, 60_000);
  assertEquals(draft.draft.dueDate, "2026-11-02");

  const issued = await call(ctx, a, { t: "invoice-issue", id: draft.id }) as { status: string };
  assertEquals(issued.status, "issued");
  await assertRejects(
    () => call(ctx, a, { t: "invoice-issue", id: draft.id }),
    Refused,
    "already issued",
  );
  const paid = await call(ctx, a, { t: "invoice-mark-paid", id: draft.id }) as { status: string };
  assertEquals(paid.status, "paid");
  ctx.db.close();
});

Deno.test("11.25 -- the snapshot carries the warning about work added after issuance", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  await signedCall(ctx, a, await device(), "claim");
  await call(ctx, a, {
    t: "entry-add",
    date: "2026-09-08",
    durationMs: 8 * 3_600_000,
    billingTag: "Product Development",
  });
  const draft = await call(ctx, a, {
    t: "invoice-create",
    period: "2026-09",
    clock: { today: "2026-10-01", nowMinutes: 0 },
  }) as { id: string };
  await call(ctx, a, { t: "invoice-issue", id: draft.id });

  let snap = await call(ctx, a, {
    t: "snapshot",
    month: "2026-09",
    clock: CLOCK,
  }) as SnapshotResult;
  assertEquals(snap.invoiceWarnings.length, 0);

  await call(ctx, a, {
    t: "entry-add",
    date: "2026-09-12",
    durationMs: 2 * 3_600_000,
    billingTag: "Meetings",
  });
  snap = await call(ctx, a, { t: "snapshot", month: "2026-09", clock: CLOCK }) as SnapshotResult;
  assertEquals(snap.invoiceWarnings.length, 1);
  assertEquals(snap.invoiceWarnings[0]?.kind, "missing-from-invoice");
  ctx.db.close();
});

Deno.test("12.6/12.7 -- a client error is logged against the device that sent it", async () => {
  const ctx = context();
  const a = session(ctx, "a");
  const alice = await device();
  await signedCall(ctx, a, alice, "claim");
  await call(ctx, a, {
    t: "client-error",
    message: "TypeError: cannot read property",
    context: { stack: "at x", paymentDetails: "should never survive" },
  });

  const logs = await call(ctx, a, { t: "logs", source: "client" }) as Array<
    { message: string; deviceFingerprint?: string; context?: Record<string, unknown> }
  >;
  assertEquals(logs.length, 1);
  assertEquals(logs[0]?.message, "TypeError: cannot read property");
  assertEquals(typeof logs[0]?.deviceFingerprint, "string");
  assertEquals(logs[0]?.context?.paymentDetails, "[redacted]");
  ctx.db.close();
});

Deno.test("every request type has a role, so a new one cannot be added by accident", () => {
  // `authorize` refuses anything with no entry in REQUIRED_ROLE and no place in OPEN, so this is a
  // reminder rather than a guard -- but it fails at the point the omission is introduced.
  const s: Session = { id: "x", authenticated: true, role: "admin" };
  const known: Request["t"][] = [
    "hello",
    "claim-admin",
    "request-access",
    "authenticate",
    "ping",
    "snapshot",
    "timer-start",
    "timer-stop",
    "timer-retag",
    "timer-set-start",
    "timer-discard",
    "entries",
    "entry-add",
    "entry-update",
    "entry-delete",
    "note-add",
    "note-delete",
    "note-audio",
    "notes",
    "invoices",
    "invoice-create",
    "invoice-update",
    "invoice-issue",
    "invoice-mark-paid",
    "invoice-unmark-paid",
    "invoice-revert-issue",
    "invoice-delete",
    "invoice-pdf",
    "config-get",
    "config-set",
    "logs",
    "client-error",
    "access-pending",
    "access-devices",
    "access-approve",
    "access-deny",
    "access-revoke",
    "access-set-role",
    "subscribe",
  ];
  for (const t of known) {
    assertEquals(authorize(s, t).ok, true, `${t} has no role defined`);
  }

  /*
   * And the list is complete.
   *
   * Without this the check runs in one direction only: the array is typed `Request["t"][]`, so it
   * cannot name a request that no longer exists — TypeScript caught two of those when the override
   * endpoints went — but nothing stopped a *new* request being added and never listed here. The
   * test would have kept passing while its subject grew.
   *
   * `OPEN` and `REQUIRED_ROLE` are the two runtime places a request's authority is decided, and
   * between them they are meant to cover every request there is.
   */
  const declared = [...OPEN, ...Object.keys(REQUIRED_ROLE)].sort();
  assertEquals(
    [...known].sort(),
    declared,
    "a request exists that this list does not name, or names twice",
  );
});

/**
 * A nine-to-five week, set explicitly (27.32).
 *
 * The product ships an empty schedule now, because Mon–Fri 09:00–17:00 was a guess about the
 * person using it. These two tests are about reading a *scheduled* day back, so they need a week
 * with something in it, and saying so here is the point: they used to be passing on the strength
 * of a default, which meant they were also asserting that the default existed.
 */
function nineToFive(db: Parameters<typeof setConfig>[0]): void {
  const day = { start: "09:00", end: "17:00" };
  setConfig(db, "pacing", {
    schedule: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: null, 7: null },
  }, NOW);
}

Deno.test("25.24 -- today's scheduled hours do not depend on which month is being viewed", async () => {
  // The month is one shared value in the store, set by the arrows on History and Pacing. Looking
  // at another month used to make the timer screen's lookup miss and fall through `?? 0`, so a
  // Wednesday read "not a scheduled workday" with the progress bar empty.
  const ctx = context();
  const s = session(ctx, "a");
  await signedCall(ctx, s, await device(), "claim");
  nineToFive(ctx.db);

  const wednesday = "2026-09-09";
  const forMonth = async (month: string) =>
    (await call(ctx, s, {
      t: "snapshot",
      month,
      clock: { today: wednesday, nowMinutes: 10 * 60 },
    }) as SnapshotResult).todayScheduledHours;

  assertEquals(await forMonth("2026-09"), 8, "a nine-to-five Wednesday is eight hours");
  assertEquals(await forMonth("2026-08"), 8, "and still eight while looking at August");
  assertEquals(await forMonth("2026-12"), 8, "and while looking at December");
  ctx.db.close();
});

Deno.test("a weekend is nought hours, so the figure is not merely always eight", async () => {
  const ctx = context();
  const s = session(ctx, "a");
  await signedCall(ctx, s, await device(), "claim");
  // With the week set, so "nought" is a fact about Sunday rather than about an empty schedule —
  // otherwise this check cannot fail and the test beside it is the only one doing any work.
  nineToFive(ctx.db);
  const sunday = await call(ctx, s, {
    t: "snapshot",
    month: "2026-09",
    clock: { today: "2026-09-06", nowMinutes: 10 * 60 },
  }) as SnapshotResult;
  assertEquals(sunday.todayScheduledHours, 0);
  ctx.db.close();
});

/*
 * 12.4 — a warning that is a state, not an event.
 *
 * `loadHolidays` runs on every snapshot, so an unreachable source — or a server with no region
 * configured, which is every new one — produced the same sentence in the log from every device on
 * every refresh, and buried everything else in the viewer.
 */
Deno.test("a holiday warning is logged once, not on every snapshot", async () => {
  const lines: string[] = [];
  const ctx: ServerContext = {
    ...context(),
    log: (level, source, message) => lines.push(`${level} ${source} ${message}`),
  };
  // No region: 24.33 forbids defaulting one, so this is the state every new server starts in, and
  // the warning is permanent rather than passing.
  setConfig(ctx.db, "pacing", { region: "" }, NOW);
  const s: Session = { id: "x", authenticated: true, role: "admin" };

  for (let i = 0; i < 3; i++) {
    await call(ctx, s, { t: "snapshot", month: "2026-09", clock: CLOCK });
  }
  const warnings = lines.filter((l) => l.includes("holidays"));
  assertEquals(warnings.length, 1, `logged ${warnings.length} times: ${warnings.join(" | ")}`);
});

/*
 * 20.4 — a device is not told the server's file layout.
 *
 * `pdfPath` is where the frozen document sits inside the data directory. The record type carries
 * it because `deleteInvoice` returns it so the caller can remove the file; the *wire* has no use
 * for it, nothing in any frontend has ever read it, and it went out on every list to every
 * authorised device. A device asks for a PDF by invoice id.
 */
Deno.test({
  name: "20.4 -- an invoice on the wire does not carry the server's path to its file",
  // A real directory, because the row only gets a path when a file is written into one. Without it
  // `pdf_path` stays null, `pdfPath` is absent from the record anyway, and the check passes with
  // the fix removed — which is how it was first written.
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "wire-" });
    const ctx: ServerContext = { ...context(), dataDir: dir };
    const s: Session = { id: "x", authenticated: true, role: "admin" };
    await call(ctx, s, {
      t: "entry-add",
      date: "2026-08-03",
      durationMs: 3_600_000,
      billingTag: "x",
    });
    const made = await call(ctx, s, {
      t: "invoice-create",
      period: "2026-08",
      clock: CLOCK,
    }) as Record<string, unknown>;
    assertEquals("pdfPath" in made, false, `create returned ${Object.keys(made).join(", ")}`);

    await call(ctx, s, { t: "invoice-issue", id: made.id as string });
    const listed = await call(ctx, s, { t: "invoices" }) as Record<string, unknown>[];
    // Issued with a directory to write into, so the row has a path by now: this is the case.
    assertEquals(
      listed.filter((i) => "pdfPath" in i),
      [],
      "an issued invoice published the server's path to its PDF",
    );
    ctx.db.close();
    await Deno.remove(dir, { recursive: true });
  },
});

/*
 * 27.16 — the session running right now counts towards the pace.
 *
 * The projection is built from work *entries*, and a timer that has not been stopped is not one —
 * so "worked so far" sat at whatever the last stop left it while the person watching it worked.
 * The timer screen has always added the running session to today's figure (3.4); pacing had no
 * equivalent.
 */
Deno.test("27.16 -- a running timer is in the pacing figures", async () => {
  const ctx = context();
  const s: Session = { id: "x", authenticated: true, role: "admin" };

  const before = await call(ctx, s, {
    t: "snapshot",
    month: monthOf(CLOCK.today),
    clock: CLOCK,
  }) as SnapshotResult;

  await call(ctx, s, { t: "timer-start", billingTag: "Live", date: CLOCK.today });
  // Two hours ago, so there is something to count rather than a few milliseconds of it.
  const started = NOW - 2 * 3_600_000;
  await call(ctx, s, { t: "timer-set-start", startedAt: started });

  const during = await call(ctx, s, {
    t: "snapshot",
    month: monthOf(CLOCK.today),
    clock: CLOCK,
  }) as SnapshotResult;

  const grew = during.pacing.workedHours - before.pacing.workedHours;
  assertEquals(
    Math.abs(grew - 2) < 0.05,
    true,
    `worked went from ${before.pacing.workedHours} to ${during.pacing.workedHours}`,
  );

  // And it is not an entry: History lists what was recorded, and 11.25 compares ids against an
  // invoice's snapshot. A session still running belongs in neither.
  assertEquals(during.entries.length, before.entries.length);
  assertEquals(during.today.length, before.today.length);
});
