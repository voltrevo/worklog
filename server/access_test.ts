import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  type AuthClaim,
  authMessage,
  exportPublicKey,
  generateDeviceKey,
  signClaim,
  verifyClaim,
} from "@worklog/shared/auth";
import { type Db, open } from "./db.ts";
import {
  allows,
  approve,
  CHALLENGE_TTL_MS,
  ChallengeStore,
  checkClaim,
  claimAdmin,
  CLOCK_SKEW_MS,
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
import { Refused } from "./work.ts";

const NOW = 1_788_000_000_000;
const CERT = "uEiEXAMPLEcerthashEXAMPLEcerthashEXAMPLEcertha";

function fresh(): Db {
  return open({ path: ":memory:" });
}

/** An authorised device with a given role, straight into the table. */
async function authorized(db: Db, name: string, role: "read" | "write" | "admin") {
  const key = await exportPublicKey(await generateDeviceKey());
  db.prepare(
    "INSERT INTO device (public_key, name, role, authorized_at) VALUES (?, ?, ?, 1)",
  ).run(key, name, role);
  return key;
}

async function device() {
  const pair = await generateDeviceKey();
  return { pair, publicKey: await exportPublicKey(pair) };
}

function claimFor(
  publicKey: Uint8Array,
  challenge: Uint8Array,
  over: Partial<AuthClaim> = {},
): AuthClaim {
  return {
    purpose: "request",
    deviceName: "MacBook Pro",
    role: "write",
    publicKey,
    timestamp: NOW,
    challenge,
    serverCertHash: CERT,
    ...over,
  };
}

// ------------------------------------------------------------------ the signed bytes

Deno.test("13.18-13.23 -- every bound field changes the message", async () => {
  const { publicKey } = await device();
  const challenge = new Uint8Array(32).fill(7);
  const base = claimFor(publicKey, challenge);
  const baseline = authMessage(base);
  const same = (c: AuthClaim) =>
    authMessage(c).length === baseline.length && authMessage(c).every((b, i) => b === baseline[i]);

  assertEquals(same({ ...base }), true, "the same claim gives the same bytes");
  assertEquals(same({ ...base, deviceName: "iPad" }), false, "13.18");
  assertEquals(same({ ...base, role: "admin" }), false, "13.19");
  assertEquals(same({ ...base, publicKey: new Uint8Array(32).fill(1) }), false, "13.20");
  assertEquals(same({ ...base, timestamp: NOW + 1 }), false, "13.21");
  assertEquals(same({ ...base, challenge: new Uint8Array(32).fill(8) }), false, "13.22");
  assertEquals(same({ ...base, serverCertHash: "uEiSomethingElse" }), false, "13.23");
  assertEquals(same({ ...base, purpose: "claim" }), false, "and the purpose too");
});

Deno.test("length prefixes stop two field sets from encoding the same", async () => {
  // The reason for not concatenating plainly: "ab" + "c" and "a" + "bc" are the same bytes, so a
  // device could sign one name-and-role pair and have it read as another.
  const { publicKey } = await device();
  const ch = new Uint8Array(32).fill(7);
  const a = authMessage(claimFor(publicKey, ch, { deviceName: "ab", role: "read" }));
  const b = authMessage(claimFor(publicKey, ch, { deviceName: "a", role: "bread" as never }));
  assertEquals(a.length === b.length && a.every((x, i) => x === b[i]), false);
});

Deno.test("a signature verifies, and does not verify for anyone else's claim", async () => {
  const alice = await device();
  const mallory = await device();
  const ch = new Uint8Array(32).fill(7);
  const claim = claimFor(alice.publicKey, ch);
  const sig = await signClaim(claim, alice.pair.privateKey);

  assertEquals(await verifyClaim(claim, sig), true);
  assertEquals(await verifyClaim({ ...claim, role: "admin" }, sig), false, "escalation");
  assertEquals(await verifyClaim({ ...claim, deviceName: "Server Room PC" }, sig), false);
  assertEquals(
    await verifyClaim({ ...claim, publicKey: mallory.publicKey }, sig),
    false,
    "a claim naming another key is not signed by it",
  );
});

Deno.test("a malformed signature or key is refused rather than throwing", async () => {
  const alice = await device();
  const claim = claimFor(alice.publicKey, new Uint8Array(32).fill(7));
  assertEquals(await verifyClaim(claim, new Uint8Array(10)), false);
  assertEquals(
    await verifyClaim({ ...claim, publicKey: new Uint8Array(10) }, new Uint8Array(64)),
    false,
  );
});

// ------------------------------------------------------------------ challenges

Deno.test("13.15/13.16 -- a challenge is random, single-use and short-lived", () => {
  const store = new ChallengeStore();
  const a = store.issue(NOW);
  const b = store.issue(NOW);
  assertEquals(a.length, 32);
  assertEquals(a.every((x, i) => x === b[i]), false, "not the same twice");

  assertEquals(store.consume(a, NOW), true);
  assertEquals(store.consume(a, NOW), false, "single-use");

  const c = store.issue(NOW);
  assertEquals(store.consume(c, NOW + CHALLENGE_TTL_MS + 1), false, "expired");
});

Deno.test("a challenge nobody issued is refused", () => {
  const store = new ChallengeStore();
  assertEquals(store.consume(new Uint8Array(32).fill(9), NOW), false);
});

Deno.test("expired challenges are swept rather than accumulating", () => {
  const store = new ChallengeStore();
  for (let i = 0; i < 5; i++) store.issue(NOW);
  assertEquals(store.size, 5);
  store.issue(NOW + CHALLENGE_TTL_MS + 1);
  assertEquals(store.size, 1, "the old ones went with the sweep");
});

// ------------------------------------------------------------------ checkClaim

function ctxWith(now = NOW) {
  const db = fresh();
  const challenges = new ChallengeStore();
  return { db, challenges, serverCertHash: CERT, now };
}

Deno.test("13.24 -- a good claim passes every check", async () => {
  const ctx = ctxWith();
  const alice = await device();
  const claim = claimFor(alice.publicKey, ctx.challenges.issue(NOW));
  const sig = await signClaim(claim, alice.pair.privateKey);
  assertEquals(await checkClaim(ctx, claim, sig), { ok: true });
  ctx.db.close();
});

Deno.test("13.24 -- a replayed claim is refused the second time", async () => {
  const ctx = ctxWith();
  const alice = await device();
  const claim = claimFor(alice.publicKey, ctx.challenges.issue(NOW));
  const sig = await signClaim(claim, alice.pair.privateKey);
  assertEquals((await checkClaim(ctx, claim, sig)).ok, true);
  const again = await checkClaim(ctx, claim, sig);
  assertEquals(again.ok === false && again.reason, "unknown-or-used-challenge");
  ctx.db.close();
});

Deno.test("a wrong signature still burns the challenge", async () => {
  // Otherwise a captured challenge could be attacked offline, one guess per request, with the
  // challenge staying live throughout.
  const ctx = ctxWith();
  const alice = await device();
  const challenge = ctx.challenges.issue(NOW);
  const claim = claimFor(alice.publicKey, challenge);

  const bad = await checkClaim(ctx, claim, new Uint8Array(64));
  assertEquals(bad.ok === false && bad.reason, "bad-signature");

  const good = await signClaim(claim, alice.pair.privateKey);
  const retry = await checkClaim(ctx, claim, good);
  assertEquals(retry.ok === false && retry.reason, "unknown-or-used-challenge");
  ctx.db.close();
});

Deno.test("13.23 -- a claim aimed at another server is refused here", async () => {
  const ctx = ctxWith();
  const alice = await device();
  const claim = claimFor(alice.publicKey, ctx.challenges.issue(NOW), {
    serverCertHash: "uEiSomeOtherServer",
  });
  const sig = await signClaim(claim, alice.pair.privateKey);
  const verdict = await checkClaim(ctx, claim, sig);
  assertEquals(verdict.ok === false && verdict.reason, "wrong-server");
  assertEquals(ctx.challenges.size, 1, "and it did not even reach the challenge");
  ctx.db.close();
});

Deno.test("13.21 -- a clock too far out is refused, in either direction", async () => {
  const ctx = ctxWith();
  const alice = await device();
  for (const skew of [CLOCK_SKEW_MS + 1000, -(CLOCK_SKEW_MS + 1000)]) {
    const claim = claimFor(alice.publicKey, ctx.challenges.issue(NOW), { timestamp: NOW + skew });
    const sig = await signClaim(claim, alice.pair.privateKey);
    const verdict = await checkClaim(ctx, claim, sig);
    assertEquals(verdict.ok === false && verdict.reason, "clock-too-far-off", `skew ${skew}`);
  }
  ctx.db.close();
});

// ------------------------------------------------------------------ the lifecycle

Deno.test("13.6-13.10 -- the first device claims admin, and the second cannot", async () => {
  const db = fresh();
  const alice = await device();
  const bob = await device();

  assertEquals(purposeFor(db, alice.publicKey), "claim", "13.7 -- the label to show");
  assertEquals(claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW), {
    outcome: "admin-granted",
    role: "admin",
  });
  assertEquals(findDevice(db, alice.publicKey)?.role, "admin");

  // 13.10, 13.39 -- bootstrap is over, decided on the server.
  assertEquals(purposeFor(db, bob.publicKey), "request", "13.11 -- the label changes");
  assertThrows(
    () => claimAdmin(db, claimFor(bob.publicKey, new Uint8Array(32)), NOW),
    Refused,
    "already has an authorized device",
  );
  assertEquals(deviceCount(db), 1);
  db.close();
});

