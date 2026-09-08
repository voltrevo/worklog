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

**The WebRTC leg is the one that decides this**, because both frontends are browsers — the GitHub
Pages tab and the Deno Desktop webview — so WebRTC, not QUIC, is how they reach the server. Nothing
native dials it, so if WebRTC works under Deno the QUIC gap costs this project nothing.

It looks healthy. `node-datachannel`'s whole native surface works under Deno: the ICE UDP mux binds,
a `PeerConnection` constructs, a DTLS certificate is generated, and a local offer comes back
carrying a `sha-256` fingerprint — every addon call the WebRTC backend makes short of the handshake
itself. What remains untested is a real handshake and data channel end to end, which needs a
browser: `node-datachannel`'s `RTCPeerConnection` polyfill is not a substitute, since it times out
against a **Node** listener too, and Playwright cannot fetch a browser from here because
`cdn.playwright.dev` redirects to `playwright.download.prss.microsoft.com`, which the proxy refuses.

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
