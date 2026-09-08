/**
 * Dispatch: one request in, one response out, with the role check in front.
 *
 * **Nothing about KPS appears here.** `handle` takes a parsed request and a session and returns a
 * value; `main.ts` does the sockets. That is what lets the whole protocol be tested by calling a
 * function, which is most of why the tests below exist at all.
 *
 * The authority rules of section 1 land in two places. Every mutation goes through the stores,
 * which are the only writers (1.7); and every mutation that changes something another frontend is
 * showing calls `broadcast`, which is 1.12.
 */

import {
  type Event,
  fromBase64,
  type HelloResult,
  PROTOCOL_VERSION,
  type Request,
  REQUIRED_ROLE,
  type SnapshotResult,
  type TimerState,
  toAuthClaim,
  toBase64,
} from "@worklog/shared/protocol";
import type { AccessRole } from "@worklog/shared/auth";
import { project } from "@worklog/shared/pacing";
import { invoiceWarnings } from "@worklog/shared/invoice";
import type { DayInterval, Holiday, PacingOverride } from "@worklog/shared/types";
import { type Db, transact } from "./db.ts";
import {
  allows,
  approve,
  ChallengeStore,
  checkClaim,
  claimAdmin,
  deny,
  deviceCount,
  findDevice,
  listDevices,
  listPending,
  purposeFor,
  requestAccess,
  revoke,
  setRole,
  touchDevice,
} from "./access.ts";
import { allConfig, getConfig, publicInvoiceConfig, setConfig } from "./config.ts";
import { loadHolidays } from "./holidays.ts";
import type { Logger } from "./logs.ts";
import { prune, query as queryLogs } from "./logs.ts";
import { PromptHub } from "./prompts.ts";
import {
  activeTimer,
  addEntry,
  deleteEntry,
  discardTimer,
  entriesInMonth,
  entriesOn,
  recentBillingTags,
  Refused,
  runningMs,
  startTimer,
  stopTimer,
  updateEntry,
} from "./work.ts";
import {
  attachPdf,
  getInvoice,
  issue,
  listInvoices,
  markPaid,
  revertIssue,
  saveDraft,
  unmarkPaid,
} from "./invoices.ts";

/** 2.16 — twelve hours is long enough that it is more likely forgotten than worked. */
export const IMPLAUSIBLE_TIMER_MS = 12 * 3_600_000;

export interface Session {
  /** Identifies the connection, for the prompt hub and for dropping listeners. */
  id: string;
  publicKey?: Uint8Array;
  role?: AccessRole;
  /** Set once `authenticate` succeeds on this connection (13.30). */
  authenticated: boolean;
  /** Called to push an `Event` down this connection's subscribe stream, if it has one. */
  push?: (event: Event) => void;
}

export interface ServerContext {
  db: Db;
  challenges: ChallengeStore;
  hub: PromptHub;
  log: Logger;
  serverCertHash: string;
  version: string;
  sessions: Map<string, Session>;
  /** Injected so tests can drive the calendar without a network. */
  now?: () => number;
  offlineHolidays?: boolean;
}

export function broadcast(ctx: ServerContext, event: Event): void {
  for (const s of ctx.sessions.values()) {
    if (!s.authenticated || !s.push) continue;
    try {
      s.push(event);
    } catch {
      // A push that throws is a connection on its way out; the reaper will remove it.
    }
  }
}

function nowOf(ctx: ServerContext): number {
  return (ctx.now ?? Date.now)();
}

function timerState(ctx: ServerContext): TimerState {
  const active = activeTimer(ctx.db);
  if (!active) return { implausible: false };
  return {
    active,
    // 2.17 -- reported, never corrected.
    implausible: runningMs(active, nowOf(ctx)) > IMPLAUSIBLE_TIMER_MS,
  };
}

