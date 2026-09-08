/**
 * The client and the server, wired to each other through a function call.
 *
 * The transport is a loopback: the client's bytes go straight into the dispatcher and the response
 * comes straight back. That is the whole point of injecting the transport — this exercises the real
 * handshake, the real signing, the real role checks and the real event stream, and the only thing
 * it does not exercise is the socket, which the browser test covers.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  decodeJson,
  encodeJson,
  type Event,
  type Request,
  type Response,
  type SnapshotResult,
  toBase64,
} from "@worklog/shared/protocol";
import {
  memoryKeyStore,
  ServerRefusal,
  type Transport,
  webCryptoSigner,
  WorklogClient,
} from "@worklog/shared/client";
import { open } from "./db.ts";
import { ChallengeStore } from "./access.ts";
import { setConfig } from "./config.ts";
import { loggerFor } from "./logs.ts";
import { PromptHub } from "./prompts.ts";
import { authorize, handle, type ServerContext, type Session } from "./rpc.ts";
import { Refused } from "./work.ts";

const NOW = 1_788_000_000_000;
const CLOCK = { today: "2026-09-08", nowMinutes: 10 * 60 };

function server(): ServerContext {
  const db = open({ path: ":memory:" });
  setConfig(db, "invoice", { rateMinor: 7500, currency: "AUD" }, NOW);
  return {
    db,
    challenges: new ChallengeStore(),
    hub: new PromptHub(),
    log: loggerFor(db),
    serverCertHash: "uEiEXAMPLEcerthashEXAMPLEcerthashEXAMPLEcertha",
    version: "0.0.0-test",
    sessions: new Map(),
    // The real clock: the client stamps its claims with `Date.now()`, and a frozen server clock
    // would put every one of them outside the skew window.
    offlineHolidays: true,
  };
}

/** One connection: one `Session`, and every request dispatched exactly as `main.ts` would. */
function loopback(ctx: ServerContext, id: string): Transport & { session: Session } {
  const session: Session = { id, authenticated: false };
  ctx.sessions.set(id, session);
  return {
    session,
    async request(payload) {
      const req = decodeJson<Request>(payload);
      const verdict = authorize(session, req.t);
      if (!verdict.ok) return encodeJson(verdict satisfies Response);
      try {
        return encodeJson({ ok: true, result: await handle(ctx, session, req) } satisfies Response);
      } catch (err) {
        const refusal = err as Refused;
        return encodeJson(
          {
            ok: false,
            code: refusal.code ?? "internal",
            message: refusal.message,
          } satisfies Response,
        );
      }
    },
    async openStream(payload, onChunk) {
      const req = decodeJson<Request>(payload);
      const verdict = authorize(session, req.t);
      if (!verdict.ok) {
        onChunk(JSON.stringify(verdict satisfies Response) + "\n");
        return;
      }
      onChunk(JSON.stringify({ ok: true, result: await handle(ctx, session, req) }) + "\n");
      session.push = (event: Event) => onChunk(JSON.stringify(event) + "\n");
    },
    close() {
      ctx.sessions.delete(id);
    },
  };
}

function client(ctx: ServerContext, id: string, deviceName: string) {
  const events: Event[] = [];
  const transport = loopback(ctx, id);
  const c = new WorklogClient({
    transport,
    signer: webCryptoSigner(memoryKeyStore()),
    deviceName,
    onEvent: (e) => events.push(e),
  });
  return { client: c, events, session: transport.session };
}

Deno.test("first run: the device makes a key, claims admin, and is authenticated", async () => {
  const ctx = server();
  const { client: a } = client(ctx, "a", "MacBook Pro");

  const hello = await a.hello();
  assertEquals(hello.offer, "claim");
  assertEquals(hello.protocolVersion, 1);

  const { outcome } = await a.claimAdmin();
  assertEquals(outcome, "admin-granted");
  assertEquals(a.state?.role, "admin");

  const snap = await a.call<SnapshotResult>({ t: "snapshot", month: "2026-09", clock: CLOCK });
  assertEquals(snap.month, "2026-09");
  ctx.db.close();
});

Deno.test("13.2 -- the key is reused across connections, so the device stays the same one", async () => {
  const ctx = server();
  // One store, two clients: the second is a reload, and has to be the same device.
  const keys = memoryKeyStore();
  const first = new WorklogClient({
    transport: loopback(ctx, "a"),
    signer: webCryptoSigner(keys),
    deviceName: "MacBook Pro",
  });
  await first.claimAdmin();
  const firstKey = toBase64(await first.publicKey());

  const second = new WorklogClient({
    transport: loopback(ctx, "b"),
    signer: webCryptoSigner(keys),
    deviceName: "MacBook Pro",
  });
  assertEquals(toBase64(await second.publicKey()), firstKey);
  assertEquals((await second.hello()).offer, "auth", "recognised without being told");
  assertEquals((await second.authenticate()).role, "admin");
  ctx.db.close();
});

