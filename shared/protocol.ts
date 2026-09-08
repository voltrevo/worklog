/**
 * The application protocol over KPS (1.15, 1.16).
 *
 * **One stream per request.** The client opens a KPS stream, writes one JSON object, closes its
 * write half, and reads one JSON object back; the stream ending *is* the end of the response, so
 * there is no length prefix, no framing layer and nothing to get out of sync. Concurrent requests
 * are concurrent streams, which is what KPS multiplexing is for — the alternative, a single
 * connection with request ids, would be reimplementing multiplexing on top of multiplexing.
 *
 * The exception is `subscribe`, which is one long-lived stream carrying newline-delimited events
 * (1.12, 1.13). It is a stream because it is genuinely a stream.
 *
 * **Authentication is per connection, not per request** (13.30). A device proves possession once,
 * on a fresh challenge, and every stream on that connection inherits it. Signing every request
 * would cost a round trip each time and prove nothing extra, since the connection is already
 * end-to-end encrypted and pinned to the server's certificate.
 *
 * Binary fields cross as base64, because this is JSON. `toAuthClaim` is the only place that
 * conversion happens, so the signed bytes are reconstructed identically on both sides.
 */

import type { AccessRole, AuthClaim, AuthPurpose } from "./auth.ts";
import type {
  DateString,
  DayInterval,
  Instant,
  PacingConfig,
  PacingOverride,
  WorkEntry,
} from "./types.ts";
import type { Pacing } from "./pacing.ts";
import type { InvoiceDraft, InvoiceSnapshot, InvoiceWarning } from "./invoice.ts";

export const PROTOCOL_VERSION = 1;

// ------------------------------------------------------------------ base64

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** An `AuthClaim` with its binary fields base64'd, which is what goes on the wire. */
export interface WireClaim {
  purpose: AuthPurpose;
  deviceName: string;
  role: AccessRole;
  publicKey: string;
  timestamp: number;
  challenge: string;
  serverCertHash: string;
}

export function toWireClaim(claim: AuthClaim): WireClaim {
  return {
    ...claim,
    publicKey: toBase64(claim.publicKey),
    challenge: toBase64(claim.challenge),
  };
}

export function toAuthClaim(wire: WireClaim): AuthClaim {
  return {
    ...wire,
    publicKey: fromBase64(wire.publicKey),
    challenge: fromBase64(wire.challenge),
  };
}

// ------------------------------------------------------------------ requests

/** Where "now" is, according to the asking device (3.9, 6.38). Never inferred by the server. */
export interface Clock {
  today: DateString;
  nowMinutes: number;
}

