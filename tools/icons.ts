/**
 * The app's icons, drawn from code (27.24).
 *
 * A manifest needs PNGs and this repo has no image library, no design tool and no appetite for
 * binaries whose provenance is "somebody made them once". So they are generated: run this and the
 * files under `web/public/` are rewritten byte for byte the same, which means a reviewer can check
 * that what is committed is what this says it is.
 *
 *     deno task icons
 *
 * The mark is the Timer glyph the navigation already uses — a clock face — on the accent colour
 * from `styles.css`, because the icon on a home screen should look like the button that opens it.
 *
 * **Two shapes, not one scaled.** `purpose: "any"` is drawn as a rounded square with its own
 * margin, because that is the whole icon and nothing will be added to it. `purpose: "maskable"` is
 * full-bleed with the clock inside the safe circle, because Android crops it to whatever shape the
 * launcher likes and an "any" icon cropped that way loses its corners and looks broken.
 */

const ACCENT = [0x25, 0x63, 0xeb] as const;
const INK = [0xff, 0xff, 0xff] as const;

/** 4×4 subsamples per pixel. Cheap, and the alternative is visible stair-stepping on the ring. */
const SUB = 4;

interface Point {
  x: number;
  y: number;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = p.x - (a.x + t * vx), dy = p.y - (a.y + t * vy);
  return Math.hypot(dx, dy);
}

/** Inside a square with rounded corners, in unit coordinates. */
function inRoundedSquare(p: Point, inset: number, radius: number): boolean {
  const lo = inset, hi = 1 - inset;
  if (p.x < lo || p.x > hi || p.y < lo || p.y > hi) return false;
  const cx = Math.min(Math.max(p.x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(p.y, lo + radius), hi - radius);
  return Math.hypot(p.x - cx, p.y - cy) <= radius ||
    (p.x >= lo + radius && p.x <= hi - radius) || (p.y >= lo + radius && p.y <= hi - radius);
}

/**
 * The clock, in unit coordinates: a ring, and hands reading four o'clock.
 *
 * Four o'clock rather than the classic ten-past-ten, because at this size two hands close together
 * read as one thick hand and the icon stops being a clock at all.
 */
function inClock(p: Point, scale: number): boolean {
  const c = { x: 0.5, y: 0.5 };
  const r = 0.30 * scale;
  const stroke = 0.055 * scale;
  const ring = Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r) <= stroke / 2;
  const hand = (angle: number, length: number, width: number) =>
    distanceToSegment(p, c, {
      x: c.x + Math.sin(angle) * r * length,
      y: c.y - Math.cos(angle) * r * length,
    }) <= width / 2;
  // Hour hand up, minute hand to four o'clock: distinguishable at 48 pixels, which is where an
  // icon actually gets looked at.
  return ring || hand(0, 0.55, stroke) || hand(Math.PI * 2 / 3, 0.78, stroke * 0.8);
}

export function draw(size: number, maskable: boolean): Uint8Array {
  // A maskable icon is cropped by the launcher, so its content stays inside the safe circle
  // (40% radius) and its background covers everything. An "any" icon supplies its own shape.
  const inset = maskable ? 0 : 0.06;
  const radius = maskable ? 0 : 0.22;
  const glyph = maskable ? 0.74 : 1;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const p = { x: (x + (sx + 0.5) / SUB) / size, y: (y + (sy + 0.5) / SUB) / size };
          const inside = maskable ? true : inRoundedSquare(p, inset, radius);
          if (!inside) continue;
          bg++;
          if (inClock(p, glyph)) fg++;
        }
      }
      const n = SUB * SUB;
      const alpha = bg / n;
      // The clock is white over the accent, so the pixel's colour is the two mixed by how much of
      // it the glyph covers — composited here rather than left to the PNG, which has one colour
      // per pixel and no notion of layers.
      const mix = bg === 0 ? 0 : fg / bg;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        px[i + c] = Math.round(ACCENT[c]! * (1 - mix) + INK[c]! * mix);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/** RGBA pixels to a PNG. `CompressionStream("deflate")` emits zlib, which is what IDAT holds. */
export async function encodePng(px: Uint8Array, size: number): Promise<Uint8Array> {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    // Filter 0 on every row. The images are small and flat; a filter search would save a few
    // hundred bytes and make this file twice as long.
    raw[y * (stride + 1)] = 0;
    raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const deflated = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array) => {
    const name = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(name, 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflated),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Opaque, for iOS: an apple-touch-icon with transparency gets a black background. */
export function flatten(px: Uint8Array): Uint8Array {
  const out = px.slice();
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(out[i + c]! * a + 0xff * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** What is committed under `web/public/`, and what draws each one. `icons_test.ts` re-runs this. */
export const ICONS: { name: string; pixels(): Uint8Array }[] = [
  { name: "favicon.png", pixels: () => draw(32, false) },
  { name: "icon-192.png", pixels: () => draw(192, false) },
  { name: "icon-512.png", pixels: () => draw(512, false) },
  { name: "icon-maskable-512.png", pixels: () => draw(512, true) },
  { name: "apple-touch-icon.png", pixels: () => flatten(draw(180, false)) },
];

export async function png(icon: { pixels(): Uint8Array }): Promise<Uint8Array> {
  const px = icon.pixels();
  return await encodePng(px, Math.sqrt(px.length / 4));
}

if (import.meta.main) {
  const dir = new URL("../web/public/", import.meta.url);
  for (const icon of ICONS) {
    const bytes = await png(icon);
    await Deno.writeFile(new URL(icon.name, dir), bytes);
    console.log(`${icon.name} (${bytes.length} bytes)`);
  }
}
