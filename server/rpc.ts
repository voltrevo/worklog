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
  type StoredInvoiceWire,
  type TimerState,
  toAuthClaim,
  toBase64,
  type WorkNoteWire,
} from "@worklog/shared/protocol";
import type { AccessRole } from "@worklog/shared/auth";
import { project } from "@worklog/shared/pacing";
import { shapeOf } from "@worklog/shared/schedule";
import { appliedPaymentOverride, documentFor, invoiceWarnings } from "@worklog/shared/invoice";
import type { DayInterval, Holiday, PacingOverride, WorkEntry } from "@worklog/shared/types";
import { monthOf } from "@worklog/shared/dates";
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
import {
  allConfig,
  getConfig,
  missingInvoiceConfig,
  publicInvoiceConfig,
  setConfig,
} from "./config.ts";
import { checkRegion, loadHolidays } from "./holidays.ts";
import type { Logger } from "./logs.ts";
import { prune, query as queryLogs } from "./logs.ts";
import { PromptHub } from "./prompts.ts";
import {
  activeTimer,
  addEntry,
  allEntries,
  deleteEntry,
  discardTimer,
  entriesInMonth,
  entriesOn,
  recentBillingTags,
  Refused,
  restartTimerAt,
  retagTimer,
  runningMs,
  startTimer,
  stopTimer,
  updateEntry,
} from "./work.ts";
import { renderInvoicePdfChecked } from "./pdf.ts";
import {
  attachPdf,
  createDraft,
  deleteInvoice,
  frozenConfigFor,
  getInvoice,
  issue,
  listInvoices,
  markPaid,
  paymentOverrideFor,
  revertIssue,
  type StoredInvoice,
  unmarkPaid,
  updateDraft,
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
  /** Where generated PDFs and audio notes go (17.10, 17.11). Absent in tests, which write none. */
  dataDir?: string;
  /** Injected so tests can drive the calendar without a network. */
  now?: () => number;
  offlineHolidays?: boolean;
  /**
   * 12.4 — the last holiday warning written to the log, so the same one is not written again.
   *
   * `loadHolidays` runs on every snapshot, and a warning is a *state* rather than an event: an
   * unreachable source stays unreachable, and a server with no region configured — which is every
   * new one, since 24.33 forbids defaulting it — produces the same sentence on every refresh, from
   * every device, forever. Logging it each time buries everything else in the viewer.
   *
   * Held on the context rather than in a module variable so two servers in one process, which is
   * what the tests are, cannot silence each other.
   */
  lastHolidayWarning?: string;
}

/**
 * Write a file under the data directory, making the directory it goes in.
 *
 * `main.ts` creates `notes/` and `invoices/` at startup and both writers assumed it — so a data
 * directory that has not been through that startup, which is what a test hands over, fails at the
 * first write with `NotFound` naming a path nobody chose. The precondition was invisible and it
 * belonged to the two lines that depend on it.
 */
async function writeUnderData(dataDir: string, relative: string, bytes: Uint8Array): Promise<void> {
  const at = `${dataDir}/${relative}`;
  await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(at, bytes);
}

/**
 * An invoice record as a device may see it.
 *
 * `pdfPath` is where the file sits inside the server's data directory, and it went to every
 * authorised device on every list — nothing in any frontend has ever read it, and there is no
 * reason a device should be told the server's file layout to ask for a PDF by invoice id. The
 * record type serves the store, which does need it: `deleteInvoice` returns it so the caller can
 * remove the file.
 *
 * Named and explicit, so that a column added to the row later is not published by default.
 */
function onWire(record: StoredInvoice): StoredInvoiceWire {
  const { pdfPath: _server, ...wire } = record;
  return wire;
}

/** 17.11 — one place decides what an invoice's file is called, since two paths now write it. */
/**
 * What the download is called. Derived from the invoice number, which is the point of it.
 *
 * Sanitised because it becomes a filename on somebody's machine, and truncated because an
 * invoice number is a short string in every sane case and a filename has a length limit in every
 * case at all.
 */