Deno.test("13.39 -- a claim that lost the race is refused, so the UI can fall back", async () => {
  // The pedantic case: two devices press "Claim admin" at once. The check and the insert are one
  // transaction, so the loser gets a refusal it can turn into 13.40's Request access form.
  const db = fresh();
  const alice = await device();
  const bob = await device();
  claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW);
  assertThrows(() => claimAdmin(db, claimFor(bob.publicKey, new Uint8Array(32)), NOW), Refused);
  assertEquals(purposeFor(db, bob.publicKey), "request");
  db.close();
});

Deno.test("re-claiming from the device that already won just says so", async () => {
  const db = fresh();
  const alice = await device();
  claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW);
  assertEquals(claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW), {
    outcome: "already-authorized",
    role: "admin",
  });
  db.close();
});

Deno.test("13.14/13.28 -- a request grants nothing until an admin says a role", async () => {
  const db = fresh();
  const alice = await device();
  const bob = await device();
  claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW);

  requestAccess(
    db,
    claimFor(bob.publicKey, new Uint8Array(32), {
      deviceName: "Windows Laptop",
      role: "admin",
    }),
    NOW,
  );
  assertEquals(findDevice(db, bob.publicKey), undefined, "13.14 -- nothing automatic");

  const pending = listPending(db);
  assertEquals(pending.length, 1);
  assertEquals(pending[0]?.name, "Windows Laptop");
  assertEquals(pending[0]?.requestedRole, "admin");
  assertEquals(pending[0]?.fingerprint.split(":").length, 8, "13.26 -- something to eyeball");

  // 13.28 -- the admin grants read, not the admin that was asked for.
  const granted = approve(db, bob.publicKey, "read", NOW + 1000);
  assertEquals(granted.role, "read");
  assertEquals(listPending(db).length, 0);
  db.close();
});

