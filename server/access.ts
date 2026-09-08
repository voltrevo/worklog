/**
 * Who is allowed to talk to this server, and how they prove it.
 *
 * The signature check lives in `shared/auth.ts`, because both ends need the same bytes. Everything
 * here is the part only a server can do: issuing challenges, remembering which it has issued,
 * refusing the stale and the replayed (13.24), and holding the device table.
 *
 * **A valid signature is the easy half.** The claim has to be fresh, aimed at *this* server, and
 * over a challenge this server issued and has not seen used. Those are separate checks on purpose —
 * a valid signature over a replayed challenge is still a valid signature.
 */

import {
  type AccessRole,
  type AuthClaim,
  type AuthPurpose,
  fingerprint,
  verifyClaim,
} from "@worklog/shared/auth";
import type { Instant } from "@worklog/shared/types";
import { type Db, transact } from "./db.ts";
import { Refused } from "./work.ts";

export type { AccessRole };
export { fingerprint };

/** 13.16 — short-lived. Long enough for a person to press a button, short enough to be useless. */
export const CHALLENGE_TTL_MS = 2 * 60_000;

/** How far a device's clock may differ from ours before its claim is refused (13.21, 13.24). */
export const CLOCK_SKEW_MS = 5 * 60_000;

export interface Device {
  publicKey: Uint8Array;
  name: string;
  role: AccessRole;
  authorizedAt: Instant;
  lastSeenAt?: Instant;
}

export interface PendingRequest {
  publicKey: Uint8Array;
  name: string;
  requestedRole: AccessRole;
  requestedAt: Instant;
  /** 13.26 — what the admin queue shows instead of a wall of base64. */
  fingerprint: string;
}

/**
 * Challenges live in memory, not in SQLite.
 *
 * They are worthless after two minutes and must not survive a restart: a challenge that outlived
 * the process it was issued by is one an attacker has had unbounded time to collect. Losing the
 * outstanding ones on restart costs a retry.
 */
export class ChallengeStore {
  #issued = new Map<string, { at: Instant }>();

  issue(now: Instant = Date.now()): Uint8Array {
    this.#sweep(now);
    const bytes = crypto.getRandomValues(new Uint8Array(32)); // 13.15
    this.#issued.set(hex(bytes), { at: now });
    return bytes;
  }

  /** True exactly once per challenge, and only inside its window (13.16). */
  consume(challenge: Uint8Array, now: Instant = Date.now()): boolean {
    this.#sweep(now);
    const key = hex(challenge);
    const found = this.#issued.get(key);
    if (!found) return false;
    this.#issued.delete(key); // single-use, whatever happens next
    return now - found.at <= CHALLENGE_TTL_MS;
  }

  get size(): number {
    return this.#issued.size;
  }

  #sweep(now: Instant): void {
    for (const [k, v] of this.#issued) {
      if (now - v.at > CHALLENGE_TTL_MS) this.#issued.delete(k);
    }
  }
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ the device table

function toDevice(row: {
  public_key: Uint8Array;
  name: string;
  role: string;
  authorized_at: number;
  last_seen_at: number | null;
}): Device {
  return {
    publicKey: new Uint8Array(row.public_key),
    name: row.name,
    role: row.role as AccessRole,
    authorizedAt: Number(row.authorized_at),
    ...(row.last_seen_at === null ? {} : { lastSeenAt: Number(row.last_seen_at) }),
  };
}

export function listDevices(db: Db): Device[] {
  return db.prepare(
    "SELECT public_key, name, role, authorized_at, last_seen_at FROM device ORDER BY authorized_at",
  ).all().map((r) => toDevice(r as never));
}

export function findDevice(db: Db, publicKey: Uint8Array): Device | undefined {
  const row = db.prepare(
    "SELECT public_key, name, role, authorized_at, last_seen_at FROM device WHERE public_key = ?",
  ).get(publicKey);
  return row ? toDevice(row as never) : undefined;
}

export function deviceCount(db: Db): number {
  return Number((db.prepare("SELECT count(*) c FROM device").get() as { c: number }).c);
}

export function listPending(db: Db): PendingRequest[] {
  return db.prepare(
    "SELECT public_key, name, requested_role, requested_at FROM access_request ORDER BY requested_at",
  ).all().map((r) => {
    const row = r as unknown as {
      public_key: Uint8Array;
      name: string;
      requested_role: string;
      requested_at: number;
    };
    const publicKey = new Uint8Array(row.public_key);
    return {
      publicKey,
      name: row.name,
      requestedRole: row.requested_role as AccessRole,
      requestedAt: Number(row.requested_at),
      fingerprint: fingerprint(publicKey),
    };
  });
}

// ------------------------------------------------------------------ verifying a claim

export interface VerifyContext {
  db: Db;
  challenges: ChallengeStore;
  /** This server's KPS certificate hash, which the claim must name (13.23). */
  serverCertHash: string;
  now?: Instant;
}

export type ClaimRefusal =
  | "bad-signature"
  | "unknown-or-used-challenge"
  | "wrong-server"
  | "clock-too-far-off"
  | "bad-key-length";

/**
 * Every check 13.24 asks for, in the order that fails cheapest first.
 *
 * The challenge is consumed **before** the signature is checked, so a wrong signature still burns
 * it. Otherwise a captured challenge could be attacked offline, one guess per request, with the
 * challenge staying live throughout.
 */
