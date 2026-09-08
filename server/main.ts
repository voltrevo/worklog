/**
 * The process: a KPS listener, a database, and the loops.
 *
 * **Everything KPS-shaped is in this file.** `rpc.ts` takes a parsed request and returns a value,
 * so the transport can be swapped, tested around, or replaced when the QUIC-stream fault in
 * `@kpstreams/server` is fixed, without touching a handler.
 *
 *     deno task serve --port 41108 --data ./data
 *
 * The address it prints is the whole of what a frontend needs (22.1, 22.2), and it is not published
 * anywhere: reaching this server requires being told the certhash, which is also what gates the
 * admin claim (13.41).
 */

import { listen } from "npm:@kpstreams/server@^0.2.1";
import { dirname, join } from "jsr:@std/path@^1";
import {
  decodeJson,
  encodeEvent,
  encodeJson,
  type Event,
  type Request,
  type Response,
} from "@worklog/shared/protocol";
import { open } from "./db.ts";
import { encodeSubscribeAck } from "./framing.ts";
import { ChallengeStore } from "./access.ts";
import { getConfig } from "./config.ts";
import { append, loggerFor, prune } from "./logs.ts";
import { POLL_INTERVAL_MS, PromptHub, PromptScheduler } from "./prompts.ts";
import { authorize, handle, type ServerContext, type Session } from "./rpc.ts";
import { activeTimer, Refused } from "./work.ts";

const VERSION = "0.1.0";