Deno.test("13.4/20.5 -- the browser's device key cannot be exported, by us or by anything else", async () => {
  // The client itself no longer holds a key -- it holds a `Signer` -- so this reaches past it to
  // the store the browser signer uses, which is where the guarantee actually lives.
  const keys = memoryKeyStore();
  const signer = webCryptoSigner(keys);
  await signer.publicKey();
  const pair = (await keys.load())!;

  assertEquals(pair.privateKey.extractable, false);
  await assertRejects(() => crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // ...while the public half still exports, which is what makes a non-extractable pair usable.
  assertEquals(pair.publicKey.extractable, true);
});

Deno.test("a client can be given any signer, which is how the desktop keeps its key in a file", async () => {
  // The desktop's signer is the shell, over an IPC binding. Nothing about `WorklogClient` knows
  // that, and this proves it by handing it a signer made of two plain functions.
  const ctx = server();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const elsewhere = {
    publicKey: async () => new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    sign: async (m: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, m as BufferSource),
      ),
  };
  const c = new WorklogClient({
    transport: loopback(ctx, "a"),
    signer: elsewhere,
    deviceName: "Studio Desktop",
  });
  assertEquals((await c.claimAdmin()).outcome, "admin-granted");
  ctx.db.close();
});

Deno.test("13.40 -- losing the claim race turns into a request without the caller noticing", async () => {
  const ctx = server();
  const { client: a } = client(ctx, "a", "MacBook Pro");
  await a.claimAdmin();

  const { client: b } = client(ctx, "b", "Windows Laptop");
  const { outcome } = await b.claimAdmin();
  assertEquals(outcome, "request-recorded", "it asked instead, on the same connection");

  const pending = await a.call<Array<{ name: string; requestedRole: string }>>({
    t: "access-pending",
  });
  assertEquals(pending.length, 1);
  assertEquals(pending[0]?.name, "Windows Laptop");
  ctx.db.close();
});

Deno.test("a refusal arrives as a code the UI can branch on, not a string to match", async () => {
  const ctx = server();
  const { client: a } = client(ctx, "a", "MacBook Pro");
  await a.claimAdmin();
  await assertRejects(
    () => a.call({ t: "timer-stop" }),
    ServerRefusal,
    "no timer is running",
  );
  try {
    await a.call({ t: "timer-stop" });
  } catch (err) {
    assertEquals((err as ServerRefusal).code, "no-timer-running");
  }
  ctx.db.close();
});

Deno.test("1.12 -- an event pushed by the server reaches the subscribed client", async () => {
  const ctx = server();
  const { client: a, events: aEvents } = client(ctx, "a", "MacBook Pro");
  await a.claimAdmin();
  await a.subscribe();
  aEvents.length = 0;

  await a.call({ t: "timer-start", billingTag: "Product Development", date: "2026-09-08" });
  assertEquals(aEvents.some((e) => e.e === "timer" && e.timer.active !== undefined), true);

  await a.call({ t: "timer-stop" });
  assertEquals(aEvents.some((e) => e.e === "changed" && e.area === "entries"), true);
  ctx.db.close();
});

Deno.test("the subscribe acknowledgement is not delivered as an event", async () => {
  // The first line of that stream is a `Response`, not an `Event`. Handing it to the UI as one
  // would be a phantom update on every connect.
  const ctx = server();
  const { client: a, events } = client(ctx, "a", "MacBook Pro");
  await a.claimAdmin();
  await a.subscribe();
  assertEquals(events.length, 0);
  ctx.db.close();
});

Deno.test("a whole day of use, through the client", async () => {
  const ctx = server();
  const { client: a } = client(ctx, "a", "MacBook Pro");
  await a.claimAdmin();
  await a.subscribe();

  // Yesterday, remembered as a bare duration (2.10).
  await a.call({
    t: "entry-add",
    date: "2026-09-07",
    durationMs: 2 * 3_600_000,
    billingTag: "Admin",
  });
  // Today, timed.
  await a.call({ t: "timer-start", billingTag: "Product Development", date: "2026-09-08" });
  const stopped = await a.call<{ durationMs: number }>({ t: "timer-stop" });
  assertEquals(stopped.durationMs >= 0, true);

  const snap = await a.call<SnapshotResult>({ t: "snapshot", month: "2026-09", clock: CLOCK });
  assertEquals(snap.entries.length, 2);
  assertEquals(snap.today.length, 1, "3.1 -- only today's, for the home screen");
  assertEquals(snap.recentTags.includes("Admin"), true);
  assertEquals(snap.pacing.month, "2026-09");
  ctx.db.close();
});