export type Request =
  /**
   * Unauthenticated. Returns a fresh challenge and what this device should be offered.
   *
   * `publicKey` is a *hint*, and the server treats it as one: on a new connection nothing has been
   * proved yet, so without it the server cannot tell a returning device from a new one and would
   * show "Claim admin" on every reload. It decides which button to draw and nothing else — the
   * claim that follows still has to be signed.
   */
  | { t: "hello"; publicKey?: string }
  | { t: "claim-admin"; claim: WireClaim; signature: string }
  | { t: "request-access"; claim: WireClaim; signature: string }
  | { t: "authenticate"; claim: WireClaim; signature: string }
  /** Everything the main screen needs, in one round trip. */
  | { t: "snapshot"; month: string; clock: Clock }
  | { t: "timer-start"; billingTag: string; date: DateString }
  | { t: "timer-stop" }
  /** 24.10 — correct a running timer's tag without stopping it. */
  | { t: "timer-retag"; billingTag: string }
  | { t: "timer-discard" }
  | { t: "entries"; month: string }
  | {
    t: "entry-add";
    date: DateString;
    durationMs: number;
    billingTag: string;
    timing?: { startedAt: Instant; endedAt: Instant };
  }
  | {
    t: "entry-update";
    id: string;
    date?: DateString;
    durationMs?: number;
    billingTag?: string;
    timing?: { startedAt: Instant; endedAt: Instant } | null;
  }
  | { t: "entry-delete"; id: string }
  /**
   * 5.1-5.5, 5.22-5.25 — a work-detail note, in text, in audio, or in both.
   *
   * The audio arrives base64'd in the request rather than on a stream of its own. A note is a
   * minute of speech at 24 kbit/s — under 200 kB — and one round trip is worth more here than the
   * bytes saved by a second protocol for one field.
   */
  | {
    t: "note-add";
    body?: string;
    audioBase64?: string;
    audioMs?: number;
    /** Whether this answers a prompt (5.6) or was written unprompted (5.4). */
    prompted?: boolean;
    /** The recording's container and codec, as the browser reported them. */
    audioType?: string;
  }
  | { t: "notes"; limit?: number }
  /** 5.28 — the recording back, for playing. */
  | { t: "note-audio"; id: string }
  /** 24.6 — a note is deletable; the recording goes with it. */
  | { t: "note-delete"; id: string }
  | { t: "invoices" }
  | {
    t: "invoice-save";
    period: string;
    teamProject?: string;
    bonusMinor?: number;
    number?: string;
    clock: Clock;
  }
  | { t: "invoice-issue"; id: string }
  | { t: "invoice-mark-paid"; id: string }
  | { t: "invoice-unmark-paid"; id: string }
  | { t: "invoice-revert-issue"; id: string }
  | { t: "invoice-pdf"; id: string }
  | { t: "config-get" }
  | { t: "config-set"; section: "pacing" | "invoice" | "prompt"; value: Record<string, unknown> }
  | { t: "override-set"; date: DateString; interval: DayInterval; reason?: string }
  | { t: "override-delete"; date: DateString }
  | {
    t: "logs";
    minLevel?: "debug" | "info" | "warn" | "error";
    from?: Instant;
    to?: Instant;
    source?: string;
    limit?: number;
  }
  /** 12.6 — a frontend reporting its own failure. */
  | { t: "client-error"; message: string; context?: Record<string, unknown> }
  | { t: "access-pending" }
  | { t: "access-devices" }
  | { t: "access-approve"; publicKey: string; role: AccessRole }
  | { t: "access-deny"; publicKey: string }
  | { t: "access-revoke"; publicKey: string }
  | { t: "access-set-role"; publicKey: string; role: AccessRole }
  /** Opens the event stream. The response is followed by newline-delimited `Event`s. */
  | { t: "subscribe" };

// ------------------------------------------------------------------ responses

export interface HelloResult {
  protocolVersion: number;
  serverCertHash: string;
  /** 13.15 — fresh, single-use, and what the next request must sign over. */
  challenge: string;
  /** Whether this device is unknown, would be the first, or is already authorized. */
  offer: AuthPurpose;
  role?: AccessRole;
  /** 18.3 */
  version: string;
}

export interface TimerState {
  active?: { startedAt: Instant; date: DateString; billingTag: string };
  /** 2.16 — long enough to be worth questioning. The server states it; the UI decides how loud. */
  implausible: boolean;
}

