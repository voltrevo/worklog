import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const shared = (p: string) => fileURLToPath(new URL(`../shared/${p}`, import.meta.url));
const cert = (p: string) => fileURLToPath(new URL(`./.certs/${p}`, import.meta.url));

/**
 * 27.27 — HTTPS for the dev server when a certificate has been generated, plain HTTP when not.
 *
 * The other half of `requireSecureContext` (24.38). That says why a plain-HTTP page on a LAN
 * address cannot hold a device key — `crypto.subtle` is undefined outside a secure context — and
 * names the two ways out: HTTPS, or 127.0.0.1. On a phone the second is not available, so without
 * this the advice is correct and unreachable, and section 23's mobile presentation can only ever
 * be exercised by a narrow viewport in devtools rather than by a phone.
 *
 * TLS the browser distrusts is enough: the origin becomes secure and `crypto.subtle` appears. The
 * certificate is self-signed and gitignored because it proves nothing and is not meant to.
 *
 *     cd web && mkdir -p .certs && openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
 *       -keyout .certs/dev-key.pem -out .certs/dev-cert.pem -subj "/CN=worklog-dev" \
 *       -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<the address the phone dials>"
 *
 * A clone with no `.certs/` gets `undefined`, which is what `server.https` is today.
 */
const devHttps = existsSync(cert("dev-cert.pem")) && existsSync(cert("dev-key.pem"))
  ? { cert: readFileSync(cert("dev-cert.pem")), key: readFileSync(cert("dev-key.pem")) }
  : undefined;

export default defineConfig({
  plugins: [react()],
  // 1.18 -- a static bundle, and a relative base so it works from a GitHub Pages subpath as
  // happily as from the desktop shell's file server.
  base: "./",
  resolve: {
    alias: [
      // 1.19 -- one copy of the core. The alias points at `shared/` in this repo rather than at a
      // published package, so an edit there is an edit here with no publish step in between.
      {
        find: /^@worklog\/shared\/(.*)$/,
        replacement: shared("$1.ts"),
      },
    ],
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    /*
     * 127.0.0.1 unless a run asks otherwise: `deno task web -- --host 0.0.0.0`.
     *
     * Putting the dev server on every interface is a decision for the person making it, not a
     * default everybody inherits from a config file. The `--` is what makes it reachable at all —
     * npm needs it before it will forward an argument to vite, so `deno task web --host 0.0.0.0`
     * was silently dropping the flag and still printing "use --host to expose".
     */
    host: "127.0.0.1",
    port: 5273,
    https: devHttps,
  },
});
