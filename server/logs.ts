/**
 * Structured server logs, and the rules about who may read what (section 12).
 *
 * **Redaction happens on the way out, not on the way in.** An admin needs the detail that makes a
 * failure diagnosable, so throwing it away at write time would cost the thing logs are for. What
 * 12.11 and 12.17 ask for is that a *non-admin* not see it, which is a property of the read.
 *
 * 12.15 is the harder one, and it is not a filter — it is that nothing here is ever handed a bank
 * detail or a key in the first place. `paymentDetails` never leaves `config.ts` on a read path, and
 * a private key never reaches this process at all (13.4). The deny-list below is the second line,
 * for the day someone logs a whole config object by accident.
 */

import type { Instant } from "@worklog/shared/types";
import type { Db } from "./db.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  id: number;
  at: Instant;
  level: LogLevel;
  /** 12.3 — which subsystem, e.g. `timer`, `invoice`, `access`, `holidays`, `client`. */
  source: string;
  message: string;
  context?: Record<string, unknown>;
  /** 12.7 — the authenticated device this came from, as a fingerprint rather than a raw key. */
  deviceFingerprint?: string;
}

/**
 * Keys whose values never appear in a log, at any level, for anyone.
 *
 * Matched case-insensitively against the whole key, so `clientPaymentDetails` is caught as well as
 * `paymentDetails`. Deliberately broad: a false positive costs one redacted field in a diagnostic,
 * a false negative puts bank details in a file that gets pasted into an issue.
 */
const NEVER_LOG = [
  "paymentdetails",
  "bank",
  "bsb",
  "iban",
  "accountnumber",
  "privatekey",
  "secret",
  "password",
  "token",
  "apikey",
  "authorization",
];

/** Extra keys withheld from a non-admin reader (12.11, 12.17), on top of `NEVER_LOG`. */
const ADMIN_ONLY = ["stack", "cause", "sql", "path", "config", "address", "abn", "email"];

function scrub(
  value: unknown,
  deny: readonly string[],
  depth = 0,
): unknown {
  if (depth > 6) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, deny, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      out[k] = deny.some((d) => key.includes(d)) ? "[redacted]" : scrub(v, deny, depth + 1);
    }
    return out;
  }
  return value;
}

/** Applied at write time. This is the set nobody sees, ever. */
export function scrubForStorage(context: Record<string, unknown>): Record<string, unknown> {
  return scrub(context, NEVER_LOG) as Record<string, unknown>;
}

/** Applied on read for a device that is not an admin. */
export function scrubForReader(context: Record<string, unknown>): Record<string, unknown> {
  return scrub(context, [...NEVER_LOG, ...ADMIN_ONLY]) as Record<string, unknown>;
}

export interface Logger {
  (level: LogLevel, source: string, message: string, context?: Record<string, unknown>): void;
}

export interface AppendOptions {
  level: LogLevel;
  source: string;
  message: string;
  context?: Record<string, unknown>;
  deviceKey?: Uint8Array;
  now?: Instant;
}

export function append(db: Db, opts: AppendOptions): void {
  db.prepare(
    "INSERT INTO log (at, level, source, message, context_json, device_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    opts.now ?? Date.now(),
    opts.level,
    opts.source,
    opts.message,
    opts.context ? JSON.stringify(scrubForStorage(opts.context)) : null,
    opts.deviceKey ?? null,
  );
}

/** A `Logger` bound to one database, which is what the rest of the server is handed. */
export function loggerFor(db: Db): Logger {
  return (level, source, message, context) => append(db, { level, source, message, context });
}

export interface QueryOptions {
  /** 12.12 — this level and above. */
  minLevel?: LogLevel;
  from?: Instant;
  /** Exclusive, so a range is half-open like everything else here. */
  to?: Instant;
  source?: string;
  limit?: number;
  /** False for a `read` or `write` device; true only for an admin (12.11, 12.17). */
  admin: boolean;
}

export function query(db: Db, opts: QueryOptions): LogEntry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.minLevel) {
    const allowed = (Object.keys(RANK) as LogLevel[]).filter((l) =>
      RANK[l] >= RANK[opts.minLevel!]
    );
    where.push(`level IN (${allowed.map(() => "?").join(", ")})`);
    args.push(...allowed);
  }
  if (opts.from !== undefined) {
    where.push("at >= ?");
    args.push(opts.from);
  }
  if (opts.to !== undefined) {
    where.push("at < ?");
    args.push(opts.to);
  }
  if (opts.source) {
    where.push("source = ?");
    args.push(opts.source);
  }
  const sql = `SELECT id, at, level, source, message, context_json, device_key FROM log
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY at DESC, id DESC LIMIT ?`;
  args.push(opts.limit ?? 200);

  return db.prepare(sql).all(...args).map((r) => {
    const row = r as unknown as {
      id: number;
      at: number;
      level: string;
      source: string;
      message: string;
      context_json: string | null;
      device_key: Uint8Array | null;
    };
    let context: Record<string, unknown> | undefined;
    if (row.context_json) {
      try {
        const parsed = JSON.parse(row.context_json) as Record<string, unknown>;
        context = opts.admin ? parsed : scrubForReader(parsed);
      } catch {
        context = { unparseable: true };
      }
    }
    return {
      id: Number(row.id),
      at: Number(row.at),
      level: row.level as LogLevel,
      source: row.source,
      message: row.message,
      ...(context ? { context } : {}),
      ...(row.device_key
        ? { deviceFingerprint: fingerprintOf(new Uint8Array(row.device_key)) }
        : {}),
    };
  });
}

function fingerprintOf(key: Uint8Array): string {
  return [...key.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(":");
}

/**
 * 12.13 — bounded retention, by age and by count.
 *
 * Both, because either alone fails: an age bound lets a crash loop write a million rows in an hour,
 * and a count bound alone keeps a year of silence forever. Returns how many rows went, so the prune
 * itself can be logged when it did something.
 */
export function prune(
  db: Db,
  opts: { keepDays?: number; keepRows?: number; now?: Instant } = {},
): number {
  const now = opts.now ?? Date.now();
  const keepDays = opts.keepDays ?? 30;
  const keepRows = opts.keepRows ?? 50_000;
  // `changes` is `number | bigint`, so both are narrowed before they are added.
  const byAge = Number(
    db.prepare("DELETE FROM log WHERE at < ?").run(now - keepDays * 86_400_000).changes,
  );
  const byCount = Number(
    db.prepare(
      "DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY at DESC, id DESC LIMIT ?)",
    ).run(keepRows).changes,
  );
  return byAge + byCount;
}