Deno.test("a repeated request updates the pending row rather than piling up", async () => {
  const db = fresh();
  const alice = await device();
  const bob = await device();
  claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW);
  requestAccess(db, claimFor(bob.publicKey, new Uint8Array(32), { role: "read" }), NOW);
  requestAccess(db, claimFor(bob.publicKey, new Uint8Array(32), { role: "write" }), NOW + 5);
  const pending = listPending(db);
  assertEquals(pending.length, 1);
  assertEquals(pending[0]?.requestedRole, "write");
  db.close();
});

Deno.test("approving something nobody asked for is refused", async () => {
  const db = fresh();
  const ghost = await device();
  assertThrows(() => approve(db, ghost.publicKey, "admin"), Refused, "no pending request");
  db.close();
});

Deno.test("13.35-13.37 -- an admin can list, deny, change a role and revoke", async () => {
  const db = fresh();
  const alice = await device();
  const bob = await device();
  const carol = await device();
  claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW);

  requestAccess(db, claimFor(bob.publicKey, new Uint8Array(32)), NOW);
  approve(db, bob.publicKey, "write", NOW);
  requestAccess(db, claimFor(carol.publicKey, new Uint8Array(32)), NOW);
  assertEquals(deny(db, carol.publicKey), true);
  assertEquals(listPending(db).length, 0);

  assertEquals(listDevices(db).length, 2);
  assertEquals(setRole(db, bob.publicKey, "admin").role, "admin");
  assertEquals(revoke(db, bob.publicKey), true);
  assertEquals(listDevices(db).length, 1);
  assertEquals(revoke(db, bob.publicKey), false, "revoking twice says nothing changed");
  assertThrows(() => setRole(db, bob.publicKey, "read"), Refused);
  db.close();
});