function overridesFrom(db: Db): Map<string, PacingOverride> {
  const rows = db.prepare("SELECT date, start_time, end_time, reason FROM pacing_override").all();
  const out = new Map<string, PacingOverride>();
  for (const r of rows) {
    const row = r as unknown as {
      date: string;
      start_time: string | null;
      end_time: string | null;
      reason: string | null;
    };
    const interval: DayInterval = row.start_time && row.end_time
      ? { start: row.start_time, end: row.end_time }
      : null;
    out.set(row.date, {
      date: row.date,
      interval,
      ...(row.reason ? { reason: row.reason } : {}),
    });
  }
  return out;
}

/**
 * 13.32–13.34 — the role check, in one place.
 *
 * Unauthenticated requests are the four that establish a session; everything else needs at least
 * `read`. A request with no entry in `REQUIRED_ROLE` and no place in that list is refused rather
 * than allowed, so adding a request without deciding its role fails closed.
 */
const OPEN: ReadonlySet<Request["t"]> = new Set([
  "hello",
  "claim-admin",
  "request-access",
  "authenticate",
]);

export function authorize(
  session: Session,
  t: Request["t"],
): { ok: true } | { ok: false; code: string; message: string } {
  if (OPEN.has(t)) return { ok: true };
  if (!session.authenticated || !session.role) {
    return { ok: false, code: "unauthenticated", message: "this device has not authenticated" };
  }
  const needed = REQUIRED_ROLE[t];
  if (!needed) {
    return { ok: false, code: "unknown-request", message: `no role is defined for ${t}` };
  }
  if (!allows(session.role, needed)) {
    return { ok: false, code: "forbidden", message: `${t} needs ${needed} access` };
  }
  return { ok: true };
}

