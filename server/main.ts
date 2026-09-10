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
  MAX_REQUEST_BYTES,
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
 * The bound is `MAX_REQUEST_BYTES` in `shared/protocol.ts`, where the recorder can also read it —
 * a voice note is the one request that can approach a megabyte, and finding the limit by being
 * refused after five minutes of talking is not finding it in time.
 */

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

/**
 * The data directory belongs to whoever runs the server (27.54).
 *
 * Everything sensitive this product has is in here. The database holds the payment block —
 * `payBsb`, `payAccountNumber`, `payBank` — which `SENSITIVE_INVOICE_FIELDS` goes to some trouble
 * to keep off the wire and out of every log; `invoices/` holds PDFs with those same details
 * printed on them; `notes/` holds recordings of somebody's voice. SQLite and `Deno.writeFile`
 * create files at 0666 less the umask, which on an ordinary box is 0644 — readable by every
 * account on the machine. The KPS library already writes its private key at 0600, which is what
 * made the rest look wrong by comparison.
 *
 * Best effort and never fatal: `chmod` does not exist on Windows, a directory somebody has
 * deliberately shared is their business, and none of this is a reason to refuse to start. It runs
 * on every boot rather than only at creation, so a file restored from a backup with loose modes
 * is tightened the next time the server comes up.
 */
async function tighten(dataDir: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  const paths = [dataDir, join(dataDir, "notes"), join(dataDir, "invoices")];
  for (const dir of paths) {
    await Deno.chmod(dir, 0o700).catch(() => {});
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) await Deno.chmod(join(dir, entry.name), 0o600).catch(() => {});
    }
  }
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

  /*
   * After the listener, not before it: KPS writes the certificate and the key on first start, and
   * tightening before that missed them both on the one boot where they are created. It writes the
   * *key* at 0600 itself and leaves the certificate at the umask, which on this machine is 0666 —
   * world-writable, for the file that pins the server's identity.
   */
  await tighten(args.data);

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
      /*
       * 12.4 — said out loud, because until now it was not said anywhere.
       *
       * A failed *signature* is logged in `rpc.ts`; a request refused for want of authority was
       * refused in silence. That is the one an administrator most wants to see — a device asking
       * for things it has not been granted, or one whose session has gone — and 12.10 exists to
       * put the log in front of them. The client is expected not to ask, so anything here is
       * either a device that has lost its footing or something worth looking at.
       */
      ctx.log("warn", "access", `refused a ${req.t}`, { reason: verdict.code });
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
/** 27.30 — one warning per run about prompts enabled with no interval; see the poll loop. */
let warnedAboutInterval = false;

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

    /*
     * 27.30 — on, with no cadence. `setConfig` refuses to write that state, but a database written
     * before that rule can hold it, and `poll(null)` would read as "never fire": a switch that
     * says prompts are on and no prompt ever arriving.
     *
     * Said once, at warning level, rather than every two seconds — this loop runs for as long as
     * the server does, and a line per poll would bury the log it is trying to appear in.
     */
    if (cfg.meanIntervalMs === null) {
      if (!warnedAboutInterval) {
        warnedAboutInterval = true;
        ctx.log(
          "warn",
          "prompts",
          "prompts are switched on with no interval set, so none will fire; set one in Settings",
        );
      }
      return;
    }

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

/**
 * 27.26 — a missing permission says which one, and what to do about it.
 *
 * The scoped flags of 27.25 buy safety at the price of a new way to fail: run with `--data`
 * somewhere the flags do not name and Deno raises `NotCapable` from whichever call happened to
 * touch the disk first. What that printed was `Requires write access to ".tmp/x", run again with
 * the --allow-write flag` — true, and it names neither the directory that was asked for nor the
 * fact that a *read* flag is needed too, so the obvious next attempt fails again on the other one.
 *
 * The exit code is 2, as for an unknown argument: this is a problem with how the process was
 * started, not a crash.
 */
function explainPermission(err: unknown, data: string): boolean {
  if (!(err instanceof Deno.errors.NotCapable)) return false;
  console.error(`worklog: not allowed to use the data directory ${data}.`);
  console.error("");
  console.error("  The server runs with permissions scoped to ./data. For another directory:");
  console.error("");
  console.error(
    `    deno run --node-modules-dir=manual --allow-read=${data},./node_modules \\`,
  );
  console.error(
    `      --allow-write=${data} --allow-net --allow-sys=networkInterfaces \\`,
  );
  console.error(
    `      --allow-ffi=./node_modules server/main.ts --data ${data}`,
  );
  console.error("");
  console.error(`  Deno said: ${(err as Error).message}`);
  return true;
}

if (import.meta.main) {
  // Parsed here as well as in `main`, because the message above needs the directory and the
  // failure that produces it happens before `main` has anything to hand back.
  const data = parseArgs(Deno.args).data;
  await main().catch((err) => {
    if (explainPermission(err, data)) Deno.exit(2);
    console.error(`worklog: ${(err as Error).message}`);
    console.error(`  in ${dirname(new URL(import.meta.url).pathname)}`);
    Deno.exit(1);
  });
}