Deno.test("13.30 -- an authorized device is offered the auth purpose, not a claim", async () => {
  const db = fresh();
  const alice = await device();
  claimAdmin(db, claimFor(alice.publicKey, new Uint8Array(32)), NOW);
  assertEquals(purposeFor(db, alice.publicKey), "auth");
  touchDevice(db, alice.publicKey, NOW + 9999);
  assertEquals(findDevice(db, alice.publicKey)?.lastSeenAt, NOW + 9999);
  db.close();
});

Deno.test("13.32-13.34 -- the roles are ordered, so a handler asks for the least it needs", () => {
  assertEquals(allows("admin", "read"), true);
  assertEquals(allows("admin", "write"), true);
  assertEquals(allows("admin", "admin"), true);
  assertEquals(allows("write", "read"), true);
  assertEquals(allows("write", "write"), true);
  assertEquals(allows("write", "admin"), false);
  assertEquals(allows("read", "read"), true);
  assertEquals(allows("read", "write"), false);
  assertEquals(allows("read", "admin"), false);
});

Deno.test("26.15 -- the last admin cannot be revoked or demoted", async () => {
  /*
   * Both left a server nobody can administer. 13.7 only offers the claim path while there are *no*
   * authorised devices, so a server with two `write` phones and no admin is unrecoverable from any
   * screen in the app — the way back is editing the database by hand.
   */
  const db = fresh();
  const solo = await authorized(db, "Studio Desktop", "admin");

  assertThrows(() => revoke(db, solo), Refused, "only administrator");
  assertThrows(() => setRole(db, solo, "write"), Refused, "only administrator");
  assertThrows(() => setRole(db, solo, "read"), Refused, "only administrator");
  assertEquals(findDevice(db, solo)?.role, "admin", "one of those went through anyway");

  // With a second admin, both become ordinary operations again.
  const second = await authorized(db, "Studio Laptop", "admin");
  assertEquals(setRole(db, solo, "write").role, "write");

  // ...and the rule follows the role rather than the device: `second` is now the only admin, so
  // it is protected in its turn. My first version of this test revoked it here and was refused,
  // correctly — the sequence was wrong, not the guard.
  assertThrows(() => revoke(db, second), Refused, "only administrator");

  // Promote the first one back and the second becomes revocable again.
  assertEquals(setRole(db, solo, "admin").role, "admin");
  assertEquals(revoke(db, second), true);
  assertEquals(deviceCount(db), 1);
  db.close();
});

Deno.test("and a device that is not an admin is not protected by the rule", () => {
  // The guard is about the *role*, not about being the only device. A lone `write` device can be
  // revoked: that leaves a server with nothing authorised, which 13.7 recovers from by offering
  // the claim again.
  const db = fresh();
  const key = new Uint8Array(32).fill(9);
  db.prepare(
    "INSERT INTO device (public_key, name, role, authorized_at) VALUES (?, ?, 'write', 1)",
  ).run(key, "A Phone");
  assertEquals(revoke(db, key), true);
  assertEquals(deviceCount(db), 0);
  db.close();
});
