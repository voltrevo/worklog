/**
 * The loop player's behaviour (14.9–14.15), against stub browser globals.
 *
 * Section 14 was the last part of the product with no verification of any kind. The journey checks
 * that a chosen file is stored and survives a reload, and `gain.ts` has the decibel curve under
 * test, but whether the thing *plays* — and, more to the point, whether it plays from the
 * beginning, loops, and stops — was covered by nothing.
 *
 * It is unit-tested rather than driven through a browser because the interesting claims are all
 * about calls the player makes on an `<audio>` element that is never in the document, so there is
 * nothing for Playwright to look at. Stubs make those calls visible; a real browser would only
 * make them audible.
 *
 * The stubs are deliberately thin. They record what was asked of them and nothing else — a stub
 * that behaves realistically would start being a second, worse implementation of the thing under
 * test.
 */

/// <reference lib="dom" />
// The DOM lib, because `localAudio.ts` is browser code: without it `deno test` type-checks the
// module it imports against Deno's globals and fails on `Audio`, `AudioContext` and `Blob`. The
// production type-check is `tsc` through `web/tsconfig.json`, which has had DOM all along; this
// line is what lets the same file be reached from the Deno side too.

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1";
import { gainFor } from "./gain.ts";
import { LoopPlayer, type StoredLoop } from "./localAudio.ts";

interface Calls {
  play: number;
  pause: number;
  seeks: number[];
  gains: number[];
  resumed: number;
  /** The elements the player made, so their properties can be read rather than assumed. */
  created: { loop: boolean; preload: string; src: string }[];
}

/** Install just enough of a browser to run the player, and record what it does. */
function stubBrowser(): { calls: Calls; restore: () => void } {
  const calls: Calls = { play: 0, pause: 0, seeks: [], gains: [], resumed: 0, created: [] };
  const g = globalThis as Record<string, unknown>;
  const saved = { ...g };

  class FakeAudio {
    loop = false;
    preload = "";
    paused = true;
    #time = 0;
    constructor(public src: string) {
      calls.created.push(this as unknown as Calls["created"][number]);
    }
    get currentTime(): number {
      return this.#time;
    }
    set currentTime(v: number) {
      this.#time = v;
      calls.seeks.push(v);
    }
    play(): Promise<void> {
      calls.play++;
      this.paused = false;
      return Promise.resolve();
    }
    pause(): void {
      calls.pause++;
      this.paused = true;
    }
  }

  const gainNode = {
    gain: {
      setTargetAtTime: (v: number) => {
        calls.gains.push(v);
      },
    },
    connect: () => {},
  };

  class FakeContext {
    currentTime = 0;
    createGain() {
      return gainNode;
    }
    createMediaElementSource() {
      return { connect: () => {} };
    }
    resume(): Promise<void> {
      calls.resumed++;
      return Promise.resolve();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  g.Audio = FakeAudio;
  g.AudioContext = FakeContext;
  g.URL = {
    ...(g.URL as object),
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  };
  g.Blob = class {
    constructor(public parts: unknown[], public opts: unknown) {}
  };

  return {
    calls,
    restore: () => {
      g.Audio = saved.Audio;
      g.AudioContext = saved.AudioContext;
      g.URL = saved.URL;
      g.Blob = saved.Blob;
    },
  };
}

const LOOP: StoredLoop = {
  name: "rain.ogg",
  type: "audio/ogg",
  bytes: new Uint8Array([1, 2, 3]).buffer,
};

Deno.test("14.12 -- the file loops, and there is nothing to press", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    await player.start();
    assertEquals(calls.play, 1);
    assertEquals(player.playing, true);
    // Read off the element the player actually built. The first draft of this asserted
    // `audioOf(player).loop === true` against a helper that returned a literal `true`, which is a
    // sentence that cannot be false.
    assertEquals(calls.created.length, 1);
    assertEquals(calls.created[0]!.loop, true, "14.12 needs the element to loop");
    assertEquals(calls.created[0]!.preload, "auto");

    // 14.10, 14.11 — the surface is start, stop and volume. No seek, no scrub, no pause-and-resume
    // that could leave a position behind. This is the whole public API.
    const surface = Object.getOwnPropertyNames(LoopPlayer.prototype).filter((n) =>
      n !== "constructor"
    );
    assertEquals(surface.sort(), ["dispose", "load", "playing", "setVolume", "start", "stop"]);
    player.dispose();
  } finally {
    restore();
  }
});

Deno.test("14.15 -- a new session starts the loop from the beginning", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    await player.start();
    player.stop();
    await player.start();

    // Both starts rewound. Resuming from wherever the last session stopped is the failure this
    // guards against, and it is one nobody would notice from a screenshot.
    assertEquals(calls.seeks, [0, 0]);
    assertEquals(calls.play, 2);
    player.dispose();
  } finally {
    restore();
  }
});

Deno.test("14.13 -- stopping pauses, and stopping twice is not an error", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    await player.start();
    player.stop();
    player.stop();
    assertEquals(player.playing, false);
    assertEquals(calls.pause, 2);
    player.dispose();
  } finally {
    restore();
  }
});

Deno.test("14.19, 14.22 -- the volume that reaches the gain node is the decibel curve", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    await player.start();
    for (const position of [1, 0.5, 0.25, 0]) player.setVolume(position);

    // The last four are the ones set explicitly; `start` sets one of its own first.
    const applied = calls.gains.slice(-4);
    for (const [i, position] of [1, 0.5, 0.25, 0].entries()) {
      assertAlmostEquals(applied[i]!, gainFor(position), 1e-12);
    }
    // 14.22 — all the way down is silence, not nearly silence.
    assertEquals(applied[3], 0);
    player.dispose();
  } finally {
    restore();
  }
});

Deno.test("a player with no file loaded does nothing rather than throwing", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(undefined);
    await player.start();
    player.stop();
    assertEquals(player.playing, false);
    assertEquals(calls.play, 0);
    player.dispose();
  } finally {
    restore();
  }
});
