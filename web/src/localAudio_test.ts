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
  /**
   * The elements the graph was actually pointed at (26.4).
   *
   * Distinct from `created` on purpose: the fault was that a second element was built and the
   * source node still fed from the first, so a test that only counted elements could not see it.
   */
  sources: unknown[];
}

/** Install just enough of a browser to run the player, and record what it does. */
function stubBrowser(): { calls: Calls; restore: () => void } {
  const calls: Calls = {
    play: 0,
    pause: 0,
    seeks: [],
    gains: [],
    resumed: 0,
    created: [],
    sources: [],
  };
  const g = globalThis as Record<string, unknown>;

  /**
   * Saved as *descriptors*, and restored with `defineProperty`.
   *
   * The first version did `const saved = { ...globalThis }`, which copies only enumerable own
   * properties — and `URL`, `Blob`, `Audio` and `AudioContext` are all non-enumerable. So
   * `saved.URL` was `undefined`, `restore()` assigned `globalThis.URL = undefined`, and every
   * later test file in the same process that says `new URL(...)` broke. It passed in isolation and
   * failed in the suite, which is the signature of exactly this mistake and cost the same
   * afternoon twice.
   */
  const NAMES = ["Audio", "AudioContext", "Blob"] as const;
  const saved = new Map(
    NAMES.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const),
  );

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
    createMediaElementSource(el: unknown) {
      calls.sources.push(el);
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
  /*
   * Statics attached to the real `URL`, not a replacement object.
   *
   * `{ ...URL, createObjectURL }` spreads a class into a plain object, so `new URL(...)` stops
   * working — and the first thing to need it was `@std/assert`'s failure *formatter*, which turned
   * a legible assertion into "URL is not a constructor" from inside the test runner.
   */
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:stub";
  URL.revokeObjectURL = () => {};
  g.Blob = class {
    constructor(public parts: unknown[], public opts: unknown) {}
  };

  return {
    calls,
    restore: () => {
      for (const name of NAMES) {
        const descriptor = saved.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete g[name]; // It was not there before; leaving a stub behind is its own leak.
      }
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
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

    // 14.10, 14.11 — the *controls* are start, stop and volume. No seek, no scrub, no
    // pause-and-resume that could leave a position behind.
    //
    // `playing` and `blocked` are on this list and are not controls; they are what the settings
    // card reads to decide between "■ Stop preview" and an explanation that the browser refused
    // (25.19). The guard is against a seek appearing, so it lists everything and is updated
    // deliberately — it caught `blocked` the moment it was added, which is the point.
    const surface = Object.getOwnPropertyNames(LoopPlayer.prototype).filter((n) =>
      n !== "constructor"
    );
    assertEquals(surface.sort(), [
      "blocked",
      "dispose",
      "load",
      "playing",
      "setVolume",
      // 26.1 — why nothing is playing, when the answer is not "the browser refused".
      "silent",
      "start",
      "stop",
    ]);
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

Deno.test("25.19 -- a refused start is reported rather than swallowed", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);

    // What an autoplay policy actually does: reject with NotAllowedError. This used to be
    // `.catch(() => {})`, so the loop silently never played — no error, no element, nothing to
    // find. The settings card reads `blocked` to offer a button, because a click is the gesture
    // the policy is waiting for.
    const audio = calls.created[0]! as unknown as { play: () => Promise<void> };
    audio.play = () =>
      Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));

    await player.start();
    assertEquals(player.blocked, true, "a refusal must be visible");
    assertEquals(player.playing, false);

    // And once it is allowed, the flag clears.
    audio.play = () => Promise.resolve();
    await player.start();
    assertEquals(player.blocked, false);
    player.dispose();
  } finally {
    restore();
  }
});

Deno.test("any other playback failure is thrown, not mistaken for an autoplay block", async () => {
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    const audio = calls.created[0]! as unknown as { play: () => Promise<void> };
    audio.play = () => Promise.reject(new Error("the file is not audio"));

    let threw = "";
    await player.start().catch((e) => {
      threw = (e as Error).message;
    });
    assertEquals(threw, "the file is not audio");
    assertEquals(player.blocked, false, "a decode failure is not something a button fixes");
    player.dispose();
  } finally {
    restore();
  }
});

Deno.test("26.3 -- loading the file that is already loaded does not stop it", async () => {
  /*
   * The reported fault: walking to the settings screen silenced a loop that was running. `load`
   * began with `stop()`, and the settings card loads the stored file when it mounts — so opening
   * the screen that *configures* the audio was the thing that stopped it. `LoopPlayback` loads it
   * on mount too, so a reload did it as well.
   */
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    await player.start();
    assertEquals(player.playing, true);

    await player.load(LOOP);
    assertEquals(player.playing, true, "loading the same file again stopped it");
    assertEquals(calls.created.length, 1, "and it built a second element for the same file");
  } finally {
    restore();
  }
});

Deno.test("26.1 -- a start that arrives before the file waits for it", async () => {
  // The loop is read out of IndexedDB, so on a page that opens with a timer already running the
  // start effect reached `start()` before the file did. It returned — no sound, no error, no
  // `blocked`. Whether it worked came down to which promise resolved first.
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    const loading = player.load(LOOP);
    const starting = player.start();
    await Promise.all([loading, starting]);
    assertEquals(calls.play, 1, "the start did not wait for the load");
    assertEquals(player.playing, true);
    assertEquals(player.silent, undefined);
  } finally {
    restore();
  }
});

Deno.test("and a start with no file at all says so rather than going quiet", async () => {
  // The same silent return covered both cases. They want different answers: one is a race worth
  // waiting out, the other is a device with nothing configured.
  const { restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.start();
    assertEquals(player.silent, "no-file");
    assertEquals(player.blocked, false, "no file is not the browser refusing");
  } finally {
    restore();
  }
});

Deno.test("26.4 -- a new file is wired into the gain node, not just swapped in", async () => {
  /*
   * `createMediaElementSource` was called once, inside `if (!this.#context)`, and bound to
   * whichever element happened to be loaded then. Choosing a different file replaced the element
   * and left the graph pointing at the old one — so the new file played through the default
   * output at full volume, with the gain node connected to something silent. That is "volume
   * sometimes not honoured", specifically after changing the file.
   */
  const { calls, restore } = stubBrowser();
  try {
    const player = new LoopPlayer();
    await player.load(LOOP);
    await player.start();
    assertEquals(calls.sources.length, 1);

    await player.load({ name: "other.wav", type: "audio/wav", bytes: new ArrayBuffer(8) });
    await player.start();
    assertEquals(calls.created.length, 2, "a second element was built");
    assertEquals(calls.sources.length, 2, "but the graph was never pointed at it");
    assertEquals(calls.sources[1], calls.created[1], "and it is the new element that is wired up");
  } finally {
    restore();
  }
});