interface Args {
  port: number;
  data: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 41108, data: "./data" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--data") args.data = String(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("usage: deno task serve [--port 41108] [--data ./data]");
      Deno.exit(0);
    } else {
      console.error(`worklog: unknown argument ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

/**
 * Read a whole stream. One request per stream, so EOF is the delimiter (see `protocol.ts`).
 *
 * Bounded, because a stream is an unauthenticated peer's chance to make this process allocate. A
 * megabyte is far more than any request needs and far less than anything worth worrying about.
 */
const MAX_REQUEST_BYTES = 1_048_576;

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readable) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  await Deno.mkdir(args.data, { recursive: true });
  await Deno.mkdir(join(args.data, "notes"), { recursive: true });
  await Deno.mkdir(join(args.data, "invoices"), { recursive: true });

  const db = open({ path: join(args.data, "worklog.sqlite") });
  const log = loggerFor(db);

  const listener = await listen({
    port: args.port,
    certPath: join(args.data, "kps-cert.pem"),
    keyPath: join(args.data, "kps-key.pem"),
  });

  const ctx: ServerContext = {
    db,
    challenges: new ChallengeStore(),
    hub: new PromptHub((reason) =>
      append(db, { level: "warn", source: "prompt", message: reason })
    ),
    log,
    dataDir: args.data,
    serverCertHash: listener.certhash,
    version: VERSION,
    sessions: new Map(),
  };

  log("info", "server", "listening", { port: args.port, data: args.data });
  console.log(`worklog ${VERSION} — give a frontend this address:\n`);
  for (const ip of localAddresses()) console.log(`    ${listener.address(ip)}`);
  console.log("\nIt is the only way in, so treat it as a secret until a device is authorized.\n");

  startPromptLoop(ctx);
  startPruneLoop(ctx);

  for (;;) {
    const conn = await listener.accept();
    void serveConnection(ctx, conn);
  }
}

/** Whatever this machine can be dialled on, so the printed address is usable rather than `0.0.0.0`. */
function localAddresses(): string[] {
  const out: string[] = [];
  for (const nic of Deno.networkInterfaces()) {
    if (nic.family !== "IPv4" || nic.address.startsWith("127.")) continue;
    out.push(nic.address);
  }
  return out.length ? out : ["127.0.0.1"];
}

type KpsConnection = Awaited<ReturnType<Awaited<ReturnType<typeof listen>>["accept"]>>;

async function serveConnection(ctx: ServerContext, conn: KpsConnection): Promise<void> {
  const session: Session = { id: crypto.randomUUID(), authenticated: false };
  ctx.sessions.set(session.id, session);
  try {
    for (;;) {
      const stream = await conn.acceptStream();
      void serveStream(ctx, session, stream);
    }
  } catch {
    // The connection ended. Every stream on it is finished with too.
  } finally {
    ctx.sessions.delete(session.id);
    ctx.hub.remove(session.id);
  }
}

type KpsStream = Awaited<ReturnType<KpsConnection["acceptStream"]>>;

async function serveStream(ctx: ServerContext, session: Session, stream: KpsStream): Promise<void> {
  const writer = stream.writable.getWriter();
  let req: Request | undefined;
  try {
    req = decodeJson<Request>(await readAll(stream.readable));

    const verdict = authorize(session, req.t);
    if (!verdict.ok) {
      await writer.write(encodeJson(verdict satisfies Response));
      await writer.close();
      return;
    }

    const result = await handle(ctx, session, req);

    if (req.t === "subscribe") {
      // 1.12, 1.13 -- the response is followed by events until the stream goes away, so from here
      // the stream is line-delimited and the acknowledgement is the first line. It used to go out
      // through `encodeJson` like every other response, with no newline, so it and the first event
      // arrived as one unparseable string and that event was dropped. See `framing.ts`.
      await writer.write(encodeSubscribeAck({ ok: true, result } satisfies Response));

      // The push closure is what `broadcast` reaches; failures there mark the session for removal.
      session.push = (event: Event) => {
        writer.write(encodeEvent(event)).catch(() => {
          delete session.push;
          ctx.hub.remove(session.id);
        });
      };
      ctx.hub.add({
        id: session.id,
        deliver: (e) => session.push?.({ e: "prompt", id: e.id, firedAt: e.firedAt }),
      });
      return; // deliberately left open
    }

    // Every other request: one bare JSON body, with the closing of the write half as the delimiter.
    await writer.write(encodeJson({ ok: true, result } satisfies Response));
    await writer.close();
  } catch (err) {
    const response: Response = err instanceof Refused
      ? { ok: false, code: err.code, message: err.message }
      : { ok: false, code: "internal", message: "the server could not complete that request" };
    if (!(err instanceof Refused)) {
      ctx.log("error", "rpc", `${req?.t ?? "unparsed"} failed`, {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
    try {
      await writer.write(encodeJson(response));
      await writer.close();
    } catch {
      // The peer is gone; there is nobody to tell.
    }
  }
}

/**
 * 5.8, 5.9 — the server decides, ten seconds at a time, while a timer is running.
 *
 * The scheduler is told about the timer by *observing* it rather than by being called from the
 * handlers, so a timer started before this process did — the database outlives the process — is
 * picked up on the next tick rather than never.
 */
function startPromptLoop(ctx: ServerContext): void {
  const scheduler = new PromptScheduler();
  setInterval(() => {
    const timer = activeTimer(ctx.db);
    const cfg = getConfig(ctx.db, "prompt");

    if (!timer) {
      if (scheduler.running) scheduler.onTimerStopped(); // 5.13
      return;
    }
    if (!scheduler.running) scheduler.onTimerStarted(timer.startedAt);
    if (!cfg.enabled) return;

    if (scheduler.poll(Date.now(), cfg.meanIntervalMs)) {
      // 5.15 -- one event per trigger. `fire` returns null when it was dropped (5.18).
      ctx.hub.fire(Date.now());
    }
  }, POLL_INTERVAL_MS);
}

/** 12.13 — retention, hourly, and quiet unless it did something. */
function startPruneLoop(ctx: ServerContext): void {
  setInterval(() => {
    const gone = prune(ctx.db);
    if (gone > 0) ctx.log("debug", "logs", `pruned ${gone} entries`);
  }, 3_600_000);
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(`worklog: ${(err as Error).message}`);
    console.error(`  in ${dirname(new URL(import.meta.url).pathname)}`);
    Deno.exit(1);
  });
}
