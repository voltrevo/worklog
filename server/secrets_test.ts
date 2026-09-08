/**
 * What must never turn up in the log, and what must never be reusable (20.2, 20.10, 13.31).
 *
 * These two properties have something awkward in common: **the code satisfies them by not doing
 * something**, so there is no line to point at and nothing breaks when they stop holding. A
 * `ctx.log` call added six months from now with a config object in its details is an ordinary,
 * reasonable-looking commit that silently puts bank details in a table any admin can read (12.11).
 *
 * So this drives a wide slice of the server — authenticate, configure payment details, record work,
 * invoice it, write a note, provoke a refusal — and then reads the whole log back and asserts that
 * none of the secrets it was handed appear anywhere in it. A sweep rather than a per-call check,
 * because the failure will arrive in a call nobody thought to test.
 */

import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1";
import { exportPublicKey, generateDeviceKey, signClaim } from "@worklog/shared/auth";
import {
  fromBase64,
  type HelloResult,
  type Request,
  toBase64,
  toWireClaim,
} from "@worklog/shared/protocol";
import { open } from "./db.ts";
import { ChallengeStore } from "./access.ts";
import { setConfig } from "./config.ts";
import { loggerFor, query as queryLogs } from "./logs.ts";
import { PromptHub } from "./prompts.ts";
import { authorize, handle, type ServerContext, type Session } from "./rpc.ts";
import { Refused } from "./work.ts";

const NOW = 1_788_000_000_000;
const CERT = "uEiAKk40R8i7tHdB16Wy7YZ2jiZqU-FZrigOcCq3jEYuMtA";

/**
 * Distinctive enough that a substring search cannot miss them and cannot match by chance.
 *
 * Fictional, per 20.7 — there is no such bank, and the account number is not a valid one.
 */
const SECRETS = {
  payBsb: "123-987-ZZQ",
  payAccountNumber: "ACCT-0000-SECRET-4242",
  payBank: "Bank of Nowhere In Particular",
  payName: "A Fictional Payee",
};