export async function handle(
  ctx: ServerContext,
  session: Session,
  req: Request,
): Promise<unknown> {
  const now = nowOf(ctx);
  const db = ctx.db;

  switch (req.t) {
    // ---------------------------------------------------------------- access
    case "hello": {
      // An unproved hint (see the request's own comment): it picks which button the frontend
      // draws, and the signed claim that follows is what actually decides anything.
      const asserted = req.publicKey ? fromBase64(req.publicKey) : session.publicKey;
      const result: HelloResult = {
        protocolVersion: PROTOCOL_VERSION,
        serverCertHash: ctx.serverCertHash,
        challenge: toBase64(ctx.challenges.issue(now)),
        offer: asserted ? purposeFor(db, asserted) : deviceCount(db) === 0 ? "claim" : "request",
        version: ctx.version,
      };
      if (asserted) {
        const device = findDevice(db, asserted);
        if (device) result.role = device.role;
      }
      return result;
    }

    case "claim-admin":
    case "request-access":
    case "authenticate": {
      const claim = toAuthClaim(req.claim);
      const verdict = await checkClaim(
        { db, challenges: ctx.challenges, serverCertHash: ctx.serverCertHash, now },
        claim,
        fromBase64(req.signature),
      );
      if (!verdict.ok) {
        ctx.log("warn", "access", `refused a ${req.t}`, { reason: verdict.reason });
        throw new Refused(verdict.reason, `the signed request was refused: ${verdict.reason}`);
      }
      session.publicKey = claim.publicKey;

      if (req.t === "authenticate") {
        const device = findDevice(db, claim.publicKey);
        if (!device) throw new Refused("not-authorized", "this device is not authorized");
        session.authenticated = true;
        session.role = device.role;
        touchDevice(db, claim.publicKey, now);
        ctx.log("info", "access", "device authenticated", { name: device.name, role: device.role });
        return { role: device.role, name: device.name };
      }

      if (req.t === "claim-admin") {
        const outcome = claimAdmin(db, claim, now);
        session.authenticated = true;
        session.role = outcome.role ?? "admin";
        ctx.log("info", "access", "admin claimed", { name: claim.deviceName });
        broadcast(ctx, { e: "changed", area: "access" });
        return outcome;
      }

      const outcome = requestAccess(db, claim, now);
      ctx.log("info", "access", "access requested", {
        name: claim.deviceName,
        role: claim.role,
      });
      broadcast(ctx, { e: "changed", area: "access" });
      return outcome;
    }

    // ---------------------------------------------------------------- reading
    case "snapshot": {
      const pacingConfig = getConfig(db, "pacing");
      const year = Number(req.month.slice(0, 4));
      const holidays = await loadHolidays({
        db,
        region: pacingConfig.region,
        year,
        now,
        ...(ctx.offlineHolidays ? { offline: true } : {}),
      });
      if (holidays.warning) ctx.log("warn", "holidays", holidays.warning, { year });

      const entries = entriesInMonth(db, req.month);
      const invoices = listInvoices(db);
      const result: SnapshotResult = {
        timer: timerState(ctx),
        today: entriesOn(db, req.clock.today),
        month: req.month,
        entries,
        pacing: project({
          month: req.month,
          cal: {
            schedule: pacingConfig.schedule,
            holidays: new Map(holidays.holidays.map((h: Holiday) => [h.date, h])),
            overrides: overridesFrom(db),
          },
          monthlyTargetHours: pacingConfig.monthlyTargetHours,
          entries,
          today: req.clock.today,
          nowMinutes: req.clock.nowMinutes,
        }),
        ...(holidays.warning ? { holidayWarning: holidays.warning } : {}),
        recentTags: recentBillingTags(db),
        invoiceWarnings: invoiceWarnings(allEntries(db), invoices),
        pacingConfig,
      };
      return result;
    }

    case "entries":
      return entriesInMonth(db, req.month);

    case "invoices":
      return listInvoices(db);

    case "config-get": {
      const cfg = allConfig(db);
      // 20.1, 20.3 -- payment details are edited, never displayed, so they do not come back.
      return { ...cfg, invoice: publicInvoiceConfig(cfg.invoice) };
    }

    case "notes":
      return db.prepare(
        "SELECT id, created_at, body, audio_path, audio_ms, prompted FROM work_note" +
          " ORDER BY created_at DESC LIMIT ?",
      ).all(req.limit ?? 50);

    case "logs":
      return queryLogs(db, {
        ...(req.minLevel ? { minLevel: req.minLevel } : {}),
        ...(req.from !== undefined ? { from: req.from } : {}),
        ...(req.to !== undefined ? { to: req.to } : {}),
        ...(req.source ? { source: req.source } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
        admin: session.role === "admin",
      });

    // ---------------------------------------------------------------- the timer
    case "timer-start": {
      const timer = startTimer(db, { billingTag: req.billingTag, date: req.date, now });
      ctx.log("info", "timer", "started", { billingTag: req.billingTag, date: req.date });
      broadcast(ctx, { e: "timer", timer: timerState(ctx) });
      return timer;
    }

    case "timer-stop": {
      const entry = stopTimer(db, now);
      ctx.log("info", "timer", "stopped", { durationMs: entry.durationMs, date: entry.date });
      broadcast(ctx, { e: "timer", timer: timerState(ctx) });
      broadcast(ctx, { e: "changed", area: "entries" });
      return entry;
    }

    case "timer-discard": {
      const had = discardTimer(db);
      if (had) {
        ctx.log("info", "timer", "discarded without recording");
        broadcast(ctx, { e: "timer", timer: timerState(ctx) });
      }
      return { discarded: had };
    }

    // ---------------------------------------------------------------- entries
    case "entry-add": {
      const entry = addEntry(db, {
        date: req.date,
        durationMs: req.durationMs,
        billingTag: req.billingTag,
        ...(req.timing ? { timing: req.timing } : {}),
      }, now);
      broadcast(ctx, { e: "changed", area: "entries" });
      return entry;
    }

    case "entry-update": {
      const entry = updateEntry(db, req.id, {
        ...(req.date !== undefined ? { date: req.date } : {}),
        ...(req.durationMs !== undefined ? { durationMs: req.durationMs } : {}),
        ...(req.billingTag !== undefined ? { billingTag: req.billingTag } : {}),
        ...(req.timing !== undefined ? { timing: req.timing } : {}),
      }, now);
      broadcast(ctx, { e: "changed", area: "entries" });
      return entry;
    }

    case "entry-delete": {
      const gone = deleteEntry(db, req.id);
      if (gone) broadcast(ctx, { e: "changed", area: "entries" });
      return { deleted: gone };
    }

    // ---------------------------------------------------------------- notes
    case "note-add": {
      if (!req.body && !req.audioBase64) {
        throw new Refused("empty-note", "a work note needs text or audio");
      }
      const id = crypto.randomUUID();
      // 17.10 -- audio goes to disk; only the path is stored. Writing it is `main.ts`'s job, so
      // this records the intended path and the caller supplies the bytes alongside.
      const audioPath = req.audioBase64 ? `notes/${id}.opus` : null;
      db.prepare(
        "INSERT INTO work_note (id, created_at, body, audio_path, audio_ms, prompted)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, now, req.body ?? null, audioPath, req.audioMs ?? null, req.prompted ? 1 : 0);
      broadcast(ctx, { e: "changed", area: "notes" });
      return { id, audioPath };
    }

    // ---------------------------------------------------------------- invoices
    case "invoice-save": {
      const saved = saveDraft(db, {
        period: req.period,
        ...(req.teamProject !== undefined ? { teamProject: req.teamProject } : {}),
        ...(req.bonusMinor !== undefined ? { bonusMinor: req.bonusMinor } : {}),
        ...(req.number !== undefined ? { number: req.number } : {}),
        preparedOn: req.clock.today,
      }, now);
      broadcast(ctx, { e: "changed", area: "invoices" });
      return saved;
    }

    case "invoice-issue": {
      const issued = issue(db, req.id, now);
      ctx.log("info", "invoice", "issued", { number: issued.number, period: issued.period });
      broadcast(ctx, { e: "changed", area: "invoices" });
      return issued;
    }

    case "invoice-mark-paid": {
      const paid = markPaid(db, req.id, now);
      ctx.log("info", "invoice", "marked paid", { number: paid.number });
      broadcast(ctx, { e: "changed", area: "invoices" });
      return paid;
    }

    case "invoice-unmark-paid": {
      const back = unmarkPaid(db, req.id, now);
      ctx.log("warn", "invoice", "payment unmarked", { number: back.number });
      broadcast(ctx, { e: "changed", area: "invoices" });
      return back;
    }

    case "invoice-revert-issue": {
      const back = revertIssue(db, req.id, now);
      ctx.log("warn", "invoice", "issuance reverted", { number: back.number });
      broadcast(ctx, { e: "changed", area: "invoices" });
      return back;
    }

    case "invoice-pdf": {
      const invoice = getInvoice(db, req.id);
      if (!invoice) throw new Refused("no-such-invoice", `no invoice ${req.id}`);
      // 8.15, 11.4 -- generating changes no accounting state. The renderer lives in `pdf.ts`;
      // this records where the file went and hands the path back.
      const path = `invoices/${invoice.number}.pdf`;
      attachPdf(db, invoice.id, path, now);
      return { path, invoice: getInvoice(db, req.id) };
    }

    // ---------------------------------------------------------------- config
    case "config-set": {
      const updated = setConfig(db, req.section, req.value as never, now);
      ctx.log("info", "config", `${req.section} updated`);
      broadcast(ctx, { e: "changed", area: "config" });
      return req.section === "invoice" ? publicInvoiceConfig(updated as never) : updated;
    }

    case "override-set": {
      db.prepare(
        `INSERT INTO pacing_override (date, start_time, end_time, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET start_time = excluded.start_time,
                                          end_time = excluded.end_time,
                                          reason = excluded.reason`,
      ).run(req.date, req.interval?.start ?? null, req.interval?.end ?? null, req.reason ?? null);
      broadcast(ctx, { e: "changed", area: "config" });
      return { date: req.date };
    }

    case "override-delete": {
      const gone = db.prepare("DELETE FROM pacing_override WHERE date = ?").run(req.date).changes;
      if (Number(gone) > 0) broadcast(ctx, { e: "changed", area: "config" });
      return { deleted: Number(gone) > 0 };
    }

    // ---------------------------------------------------------------- diagnostics
    case "client-error": {
      // 12.6, 12.7, 12.16 -- accepted only from an authenticated device, and attributed to it.
      ctx.log("error", "client", req.message, req.context);
      db.prepare("UPDATE log SET device_key = ? WHERE id = (SELECT max(id) FROM log)")
        .run(session.publicKey ?? null);
      prune(db, { now });
      return { recorded: true };
    }

    // ---------------------------------------------------------------- administration
    case "access-pending":
      return listPending(db).map((p) => ({ ...p, publicKey: toBase64(p.publicKey) }));

    case "access-devices":
      return listDevices(db).map((d) => ({ ...d, publicKey: toBase64(d.publicKey) }));

    case "access-approve": {
      const device = approve(db, fromBase64(req.publicKey), req.role, now);
      ctx.log("info", "access", "approved", { name: device.name, role: device.role });
      broadcast(ctx, { e: "changed", area: "access" });
      notifyDevice(ctx, device.publicKey, { e: "access-granted", role: device.role });
      return { ...device, publicKey: toBase64(device.publicKey) };
    }

    case "access-deny": {
      const denied = deny(db, fromBase64(req.publicKey));
      if (denied) broadcast(ctx, { e: "changed", area: "access" });
      return { denied };
    }

    case "access-revoke": {
      const key = fromBase64(req.publicKey);
      const gone = revoke(db, key);
      if (gone) {
        ctx.log("warn", "access", "device revoked");
        // The revoked device loses its session immediately, not at its next reconnect.
        for (const s of ctx.sessions.values()) {
          if (s.publicKey && sameKey(s.publicKey, key)) {
            s.authenticated = false;
            delete s.role;
            try {
              s.push?.({ e: "access-revoked" });
            } catch { /* the connection is going anyway */ }
          }
        }
        broadcast(ctx, { e: "changed", area: "access" });
      }
      return { revoked: gone };
    }

    case "access-set-role": {
      const device = setRole(db, fromBase64(req.publicKey), req.role);
      for (const s of ctx.sessions.values()) {
        if (s.publicKey && sameKey(s.publicKey, device.publicKey) && s.authenticated) {
          s.role = device.role;
        }
      }
      ctx.log("info", "access", "role changed", { name: device.name, role: device.role });
      broadcast(ctx, { e: "changed", area: "access" });
      return { ...device, publicKey: toBase64(device.publicKey) };
    }

    case "subscribe":
      // The stream itself is set up by the caller; this only acknowledges.
      return { subscribed: true };
  }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function notifyDevice(ctx: ServerContext, publicKey: Uint8Array, event: Event): void {
  for (const s of ctx.sessions.values()) {
    if (s.publicKey && sameKey(s.publicKey, publicKey)) {
      try {
        s.push?.(event);
      } catch { /* going away */ }
    }
  }
}

function allEntries(db: Db) {
  return db.prepare(
    "SELECT id, date, duration_ms, billing_tag, started_at, ended_at FROM work_entry ORDER BY date",
  ).all().map((r) => {
    const row = r as unknown as {
      id: string;
      date: string;
      duration_ms: number;
      billing_tag: string;
    };
    return {
      id: row.id,
      date: row.date,
      durationMs: Number(row.duration_ms),
      billingTag: row.billing_tag,
    };
  });
}

export { transact };