export interface SnapshotResult {
  timer: TimerState;
  /** 3.1 — the entries the home screen sums for today. */
  today: WorkEntry[];
  month: string;
  entries: WorkEntry[];
  pacing: Pacing;
  /**
   * 6.36 — why the holiday data is what it is, when it is not simply current.
   *
   * The holidays themselves are not here: `pacing.holidays` already carries the ones that shaped
   * *this month*, which is what 6.37 asks for. A second, year-wide list beside it was a duplicate
   * source of truth, and the first test to read it believed September had eleven of them.
   */
  holidayWarning?: string;
  recentTags: string[];
  invoiceWarnings: InvoiceWarning[];
  pacingConfig: PacingConfig;
  /** 6.19, 6.20 — the pacing-only adjustments in this month. Never billable records. */
  overrides: PacingOverride[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 12.1-12.3, as the log viewer receives it. Context is already redacted for the reader (12.17). */
export interface LogEntry {
  id: number;
  at: Instant;
  level: LogLevel;
  source: string;
  message: string;
  context?: Record<string, unknown>;
  /** 12.7 — a fingerprint rather than a key, because the viewer only needs to tell devices apart. */
  deviceFingerprint?: string;
}

export interface WorkNoteWire {
  id: string;
  createdAt: Instant;
  body?: string;
  /** Present when there is a recording; the bytes come separately, via `note-audio`. */
  audioMs?: number;
  audioType?: string;
  prompted: boolean;
}

export interface StoredInvoiceWire {
  id: string;
  period: string;
  number: string;
  status: "draft" | "issued" | "paid";
  draft: InvoiceDraft;
  snapshot?: InvoiceSnapshot;
  pdfPath?: string;
  issuedAt?: Instant;
  paidAt?: Instant;
}

/**
 * 8.33 — what `invoice-pdf` answers with.
 *
 * Two copies of the same document, deliberately. `path` is the canonical one the server keeps
 * (17.11, 11.18) and is the only one that survives the request; `pdfBase64` is the one the person
 * who pressed the button gets, because that person is very often not sitting at the server.
 */
export interface InvoicePdfResult {
  /** Relative to the server's data directory. Not a path the caller can open. */
  path: string;
  bytes: number;
  /** Sanitised from the invoice number, so the caller does not have to invent one. */
  fileName: string;
  pdfBase64: string;
  invoice: StoredInvoiceWire;
}

export type Response =
  | { ok: true; result: unknown }
  /** A refusal on the merits, with a code the UI can branch on and a sentence it can show. */
  | { ok: false; code: string; message: string };

// ------------------------------------------------------------------ events

/**
 * 1.12, 1.13 — what the server pushes.
 *
 * Coarse on purpose. `changed` names an area and the client refetches, rather than the server
 * shipping deltas that both sides then have to agree how to apply. The exception is `prompt`, which
 * carries its own payload because there is nothing to refetch: it is the event.
 */
export type Event =
  | { e: "timer"; timer: TimerState }
  | { e: "changed"; area: "entries" | "invoices" | "config" | "access" | "notes" | "logs" }
  | { e: "prompt"; id: string; firedAt: Instant }
  | { e: "access-granted"; role: AccessRole }
  | { e: "access-revoked" };

// ------------------------------------------------------------------ encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

/** One event per line, so a reader can split without knowing how long the next one is. */
export function encodeEvent(event: Event): Uint8Array {
  return encoder.encode(JSON.stringify(event) + "\n");
}

/**
 * Split whatever has arrived into whole lines, returning the remainder.
 *
 * The remainder matters: a chunk boundary lands mid-object often enough that dropping the tail
 * would lose events at random and look like a flaky server.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.length > 0), rest };
}

/** Which role a request needs. Anything absent here needs none (13.32–13.34). */
export const REQUIRED_ROLE: Partial<Record<Request["t"], AccessRole>> = {
  "snapshot": "read",
  "entries": "read",
  "notes": "read",
  "note-audio": "read",
  "invoices": "read",
  "config-get": "read",
  "logs": "read",
  "subscribe": "read",
  "client-error": "read",
  "invoice-pdf": "read",

  "timer-start": "write",
  "timer-stop": "write",
  "timer-retag": "write",
  "timer-discard": "write",
  "entry-add": "write",
  "entry-update": "write",
  "entry-delete": "write",
  "note-add": "write",
  "note-delete": "write",
  "invoice-save": "write",
  "invoice-issue": "write",
  "invoice-mark-paid": "write",
  "invoice-unmark-paid": "write",
  "invoice-revert-issue": "write",
  "config-set": "write",
  "override-set": "write",
  "override-delete": "write",

  "access-pending": "admin",
  "access-devices": "admin",
  "access-approve": "admin",
  "access-deny": "admin",
  "access-revoke": "admin",
  "access-set-role": "admin",
};