export async function checkClaim(
  ctx: VerifyContext,
  claim: AuthClaim,
  signature: Uint8Array,
): Promise<{ ok: true } | { ok: false; reason: ClaimRefusal }> {
  const now = ctx.now ?? Date.now();

  if (claim.publicKey.length !== 32) return { ok: false, reason: "bad-key-length" };
  if (claim.serverCertHash !== ctx.serverCertHash) return { ok: false, reason: "wrong-server" };
  if (Math.abs(now - claim.timestamp) > CLOCK_SKEW_MS) {
    return { ok: false, reason: "clock-too-far-off" };
  }
  if (!ctx.challenges.consume(claim.challenge, now)) {
    return { ok: false, reason: "unknown-or-used-challenge" };
  }
  if (!await verifyClaim(claim, signature)) return { ok: false, reason: "bad-signature" };
  return { ok: true };
}

// ------------------------------------------------------------------ the three entry points

export interface ClaimOutcome {
  outcome: "admin-granted" | "request-recorded" | "already-authorized";
  role?: AccessRole;
}

/**
 * 13.6–13.10 — the first device claims admin, and only while there is not one already.
 *
 * The race 13.39 settles is decided here rather than in the frontend: the check and the insert are
 * one transaction, so a second claimant arriving a millisecond later is refused rather than
 * becoming a second admin. 13.40 then has the frontend fall back to asking.
 *
 * There is no separate bootstrap secret because the KPS address already is one (13.41) — reaching
 * this code at all requires an `<ip>:<port>:<certhash>` nobody has published.
 */
export function claimAdmin(db: Db, claim: AuthClaim, now: Instant = Date.now()): ClaimOutcome {
  return transact(db, () => {
    const existing = findDevice(db, claim.publicKey);
    if (existing) return { outcome: "already-authorized", role: existing.role };
    if (deviceCount(db) > 0) {
      throw new Refused("already-claimed", "this server already has an authorized device");
    }
    db.prepare(
      "INSERT INTO device (public_key, name, role, authorized_at) VALUES (?, ?, 'admin', ?)",
    )
      .run(claim.publicKey, claim.deviceName, now);
    db.prepare("DELETE FROM access_request WHERE public_key = ?").run(claim.publicKey);
    return { outcome: "admin-granted", role: "admin" };
  });
}

/** 13.11–13.14 — record the ask. Nothing is granted; an admin decides (13.27, 13.28). */
export function requestAccess(db: Db, claim: AuthClaim, now: Instant = Date.now()): ClaimOutcome {
  return transact(db, () => {
    const existing = findDevice(db, claim.publicKey);
    if (existing) return { outcome: "already-authorized", role: existing.role };
    db.prepare(
      `INSERT INTO access_request (public_key, name, requested_role, requested_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (public_key) DO UPDATE SET name = excluded.name,
                                              requested_role = excluded.requested_role,
                                              requested_at = excluded.requested_at`,
    ).run(claim.publicKey, claim.deviceName, claim.role, now);
    return { outcome: "request-recorded" };
  });
}

/** 13.27, 13.28 — the admin's decision, and only the role the admin chose. */
export function approve(
  db: Db,
  publicKey: Uint8Array,
  role: AccessRole,
  now: Instant = Date.now(),
): Device {
  return transact(db, () => {
    const pending = db.prepare("SELECT name FROM access_request WHERE public_key = ?")
      .get(publicKey) as { name: string } | undefined;
    if (!pending) throw new Refused("no-such-request", "no pending request for that key");
    db.prepare(
      `INSERT INTO device (public_key, name, role, authorized_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (public_key) DO UPDATE SET name = excluded.name, role = excluded.role`,
    ).run(publicKey, pending.name, role, now);
    db.prepare("DELETE FROM access_request WHERE public_key = ?").run(publicKey);
    const device = findDevice(db, publicKey);
    if (!device) throw new Error("approve inserted nothing");
    return device;
  });
}

export function deny(db: Db, publicKey: Uint8Array): boolean {
  return db.prepare("DELETE FROM access_request WHERE public_key = ?").run(publicKey).changes > 0;
}

/** 13.36 */
export function revoke(db: Db, publicKey: Uint8Array): boolean {
  return db.prepare("DELETE FROM device WHERE public_key = ?").run(publicKey).changes > 0;
}

/** 13.37 */
export function setRole(db: Db, publicKey: Uint8Array, role: AccessRole): Device {
  const changed = db.prepare("UPDATE device SET role = ? WHERE public_key = ?")
    .run(role, publicKey).changes;
  if (!changed) throw new Refused("no-such-device", "no authorized device with that key");
  return findDevice(db, publicKey)!;
}

export function touchDevice(db: Db, publicKey: Uint8Array, now: Instant = Date.now()): void {
  db.prepare("UPDATE device SET last_seen_at = ? WHERE public_key = ?").run(now, publicKey);
}

// ------------------------------------------------------------------ what a role may do

/**
 * 13.32–13.34, as an ordering rather than a set of cases.
 *
 * `admin` includes `write` includes `read`, so a handler asks for the least it needs and the
 * comparison does the rest — which is one place to be wrong instead of one per handler.
 */
const RANK: Record<AccessRole, number> = { read: 0, write: 1, admin: 2 };

export function allows(held: AccessRole, needed: AccessRole): boolean {
  return RANK[held] >= RANK[needed];
}

/** Which purpose a device in this state should be offered: 13.7's label, or 13.11's. */
export function purposeFor(db: Db, publicKey: Uint8Array): AuthPurpose {
  if (findDevice(db, publicKey)) return "auth";
  return deviceCount(db) === 0 ? "claim" : "request";
}
