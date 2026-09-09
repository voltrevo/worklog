/**
 * The protocol client, shared by both frontends and both presentations (1.14, 1.19).
 *
 * **The transport is injected.** Nothing here imports KPS, so the same client drives a real WebRTC
 * connection in a browser and a direct function call in a test — which is how the handshake below
 * gets exercised without a socket. `kps-transport.ts` supplies the real one.
 *
 * **Signing is an interface, not a key.** In a browser tab the signer is a non-extractable
 * `CryptoKey` — Ed25519 honours `extractable: false` for the private half while still letting the
 * public half out, so 13.4 and 20.5 are things the key *cannot do* rather than rules this code
 * follows. In the desktop window it is a file the operating system protects, and the page asks the
 * shell to sign rather than holding anything. Either way `WorklogClient` never sees key material.
 */

import {
  type AccessRole,
  type AuthClaim,
  authMessage,
  type AuthPurpose,
  exportPublicKey,
  generateDeviceKey,
} from "./auth.ts";
import {
  decodeJson,
  encodeJson,
  type Event,
  fromBase64,
  type HelloResult,
  PROTOCOL_VERSION,
  type Request,
  type Response,
  splitLines,
  toBase64,
  toWireClaim,
} from "./protocol.ts";

/** One request, one stream. `subscribe` is the long-lived exception. */
export interface Transport {
  request(payload: Uint8Array): Promise<Uint8Array>;
  openStream(payload: Uint8Array, onChunk: (text: string) => void): Promise<void>;
  close(): void;
}

/** Where the device key lives between visits (13.3). */
export interface DeviceKeyStore {
  load(): Promise<CryptoKeyPair | undefined>;
  save(pair: CryptoKeyPair): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Something that can prove it is this device (13.2, 13.30).
 *
 * The whole of what the client needs: a public key to name itself by, and the ability to sign. It
 * deliberately cannot hand back a private key, which is what lets the desktop keep one in a file
 * and the browser keep one the page cannot read.
 */
export interface Signer {
  publicKey(): Promise<Uint8Array>;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** The browser's: a non-extractable Ed25519 pair, made once and kept (13.2, 13.3). */
export function webCryptoSigner(keys: DeviceKeyStore): Signer {
  let pair: CryptoKeyPair | undefined;
  const load = async () => {
    if (pair) return pair;
    pair = await keys.load() ?? await (async () => {
      const made = await generateDeviceKey();
      await keys.save(made);
      return made;
    })();
    return pair;
  };
  return {
    publicKey: async () => await exportPublicKey(await load()),
    sign: async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          (await load()).privateKey,
          message as BufferSource,
        ),
      ),
  };
}

/** A refusal from the server, carrying the code the UI branches on. */
export class ServerRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ServerRefusal";
  }
}

/**
 * Where the real one lives: `web/src/deviceKeys.ts`.
 *
 * IndexedDB is the only store that can hold a `CryptoKey` as a key rather than as bytes, which is
 * what keeps a non-extractable key non-extractable across a reload — serialising it would mean
 * exporting it, and an exportable key is one an XSS can steal. But it is a browser API, and this
 * module's whole claim is that it imports no runtime. So the browser store is in the browser
 * package and arrives here as a `DeviceKeyStore`.
 */

/** For tests, and for a runtime with no IndexedDB. Loses the key on exit, which is right there. */
export function memoryKeyStore(): DeviceKeyStore {
  let held: CryptoKeyPair | undefined;
  return {
    load: () => Promise.resolve(held),
    save: (pair) => {
      held = pair;
      return Promise.resolve();
    },
    clear: () => {
      held = undefined;
      return Promise.resolve();
    },
  };
}

export interface ClientOptions {
  transport: Transport;
  signer: Signer;
  /** 13.12 — what this device calls itself. An untrusted display string at the far end (13.38). */
  deviceName: string;
  onEvent?: (event: Event) => void;
}

export interface ConnectionState {
  serverCertHash: string;
  version: string;
  offer: AuthPurpose;
  role?: AccessRole;
}

export class WorklogClient {
  #transport: Transport;
  #signer: Signer;
  #publicKey?: Uint8Array;
  #deviceName: string;
  #onEvent?: (event: Event) => void;
  #state?: ConnectionState;

  constructor(opts: ClientOptions) {
    this.#transport = opts.transport;
    this.#signer = opts.signer;
    this.#deviceName = opts.deviceName;
    if (opts.onEvent) this.#onEvent = opts.onEvent;
  }

  get state(): ConnectionState | undefined {
    return this.#state;
  }

  /** 13.2 — the same key on every visit, whoever is holding it. */
  async publicKey(): Promise<Uint8Array> {
    this.#publicKey ??= await this.#signer.publicKey();
    return this.#publicKey;
  }

  /** One round trip. Throws `ServerRefusal` for a refusal, rather than returning a union. */
  async call<T>(req: Request): Promise<T> {
    const raw = await this.#transport.request(encodeJson(req));
    const res = decodeJson<Response>(raw);
    if (!res.ok) throw new ServerRefusal(res.code, res.message);
    return res.result as T;
  }