function fileNameFor(number: string): string {
  const safe = number.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${safe || "invoice"}.pdf`;
}

/**
 * Where the frozen PDF is *kept*. Keyed by id, and deliberately not by the number.
 *
 * The storage path used to be `invoices/${fileNameFor(number)}`, so two different numbers that
 * sanitise the same — "###" and "***" both become "___" — shared one file. 9.16 stops two issued
 * invoices having the same *number*; it says nothing about two numbers colliding after every
 * character that is not alphanumeric has been replaced. The second issuance would have
 * overwritten the first invoice's frozen document, which is 24.30 defeated by a filename.
 *
 * A long number was the other half: past the OS limit, `writeFile` fails and issuing fails with
 * it. An id is 36 characters, always.
 *
 * Existing rows keep whatever path they were stored with — `pdf_path` is per row — so nothing has
 * to be moved.
 */
function pdfPathFor(id: string): string {
  return `invoices/${id}.pdf`;
}

/**
 * 24.31 — refuse rather than render blanks.
 *
 * A PDF generated with no payment details and no client address is not a draft of an invoice, it
 * is a page with holes in it, and it looked enough like a document to send. Every missing field is
 * named at once: one per attempt, for a dozen fields, is a dozen attempts.
 */
function requireInvoiceConfig(db: Db): void {
  const missing = missingInvoiceConfig(getConfig(db, "invoice"));
  if (missing.length === 0) return;
  throw new Refused(
    "invoice-config-incomplete",
    `Settings needs ${missing.join(", ")} before an invoice can be made.`,
  );
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

/**
 * Any pacing overrides in the database, for the projection to honour.
 *
 * Nothing *writes* these any more: 24.20 removed the editor, and the two endpoints that fed it
 * went with it rather than sitting as unreachable write surface. The read stays because the table
 * does — migrations are append-only — and because an installation that has rows in it should keep
 * getting the pace those rows imply rather than silently having them ignored.
 */
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
export const OPEN: ReadonlySet<Request["t"]> = new Set([
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
        // 27.37 — the log is how a flood becomes visible; without it the cap is silent.
        challenge: toBase64(
          ctx.challenges.issue(now, (why) => ctx.log("warn", "access", why)),
        ),
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
        // Seen, for the same reason `authenticate` counts: the claim is a signed request from this
        // device, arriving now. Without this the admin device reads "last seen never" in its own
        // device list until the first time it reconnects -- which is the one row on that screen the
        // reader can personally disprove.
        touchDevice(db, claim.publicKey, now);
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

    // 22.10 — the cheapest possible answer, so a client can find out whether anyone is still
    // there without asking for a snapshot to do it.
    case "ping":
      return { at: nowOf(ctx) };

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
      if (holidays.warning !== ctx.lastHolidayWarning) {
        if (holidays.warning) ctx.log("warn", "holidays", holidays.warning, { year });
        // Cleared as well as set: a source that comes back and goes away again is worth saying
        // twice, and only the repetition in between is not.
        ctx.lastHolidayWarning = holidays.warning;
      }

      const entries = entriesInMonth(db, req.month);
      const invoices = listInvoices(db);
      const overrides = overridesFrom(db);
      /*
       * 27.16 — the session running right now counts towards the pace.
       *
       * The projection is built from work *entries*, and a timer that has not been stopped is not
       * one yet — so "worked so far" and everything derived from it sat at whatever the last stop
       * left, while the person watching it was working. The timer screen has always added the
       * running session to today's figure (3.4); pacing had no equivalent.
       *
       * Added to the projection's input only. It is not an entry: History must not list it, and
       * 11.25's set difference must not see an id no invoice could ever name.
       */
      const running = timerState(ctx);
      const inProgress: WorkEntry[] = running.active && monthOf(running.active.date) === req.month
        ? [{
          id: "running",
          date: running.active.date,
          durationMs: Math.max(0, nowOf(ctx) - running.active.startedAt),
          billingTag: running.active.billingTag,
        }]
        : [];

      const result: SnapshotResult = {
        timer: running,
        today: entriesOn(db, req.clock.today),
        month: req.month,
        entries,
        pacing: project({
          month: req.month,
          cal: {
            schedule: pacingConfig.schedule,
            holidays: new Map(holidays.holidays.map((h: Holiday) => [h.date, h])),
            overrides,
          },
          monthlyTargetHours: pacingConfig.monthlyTargetHours,
          entries: [...entries, ...inProgress],
          today: req.clock.today,
          nowMinutes: req.clock.nowMinutes,
        }),
        ...(holidays.warning ? { holidayWarning: holidays.warning } : {}),
        todayScheduledHours: shapeOf(req.clock.today, {
          schedule: pacingConfig.schedule,
          holidays: new Map(holidays.holidays.map((h: Holiday) => [h.date, h])),
          overrides,
        }).hours,
        recentTags: recentBillingTags(db),
        invoiceWarnings: invoiceWarnings(allEntries(db), invoices),
      };
      return result;
    }

    case "entries":
      return entriesInMonth(db, req.month);

    case "invoices":
      return listInvoices(db).map(onWire);

    case "config-get": {
      const cfg = allConfig(db);
      // 20.1, 20.3 -- payment details are edited, never displayed, so they do not come back.
      return { ...cfg, invoice: publicInvoiceConfig(cfg.invoice) };
    }

    case "notes":
      return listNotes(db, req.limit ?? 50);

    case "note-audio": {
      const row = db.prepare("SELECT audio_path FROM work_note WHERE id = ?").get(req.id) as
        | { audio_path: string | null }
        | undefined;
      if (!row?.audio_path) throw new Refused("no-such-audio", "that note has no recording");
      if (!ctx.dataDir) throw new Refused("no-data-dir", "this server stores no files");
      const bytes = await Deno.readFile(`${ctx.dataDir}/${row.audio_path}`);
      return { audioBase64: toBase64(bytes) };
    }

    case "note-delete": {
      const row = db.prepare("SELECT audio_path FROM work_note WHERE id = ?").get(req.id) as
        | { audio_path: string | null }
        | undefined;
      if (!row) throw new Refused("no-such-note", "no note with that id");

      // The row goes first. A file that outlives its row is litter; a row that outlives its file
      // is a Play button that fails, and 24.6 is about the note being *gone*.
      db.prepare("DELETE FROM work_note WHERE id = ?").run(req.id);
      if (row.audio_path && ctx.dataDir) {
        await Deno.remove(`${ctx.dataDir}/${row.audio_path}`).catch(() => {
          // Already gone, or never written. Not a reason to fail a delete that has happened.
        });
      }
      ctx.log("info", "notes", "deleted a note");
      broadcast(ctx, { e: "changed", area: "notes" });
      return { deleted: true };
    }

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

    case "timer-retag": {
      const timer = retagTimer(db, req.billingTag);
      ctx.log("info", "timer", "retagged", { billingTag: timer.billingTag });
      broadcast(ctx, { e: "timer", timer: timerState(ctx) });
      return timer;
    }

    case "timer-set-start": {
      const timer = restartTimerAt(db, req.startedAt, now);
      ctx.log("info", "timer", "start moved", { startedAt: timer.startedAt });
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
      if (!req.body?.trim() && !req.audioBase64) {
        throw new Refused("empty-note", "a work note needs text or a recording");
      }
      const id = crypto.randomUUID();

      /*
       * 17.10 — the audio goes to disk and only its path is stored. A minute of speech is a
       * couple of hundred kilobytes, and a database that holds them is a database nobody will
       * copy: the size is the reason, and it is the honest one.
       *
       * **The old reason given here was wrong** and worth correcting rather than deleting: it said
       * a small database "stays a file you can copy while the server is running". It does not.
       * `journal_mode = WAL` means the main file can be four kilobytes of header while four
       * hundred kilobytes of committed work sits in `worklog.sqlite-wal`, and a copy of the main
       * file alone opens perfectly and is empty. Measured, not assumed. The README says what to do
       * instead.
       */
      let audioPath: string | null = null;
      if (req.audioBase64) {
        if (!ctx.dataDir) throw new Refused("no-data-dir", "this server stores no files");
        audioPath = `notes/${id}.${extensionFor(req.audioType)}`;
        await writeUnderData(ctx.dataDir, audioPath, fromBase64(req.audioBase64));
      }

      db.prepare(
        "INSERT INTO work_note (id, created_at, body, audio_path, audio_ms, prompted)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        now,
        req.body?.trim() || null,
        audioPath,
        req.audioMs ?? null,
        req.prompted ? 1 : 0,
      );
      ctx.log("info", "note", req.prompted ? "answered a prompt" : "wrote a work note", {
        hasAudio: audioPath !== null,
      });
      broadcast(ctx, { e: "changed", area: "notes" });
      return { id };
    }

    // ---------------------------------------------------------------- invoices
    case "invoice-create": {
      requireInvoiceConfig(db);
      const saved = createDraft(db, {
        period: req.period,
        ...(req.teamProject !== undefined ? { teamProject: req.teamProject } : {}),
        ...(req.bonusMinor !== undefined ? { bonusMinor: req.bonusMinor } : {}),
        ...(req.number !== undefined ? { number: req.number } : {}),
        preparedOn: req.clock.today,
      }, now);
      broadcast(ctx, { e: "changed", area: "invoices" });
      return onWire(saved);
    }

    case "invoice-update": {
      // No `requireInvoiceConfig` here: the draft already exists, so the configuration was
      // complete when it was made, and refusing to let somebody fix a typo because an unrelated
      // setting was blanked since would be a refusal with nothing behind it.
      /*
       * 27.47 — forwarded whole, rather than field by field.
       *
       * This listed all seven, so adding one to the request meant remembering to add it here too;
       * forgetting would accept the field and drop it, and the device would believe it had saved.
       * `t` and `id` are what this handler is, and everything else is the edit by construction.
       */
      const { t: _t, id: _id, ...edit } = req;
      const saved = updateDraft(db, req.id, edit, now);
      broadcast(ctx, { e: "changed", area: "invoices" });
      return onWire(saved);
    }

    case "invoice-issue": {
      requireInvoiceConfig(db);
      // 27.51 — the day the person issuing it is on, not the day the server is on.
      const issued = issue(db, req.id, now, req.clock.today);

      /*
       * 24.30 — freeze the *document*, not only the data.
       *
       * Issuing already froze a snapshot of the numbers, and the PDF was re-rendered from that
       * snapshot on every download. That is a reproduction of the invoice rather than the invoice:
       * change the letterhead, the payment details or the tax label afterwards and the "frozen"
       * document comes back different, which is the one thing freezing was supposed to prevent.
       *
       * So the bytes are written here, once, and `invoice-pdf` serves the file from now on. The
       * consequence is worth stating: a typo in your address cannot be corrected on an issued
       * invoice. Revert it, fix the setting, issue it again — which is the same thing you would
       * have to do with a document you had already sent.
       */
      if (ctx.dataDir) {
        /*
         * The settings `issue` just froze, not the global ones.
         *
         * They are the same values at this instant *except* for a per-invoice payment override
         * (25.12), which lives in its own column and is folded into the frozen copy. Rendering
         * from the global config here would write the file with the configured account and then
         * serve that file forever — the override would apply to the arithmetic and to a
         * re-render, and not to the document actually sent.
         */
        const rendered = await renderInvoicePdfChecked(
          documentFor(issued),
          frozenConfigFor(db, issued.id) ?? getConfig(db, "invoice"),
        );
        const bytes = rendered.bytes;
        if (rendered.outside.length > 0) {
          ctx.log("warn", "invoice", "the PDF layout overflowed its margins", {
            number: issued.number,
            outside: rendered.outside.slice(0, 5),
          });
        }
        const relative = pdfPathFor(issued.id);
        await writeUnderData(ctx.dataDir, relative, bytes);
        attachPdf(db, issued.id, relative, now);
      }

      ctx.log("info", "invoice", "issued", { number: issued.number, period: issued.period });
      broadcast(ctx, { e: "changed", area: "invoices" });
      return getInvoice(db, req.id) ?? issued;
    }

    case "invoice-delete": {
      const gone = getInvoice(db, req.id);
      const { pdfPath } = deleteInvoice(db, req.id);
      if (pdfPath && ctx.dataDir) {
        await Deno.remove(`${ctx.dataDir}/${pdfPath}`).catch(() => {
          // Already gone. The row is what mattered and it is deleted.
        });
      }
      ctx.log("warn", "invoice", "deleted", { number: gone?.number ?? req.id });
      broadcast(ctx, { e: "changed", area: "invoices" });
      return { deleted: true };
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
      if (!ctx.dataDir) {
        throw new Refused(
          "no-data-dir",
          "this server was started without somewhere to write files",
        );
      }

      // 24.30 — an issued invoice has a file, and the file is the invoice. Read it back rather
      // than re-rendering: re-rendering is how a frozen document quietly changes.
      const frozen = invoice.status !== "draft" && invoice.pdfPath
        ? await Deno.readFile(`${ctx.dataDir}/${invoice.pdfPath}`).catch(() => undefined)
        : undefined;

      const name = fileNameFor(invoice.number);
      const relative = invoice.pdfPath ?? pdfPathFor(invoice.id);
      let bytes: Uint8Array;
      if (frozen) {
        bytes = frozen;
        ctx.log("debug", "invoice", "served the frozen PDF", {
          number: invoice.number,
          bytes: bytes.length,
        });
      } else {
        /*
         * A draft, or an issued invoice whose file has gone missing. 8.15, 11.4 — rendering
         * changes no accounting state either way.
         *
         * **The second case is a hole in 24.30 and it used to be silent.** The snapshot fixes the
         * numbers, but the letterhead, the payment details and the tax label come from the
         * configuration as it is *now*, so an issued invoice whose file was lost comes back
         * subtly different from the one that was sent — which is the exact failure freezing the
         * bytes was introduced to prevent. Re-rendering is still better than refusing to hand
         * over an invoice at all; being unable to tell it happened is not.
         *
         * Both paths logged, distinguishably, and the lossy one at `warn`.
         */
        if (invoice.status !== "draft") {
          const kept = frozenConfigFor(db, invoice.id) !== undefined;
          ctx.log("warn", "invoice", "the frozen PDF is missing; re-rendering it", {
            number: invoice.number,
            status: invoice.status,
            expected: invoice.pdfPath ?? null,
            note: kept
              ? "re-rendered from the settings it was issued under, so it should be identical"
              : "issued before those settings were kept, so the letterhead and payment details " +
                "come from the current ones",
          });
        }
        // 24.30 — the settings it went out under, where those were kept. Only a draft, or an
        // invoice issued before that column existed, falls back to the current ones.
        const frozenConfig = frozenConfigFor(db, invoice.id);
        if (!frozenConfig) requireInvoiceConfig(db);
        // A draft has no frozen settings, so its payment override is applied here; an issued one
        // already had it folded in at issuance and must not have today's applied over the top.
        const config = frozenConfig ?? {
          ...getConfig(db, "invoice"),
          ...appliedPaymentOverride(paymentOverrideFor(db, invoice.id)),
        };
        /*
         * 27.42 — what it says now, which for a reverted draft is not what it was issued as.
         *
         * This read `snapshot ?? draft`, and the frozen-file branch above is gated on the status
         * while this one was not. So a reverted invoice re-rendered its old snapshot: the number
         * on the page came from an issuance that had been taken back, and editing the draft
         * changed nothing about the document it produced.
         */
        const rendered = await renderInvoicePdfChecked(documentFor(invoice), config);
        bytes = rendered.bytes;
        // Every column width in the renderer is a number chosen against the fixture. When a real
        // value does not fit one of them the document is still produced — refusing to hand over
        // an invoice would be worse — but it is not something to find out from a client.
        if (rendered.outside.length > 0) {
          ctx.log("warn", "invoice", "the PDF layout overflowed its margins", {
            number: invoice.number,
            outside: rendered.outside.slice(0, 5),
            more: Math.max(0, rendered.outside.length - 5),
          });
        }
        await Deno.writeFile(`${ctx.dataDir}/${relative}`, bytes);
        attachPdf(db, invoice.id, relative, now);
        ctx.log("info", "invoice", "rendered a PDF", {
          number: invoice.number,
          bytes: bytes.length,
        });
      }
      // 8.33 -- and back down the wire, because a file on the server's disk is not an export. The
      // frontend that asked may be a phone on the other side of the room; `path` tells it where the
      // canonical copy lives (17.11) and `pdfBase64` is the copy it can actually open.
      return {
        path: relative,
        bytes: bytes.length,
        fileName: name,
        pdfBase64: toBase64(bytes),
        invoice: getInvoice(db, req.id),
      };
    }

    // ---------------------------------------------------------------- config
    case "config-set": {
      // 24.42 — validated before it is stored, not after it has quietly flattened a month's
      // holidays. Only when the region is actually changing: re-saving an unrelated pacing setting
      // should not fail because the holiday API happens to be unreachable this minute.
      if (req.section === "pacing") {
        const wanted = (req.value as { region?: unknown }).region;
        const current = getConfig(db, "pacing").region;
        if (typeof wanted === "string" && wanted.trim() !== current) {
          const verdict = await checkRegion({
            db,
            region: wanted,
            year: Number(req.clock?.today.slice(0, 4) ?? new Date(now).getFullYear()),
            now,
            offline: ctx.offlineHolidays ?? false,
          });
          if (!verdict.ok) throw new Refused("bad-region", verdict.reason);
        }
      }
      const updated = setConfig(db, req.section, req.value as never, now);
      ctx.log("info", "config", `${req.section} updated`);
      broadcast(ctx, { e: "changed", area: "config" });
      return req.section === "invoice" ? publicInvoiceConfig(updated as never) : updated;
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

/**
 * 5.25 — Opus, in whatever container the browser gave us.
 *
 * The extension is derived from the reported MIME type rather than assumed: a browser may hand
 * back `audio/webm;codecs=opus` or `audio/ogg;codecs=opus`, and writing `.opus` over a WebM
 * container would make the file unplayable by name alone.
 *
 * **27.33 — an unrecognised container is refused, not filed as `.opus`.** That fallback existed
 * for a case the recorder cannot produce (it offers four types, and all four map), and it did the
 * one thing worse than failing: it named the file after a codec, `typeOf` below then read that
 * name back as `audio/ogg`, and the device was handed a confident MIME type for a container
 * nobody had identified. Three guesses in a row, the last of which the player believes.
 */
function extensionFor(mime?: string): string {
  const type = (mime ?? "").toLowerCase();
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("webm")) return "webm";
  throw new Refused(
    "bad-audio-type",
    `this server does not store ${mime ? `"${mime}"` : "audio with no type"}; ` +
      "it keeps Opus in a WebM, Ogg or MP4 container",
  );
}

interface NoteRow {
  id: string;
  created_at: number;
  body: string | null;
  audio_path: string | null;
  audio_ms: number | null;
  prompted: number;
}

function listNotes(db: Db, limit: number): WorkNoteWire[] {
  return db.prepare(
    "SELECT id, created_at, body, audio_path, audio_ms, prompted FROM work_note" +
      " ORDER BY created_at DESC LIMIT ?",
  ).all(limit).map((r) => {
    const row = r as unknown as NoteRow;
    return {
      id: row.id,
      createdAt: Number(row.created_at),
      ...(row.body ? { body: row.body } : {}),
      ...(row.audio_ms === null ? {} : { audioMs: Number(row.audio_ms) }),
      // Spread twice over, so an unknown container leaves the field *absent* rather than present
      // and undefined — the wire type says optional, and `"audioType" in note` is a question the
      // device is entitled to ask.
      ...(row.audio_path && typeOf(row.audio_path) ? { audioType: typeOf(row.audio_path) } : {}),
      prompted: row.prompted === 1,
    };
  });
}

/**
 * The container a stored note is in, or `undefined` when the name does not say.
 *
 * 27.33 — this returned `"audio/ogg"` for anything it did not recognise. Every file this server
 * writes is named by `extensionFor`, which now refuses what it cannot name, so the only way here
 * is a file from an older build or one somebody put there — and for those, "I do not know" is the
 * true answer. The device leaves the type off the blob and lets the browser sniff it, which is
 * what a browser is good at and what a wrong type prevents.
 */
function typeOf(path: string): string | undefined {
  if (path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  if (path.endsWith(".webm")) return "audio/webm";
  return undefined;
}

export { transact };
