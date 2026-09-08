# Worklog

Self-hosted work time tracking and invoicing. A Deno server holds the truth in SQLite; a React
frontend reaches it over [KPS](https://github.com/ethereum/kps) — from a Deno Desktop window or from
a static page on GitHub Pages, both dialling the same `<ip>:<port>:<certhash>` address.

Nothing is built yet. [`REQUIREMENTS.md`](REQUIREMENTS.md) is the specification, and it is
**append-only**: items keep their numbers forever, superseded ones are struck through rather than
edited, and new sections are added rather than folded into old ones. That is what makes a reference
to `6.10` safe to write down and never revisit.

## Open questions before implementation

Two of them can invalidate the architecture, so they are spikes rather than tasks:

- **Does `@kpstreams/server` run under Deno?** It declares `engines: node >= 20`, pulls two native
  addons (`node-datachannel`, `@infisical/quic`), and fronts them with a userspace UDP demux relay
  so WebRTC and QUIC share one public port. Requirements 1.2 and 1.4 both assume yes.
- **Can `deno desktop` set always-on-top?** Section 15 is a MUST and has no fallback.