  /** Fetch a fresh challenge and find out what this device should be offered (13.7 vs 13.11). */
  async hello(): Promise<HelloResult> {
    const hello = await this.call<HelloResult>({
      t: "hello",
      publicKey: toBase64(await this.publicKey()),
    });

    /*
     * The number the server has been sending since there was a protocol, which nothing read.
     *
     * `hello` carries `protocolVersion` for exactly one purpose — a frontend and a server that do
     * not agree about what the messages mean — and the field sat unused, so the mismatch it exists
     * to catch would have presented as requests failing for no stated reason. The frontend is a
     * *static site*: a browser holding yesterday's build against a server updated this morning is
     * the ordinary way this happens, and it is invisible from either end.
     *
     * Which way round it is decides what there is to do about it, so the message says.
     */
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      const behind = hello.protocolVersion > PROTOCOL_VERSION;
      throw new Error(
        `this app speaks version ${PROTOCOL_VERSION} of the worklog protocol and the server ` +
          `speaks ${hello.protocolVersion}. ` +
          (behind
            ? "Reload the page to pick up a newer build, or update the desktop app."
            : "The server is older than this app, so update the server."),
      );
    }

    this.#state = {
      serverCertHash: hello.serverCertHash,
      version: hello.version,
      offer: hello.offer,
      ...(hello.role ? { role: hello.role } : {}),
    };
    return hello;
  }

  async #signed(purpose: AuthPurpose, role: AccessRole, hello: HelloResult): Promise<{
    claim: AuthClaim;
    signature: string;
  }> {
    const publicKey = await this.publicKey();
    const claim: AuthClaim = {
      purpose,
      deviceName: this.#deviceName,
      role,
      publicKey,
      timestamp: Date.now(),
      challenge: fromBase64(hello.challenge),
      // 13.23 -- bound to the server that issued the challenge, so this proof is useless elsewhere.
      serverCertHash: hello.serverCertHash,
    };
    // The bytes are built here and signed elsewhere, so nothing in this file ever holds a key.
    return { claim, signature: toBase64(await this.#signer.sign(authMessage(claim))) };
  }

  /**
   * 13.6–13.9, with 13.40's fallback built in.
   *
   * A claim that loses the race comes back as `already-claimed`; rather than surfacing that as an
   * error the caller has to interpret, this reports which of the two happened, so the UI can move
   * straight to the Request access form with the name already filled in.
   */
  async claimAdmin(): Promise<{ outcome: "admin-granted" | "request-recorded" }> {
    const hello = await this.hello();
    const { claim, signature } = await this.#signed("claim", "admin", hello);
    try {
      const result = await this.call<{ outcome: string; role?: AccessRole }>({
        t: "claim-admin",
        claim: toWireClaim(claim),
        signature,
      });
      this.#state = { ...this.#state!, role: result.role ?? "admin", offer: "auth" };
      return { outcome: "admin-granted" };
    } catch (err) {
      if (!(err instanceof ServerRefusal) || err.code !== "already-claimed") throw err;
      await this.requestAccess("admin");
      return { outcome: "request-recorded" };
    }
  }

  /** 13.11–13.13 */
  async requestAccess(role: AccessRole): Promise<void> {
    const hello = await this.hello();
    const { claim, signature } = await this.#signed("request", role, hello);
    await this.call({ t: "request-access", claim: toWireClaim(claim), signature });
  }

  /** 13.30, 13.31 — prove possession on this connection, with a challenge issued for it. */
  async authenticate(): Promise<{ role: AccessRole; name: string }> {
    const hello = await this.hello();
    const { claim, signature } = await this.#signed("auth", "read", hello);
    const result = await this.call<{ role: AccessRole; name: string }>({
      t: "authenticate",
      claim: toWireClaim(claim),
      signature,
    });
    this.#state = { ...this.#state!, role: result.role, offer: "auth" };
    return result;
  }

  /**
   * Open the event stream (1.12, 1.13).
   *
   * The chunk boundary is not the event boundary, so a partial line is held over rather than
   * parsed — dropping the tail would lose events at random and read as a flaky server.
   */
  async subscribe(): Promise<void> {
    let buffered = "";
    await this.#transport.openStream(encodeJson({ t: "subscribe" } satisfies Request), (text) => {
      buffered += text;
      const { lines, rest } = splitLines(buffered);
      buffered = rest;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Response | Event;
          // Told apart by shape rather than by position. The acknowledgement of the subscribe is
          // the first line and nothing else on this stream carries `ok`, but keying on the index
          // meant this loop had an opinion about framing -- and the framing was wrong for a while
          // without this noticing, because a line it cannot parse is silently one event lost.
          if ("e" in parsed) this.#onEvent?.(parsed);
        } catch {
          // A line we cannot parse is one event lost, not a reason to tear the stream down.
        }
      }
    });
  }

  close(): void {
    this.#transport.close();
  }
}