function context(): ServerContext {
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", { rateMinor: 7500, currency: "AUD", teamProject: "Research" }, NOW);
  return {
    db,
    challenges: new ChallengeStore(),
    hub: new PromptHub(),
    log: loggerFor(db),
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

async function device() {
  const pair = await generateDeviceKey();
  return { pair, publicKey: await exportPublicKey(pair) };
}

interface Claimed {
  signature: string;
  challenge: string;
  publicKey: string;
}

/** hello, then a signed claim. Returns the material that must not be reusable or logged. */
async function claimAdmin(
  ctx: ServerContext,
  s: Session,
  dev: { pair: CryptoKeyPair; publicKey: Uint8Array },
): Promise<Claimed> {
  const hello = await call(ctx, s, { t: "hello" }) as HelloResult;
  const claim = {
    purpose: "claim" as const,
    deviceName: "Studio Desktop",
    role: "admin" as const,
    publicKey: dev.publicKey,
    timestamp: NOW,
    challenge: fromBase64(hello.challenge),
    serverCertHash: hello.serverCertHash,
  };
  const signature = toBase64(await signClaim(claim, dev.pair.privateKey));
  await call(ctx, s, { t: "claim-admin", claim: toWireClaim(claim), signature });
  return { signature, challenge: hello.challenge, publicKey: toBase64(dev.publicKey) };
}

/** Every log line the server has, as one string. Admin, so nothing is filtered out (12.17). */
function wholeLog(ctx: ServerContext): string {
  const entries = queryLogs(ctx.db, { admin: true, limit: 10_000, minLevel: "debug" });
  assertNotEquals(entries.length, 0, "an empty log would pass every assertion below");
  return JSON.stringify(entries);
}

Deno.test("20.2/20.10 -- nothing secret reaches the log, across a wide slice of the server", async () => {
  const ctx = context();
  const s = session(ctx, "a");
  const dev = await device();
  const proof = await claimAdmin(ctx, s, dev);

  // 20.10's strongest form, and the reason there is no "is the key in the log?" search below: the
  // key *cannot* be logged, because it cannot be read. `generateDeviceKey` asks for
  // `extractable: false`, and Ed25519 honours that for the private half while still letting the
  // public half out. Asserting the refusal is worth more than grepping for a string, because a
  // string search only fails once somebody has already found a way to produce the string.
  await assertRejects(
    () => crypto.subtle.exportKey("pkcs8", dev.pair.privateKey),
    DOMException,
    "not extractable",
  );

  await call(ctx, s, { t: "config-set", section: "invoice", value: { ...SECRETS } });
  await call(ctx, s, {
    t: "timer-start",
    billingTag: "Feature development",
    date: "2026-09-08",
  });
  await call(ctx, s, { t: "timer-stop" });
  await call(ctx, s, {
    t: "entry-add",
    date: "2026-09-01",
    durationMs: 3_600_000,
    billingTag: "Feature development",
  });
  await call(ctx, s, {
    t: "invoice-save",
    period: "2026-09",
    clock: { today: "2026-09-08", nowMinutes: 600 },
  });
  await call(ctx, s, { t: "note-add", body: "a note", prompted: false });
  await call(ctx, s, {
    t: "client-error",
    message: "TypeError: something",
    context: { where: "render:Invoices" },
  });

  // A refusal too: the error paths are the ones that log most freely, and the most tempting thing
  // to attach to a failure is the request that caused it.
  await assertRejects(() => call(ctx, s, { t: "invoice-pdf", id: "nope" }), Refused);

  const log = wholeLog(ctx);
  for (const [field, value] of Object.entries(SECRETS)) {
    assertEquals(log.includes(value), false, `${field} appeared in the log`);
  }
  assertEquals(log.includes(proof.signature), false, "an auth signature appeared in the log");
  assertEquals(log.includes(proof.challenge), false, "an auth challenge appeared in the log");

  ctx.db.close();
});

Deno.test("13.31 -- a challenge is fresh each time, and a used one cannot be replayed", async () => {
  const ctx = context();
  const first = await call(ctx, session(ctx, "a"), { t: "hello" }) as HelloResult;
  const second = await call(ctx, session(ctx, "b"), { t: "hello" }) as HelloResult;
  assertNotEquals(first.challenge, second.challenge, "two hellos handed out the same challenge");

  // Spend one, then present the same signed claim again from a new connection. This is the whole
  // point of a challenge: possession of a valid signature must not be enough a second time.
  const s = session(ctx, "c");
  const dev = await device();
  const used = await claimAdmin(ctx, s, dev);

  const replayClaim = {
    purpose: "auth" as const,
    deviceName: "Studio Desktop",
    role: "admin" as const,
    publicKey: dev.publicKey,
    timestamp: NOW,
    challenge: fromBase64(used.challenge),
    serverCertHash: CERT,
  };
  const signature = toBase64(await signClaim(replayClaim, dev.pair.privateKey));
  // The reason, not just the refusal: an `authenticate` can fail for half a dozen causes, and a
  // test that accepts any of them would keep passing if challenges stopped being consumed and
  // something else happened to reject this.
  const err = await assertRejects(
    () =>
      call(ctx, session(ctx, "d"), {
        t: "authenticate",
        claim: toWireClaim(replayClaim),
        signature,
      }),
    Refused,
  );
  assertEquals(
    (err as Refused).code,
    "unknown-or-used-challenge",
    "refused, but not for having spent the challenge",
  );

  ctx.db.close();
});

/**
 * 16.1–16.3, 16.7 — the device-local settings never leave the device.
 *
 * Read from the source rather than from a running server, because the property is about what the
 * code is *capable* of. In the desktop window the runtime already enforces it: that build takes no
 * `--allow-net`, so the shell cannot reach a server whatever it is asked to do. The browser tab has
 * no such backstop — nothing stops a future `call({ t: "config-set", ... })` from carrying the
 * always-on-top preference along with everything else — and a test against a running server would
 * only prove that today's code does not do it today.
 *
 * So: these names may appear where the device keeps its own things, and nowhere the server can see.
 */
Deno.test({
  name: "16.2/16.7 -- device-local settings are unknown to the server and to the protocol",
  permissions: { read: ["."] },
  async fn() {
    const DEVICE_ONLY = [
      "worklog.serverAddress",
      "worklog.alwaysOnTop",
      "worklog.audio.enabled",
      "worklog.audio.volume",
    ];
    // `shared/` is included because the protocol lives there: a field on a `Request` is the server
    // being told, whether or not any caller fills it in yet.
    const root = new URL("..", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const dir of ["server", "shared"]) {
      for await (const entry of Deno.readDir(`${root}${dir}`)) {
        // Tests excluded, and this one in particular: the list of forbidden names is written out
        // above, so a scan that reads test files finds itself and reports four offences.
        if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith("_test.ts")) continue;
        const text = await Deno.readTextFile(`${root}${dir}/${entry.name}`);
        for (const key of DEVICE_ONLY) {
          if (text.includes(key)) offenders.push(`${dir}/${entry.name}: ${key}`);
        }
      }
    }
    assertEquals(offenders, [], "a device-local setting is named somewhere the server can reach");
  },
});
