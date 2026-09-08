/**
 * The real transport: a KPS connection, one stream per request.
 *
 * This is the only file in the frontend that knows KPS exists. `WorklogClient` takes a `Transport`,
 * so the same client runs against this in a browser and against a direct call in a test.
 *
 * Both frontends land here. The GitHub Pages tab dials over WebRTC (1.5), and so does the Deno
 * Desktop window — its shell is a webview, so it is a browser too, which is why there is one
 * transport rather than two.
 *
 * That last sentence has a catch, which `requireWebRTC` exists to say out loud: a webview is a
 * browser only to the extent that it was built like one, and WebRTC is a build option. WebKitGTK
 * compiled without it has no `RTCPeerConnection` at all — not a broken one, an absent one.
 */

import { dial } from "@kpstreams/webrtc-client";
import type { Transport } from "@worklog/shared/client";

type Conn = Awaited<ReturnType<typeof dial>>;

export interface KpsTransport extends Transport {
  /** Resolves when the connection goes away, so the UI can show it and try again (22.7, 22.8). */
  readonly closed: Promise<void>;
}

/**
 * Fail with a sentence rather than with `Can't find variable: RTCPeerConnection`.
 *
 * The engine's own message is accurate and useless: it names a variable, which suggests a bug in
 * this code, when the truth is that the browser this is running in cannot do WebRTC at all and no
 * amount of retrying or re-pasting the address will change that. The distinction matters most in
 * the desktop window, where there is no console to look at and the only thing the person sees is
 * whatever this throw becomes.
 */
/**
 * 24.38 — say why a plain-HTTP page cannot work, before anything tries to sign.
 *
 * `crypto.subtle` is only defined in a secure context, which means HTTPS or localhost. Served over
 * plain HTTP from any other host it is simply `undefined`, and the first thing to notice is
 * `generateDeviceKey`, deep inside the connect flow, throwing about a property of undefined. The
 * cause — the URL you typed — is nowhere in that message.
 *
 * Checked here rather than at startup because it is only fatal when connecting: the page renders
 * fine, and a banner on a screen that works is its own kind of noise.
 */
function requireSecureContext(): void {
  if (typeof crypto !== "undefined" && crypto.subtle) return;
  throw new Error(
    "this page has no Web Crypto, so it cannot hold a device key. Browsers only provide it over " +
      "HTTPS or on localhost — serve the frontend over HTTPS, or open it at 127.0.0.1.",
  );
}

function requireWebRTC(): void {
  if (typeof RTCPeerConnection !== "undefined") return;
  throw new Error(
    "this browser has no WebRTC, so it cannot reach a worklog server. In the desktop window that " +
      "means the webview was built without it; in a tab, that the browser has it disabled.",
  );
}

export async function connect(
  address: string,
  signal?: AbortSignal,
): Promise<KpsTransport> {
  requireSecureContext();
  requireWebRTC();
  const conn: Conn = await dial(address.trim(), signal ? { signal } : {});
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  void (conn as unknown as { closed?: Promise<unknown> }).closed?.then(
    closedResolve,
    closedResolve,
  );

  return {
    closed,

    async request(payload) {
      const stream = await conn.openStream();
      const writer = stream.writable.getWriter();
      await writer.write(payload);
      // Closing the write half is the delimiter -- see `protocol.ts`. Without it the server would
      // wait for bytes that are never coming.
      await writer.close();

      const reader = stream.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.length;
        }
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },

    async openStream(payload, onChunk) {
      const stream = await conn.openStream();
      const writer = stream.writable.getWriter();
      await writer.write(payload);
      // The write half closes; the read half stays open for as long as the server keeps pushing.
      await writer.close();

      const reader = stream.readable.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) onChunk(decoder.decode(value, { stream: true }));
          }
        } catch {
          // The stream ended, which is what closing a connection looks like from here.
        } finally {
          closedResolve();
        }
      })();
    },

    close() {
      try {
        conn.close();
      } catch {
        // Already gone.
      }
      closedResolve();
    },
  };
}
