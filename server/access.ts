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
  /** Set once the cap has been reached, so the log says it happened without saying it repeatedly. */
  #capped = false;

  /**
   * 27.37 — how many may be outstanding at once.
   *
   * The store's *lifetime* was bounded from the start and its *size* was not. `hello` is one of
   * the four requests that need no authentication — it has to be, since it is where a device gets
   * the challenge it will authenticate with — and it issues one on every call, so anything that
   * can reach this server can add an entry every time it asks. The sweep bounds that to two
   * minutes of traffic, which is a bound in the same sense that a bucket with a hole is.
   *
   * Reaching the server means knowing the address, which is the secret that gates everything here
   * (22.1), so this is a nuisance rather than a way in. Ten thousand is far above any real burst —
   * a person pressing a button makes one, a fleet of devices reconnecting after an outage makes
   * one each — and far below anything that troubles the process.
   */
  static readonly MAX_OUTSTANDING = 10_000;

  /**
   * The cap is a constructor argument so a test can reach it in fifty iterations rather than ten
   * thousand — and so raising the default cannot make that test slower. The first version derived
   * its own workload from `MAX_OUTSTANDING`, so mutating the constant to check the test could fail
   * turned it into ten million calls to `getRandomValues` and hung the run.
   */
  constructor(readonly max: number = ChallengeStore.MAX_OUTSTANDING) {}

  issue(now: Instant = Date.now(), onCap?: (message: string) => void): Uint8Array {
    this.#sweep(now);
    /*
     * Evict the oldest rather than refuse the newest.
     *
     * Both bound the memory and both are reachable by whoever is flooding. Refusing would let them
     * stop a legitimate device from getting a challenge at all; evicting costs that device one
     * retry, because the challenge it is holding may be gone by the time it answers. Insertion
     * order is issue order, so the first key is the oldest.
     */
    while (this.#issued.size >= this.max) {
      const oldest = this.#issued.keys().next().value;
      if (oldest === undefined) break;
      this.#issued.delete(oldest);
      if (!this.#capped) {
        this.#capped = true;
        onCap?.(
          `more than ${this.max} unanswered challenges are outstanding; ` +
            `discarding the oldest. Something is asking for them faster than anyone answers.`,
        );
      }
    }
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
/**
 * 26.15 — the server cannot be left with nobody who can administer it.
 *
 * Revoking the last admin, or demoting it, leaves a server where no device can approve another
 * one: 13.7's claim path is only offered while there are *no* authorised devices at all, so a
 * server with two `write` phones and no admin is not recoverable from any screen. The only way
 * back is editing the database by hand, which is not a thing this app should ever require.
 *
 * Checked here rather than in the UI because it is a property of the server's state, and because
 * the two devices involved may be different people looking at different screens.
 */
function lastAdmin(db: Db, publicKey: Uint8Array): boolean {
  const device = findDevice(db, publicKey);
  if (device?.role !== "admin") return false;
  const admins = db.prepare("SELECT count(*) AS n FROM device WHERE role = 'admin'")
    .get() as { n: number };
  return Number(admins.n) <= 1;
}

export function revoke(db: Db, publicKey: Uint8Array): boolean {
  if (lastAdmin(db, publicKey)) {
    throw new Refused(
      "last-admin",
      "that is the only administrator; make another device an admin first, or nothing will be " +
        "able to approve anything.",
    );
  }
  return db.prepare("DELETE FROM device WHERE public_key = ?").run(publicKey).changes > 0;
}

/** 13.37 */
export function setRole(db: Db, publicKey: Uint8Array, role: AccessRole): Device {
  if (role !== "admin" && lastAdmin(db, publicKey)) {
    throw new Refused(
      "last-admin",
      "that is the only administrator; make another device an admin first, or nothing will be " +
        "able to approve anything.",
    );
  }
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
