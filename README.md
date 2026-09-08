# Worklog

Self-hosted work time tracking and invoicing. A Deno server holds the truth in SQLite; a React
frontend reaches it over [KPS](https://github.com/ethereum/kps) — from a Deno Desktop window or from
a static page on GitHub Pages, both dialling the same `<ip>:<port>:<certhash>` address.

Nothing is built yet. [`REQUIREMENTS.md`](REQUIREMENTS.md) is the specification, and it is
**append-only**: items keep their numbers forever, superseded ones are struck through rather than
edited, and new sections are added rather than folded into old ones. That is what makes a reference
to `6.10` safe to write down and never revisit.

## Spikes

Two questions could invalidate the architecture, so they were asked before anything was built.

### Can `deno desktop` set always-on-top? — **yes**

Section 15 stands. The runtime carries `deno_runtime::ops::desktop::BrowserWindow`, whose method
table includes `setAlwaysOnTop` and `isAlwaysOnTop`, and its window-creation options include
`alwaysOnTop` alongside `frameless`, `noActivate`, `resizable` and `transparentTitlebar`. `deno
desktop` also builds in a bare container — it fetches its own `laufey` raw backend — so this is not
blocked on a desktop machine either. The JS spelling is still unknown, because `docs.deno.com` is
not reachable from here.

### Does `@kpstreams/server` run under Deno? — **partly, and the part that matters is untested**

It declares `engines: node >= 20`, pulls two native addons (`node-datachannel`, `@infisical/quic`),
and fronts them with a userspace UDP demux relay so WebRTC and QUIC share one public port.
Requirements 1.2 and 1.4 both assume that survives Deno.

What is established:

- **It listens.** Both native addons load under Deno, the relay binds, and `listen()` returns a
  valid `<ip>:<port>:<certhash>`.
- **A QUIC client connects to it.** The Deno-hosted listener logs an accepted connection, so the
  demux relay and the QUIC handshake both work — the interesting half of the port-sharing trick.
- **But its streams never arrive.** `acceptStream()` never resolves against the Deno-hosted
  listener, while the same client against the same listener under Node echoes fine. It is localised
  to `quic-connection.ts`, which surfaces streams by listening for `EventQUICConnectionStream` on
  the `@infisical/quic` connection; under Deno that event appears not to fire.

**The WebRTC leg decides this, and it passes.** Both frontends are browsers — the GitHub Pages tab
and the Deno Desktop webview — so WebRTC, not QUIC, is how they reach the server, and nothing native
dials it. A real Chromium dials the Deno-hosted listener, opens a stream, and the echo round-trips;
the server logs `CONN accepted / STREAM accepted / STREAM echoed`. So the QUIC stream fault costs
this project nothing.

Two things that leg needed, recorded because they cost most of the spike:

- **`node-datachannel`'s `RTCPeerConnection` polyfill is not a browser.** It times out against a
  **Node** listener too, so a run using it measures the harness rather than the runtime. Every
  transport claim here has a Node control beside it for that reason.
- **Playwright cannot download a browser here.** `cdn.playwright.dev` 307s to
  `playwright.download.prss.microsoft.com`, which the proxy refuses, and `npx playwright install`
  *prunes* the shared browser cache before failing. `deb.debian.org` is reachable, so the browser is
  a Debian **bookworm** Chromium extracted into a private prefix — not sid, which wants a newer
  glibc than this image has.

### Neither native addon is load-bearing

Worth recording, because "KPS needs Node" is the assumption that would otherwise get written down.

- **QUIC is built into Deno**, and fits KPS's server better than `@infisical/quic` does:
  `new Deno.QuicEndpoint({hostname, port})` → `.listen({ alpnProtocols, key, cert })` (unstable,
  quinn-backed) gives the pinned PEM cert/key, a custom ALPN, bidi streams as WHATWG streams, close
  codes, and first-class datagrams — where `@kpstreams/server`'s own README calls its datagram
  support best-effort and "coupled to library internals". It cannot be handed an existing UDP
  socket, so port sharing would still want the demux relay, which is what that relay is for.
- **`werift` is a pure-TypeScript WebRTC stack** that imports and constructs under Deno with no
  addon, and exposes the three things KPS needs and most WebRTC libraries do not:
  `new RTCCertificate(keyPem, certPem, hash)`, `usernameFragment`/`localPassword`, and `iceLite`.

This is not a proposal — the addons working is the cheaper outcome. It is a note that the door is
open if they do not.
