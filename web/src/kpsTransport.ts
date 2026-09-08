/**
 * The real transport: a KPS connection, one stream per request.
 *
 * This is the only file in the frontend that knows KPS exists. `WorklogClient` takes a `Transport`,
 * so the same client runs against this in a browser and against a direct call in a test.
 *
 * Both frontends land here. The GitHub Pages tab dials over WebRTC (1.5), and so does the Deno
 * Desktop window — its shell is a webview, so it is a browser too, which is why there is one
 * transport rather than two.
 */

import { dial } from "@kpstreams/webrtc-client";
import type { Transport } from "@worklog/shared/client";

type Conn = Awaited<ReturnType<typeof dial>>;

export interface KpsTransport extends Transport {
  /** Resolves when the connection goes away, so the UI can show it and try again (22.7, 22.8). */
  readonly closed: Promise<void>;
}

export async function connect(
  address: string,
  signal?: AbortSignal,
): Promise<KpsTransport> {
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
