/**
 * The audio-loop settings card, and the thing that actually plays (section 14).
 *
 * It lives on Settings because 14.6 wants importing a file to be a configuration act, while
 * 14.8 wants ordinary use to be two controls and no more — so Enabled and Volume are what the card
 * leads with, and the file picker sits underneath as the setup step it is.
 *
 * **The playing is driven by the authoritative timer** (14.12–14.14, 16.6), not by a local switch.
 * The switch says *whether*; the server says *when*.
 */

import { useEffect, useRef, useState } from "react";
import { useStore } from "../state.tsx";
import { usePresentation } from "../App.tsx";
import {
  clearLoop,
  labelFor,
  loadEnabled,
  loadLoop,
  loadVolume,
  LoopPlayer,
  RANGE_DB,
  saveEnabled,
  saveLoop,
  saveVolume,
  type StoredLoop,
} from "../localAudio.ts";

/**
 * Mounted once, near the root, so playback survives moving between screens.
 *
 * Rendering nothing is the point: the loop is not a widget, and 14.9's "no play/pause controls"
 * is easier to keep true when there is no component to hang them on.
 */
export function LoopPlayback() {
  const { snapshot } = useStore();
  const playerRef = useRef<LoopPlayer>(null);
  const active = snapshot?.timer.active !== undefined;
  const startedAt = snapshot?.timer.active?.startedAt;

  useEffect(() => {
    const player = new LoopPlayer();
    playerRef.current = player;
    void loadLoop().then((loop) => player.load(loop)).catch(() => {});
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setVolume(loadVolume());
    // 14.15 — keyed on `startedAt`, so a *new* session restarts the loop rather than letting it
    // run on from wherever the last one left it.
    if (active && loadEnabled()) void player.start();
    else player.stop();
  }, [active, startedAt]);

  return null;
}

export function LocalAudioCard() {
  const presentation = usePresentation();
  const [loop, setLoop] = useState<StoredLoop>();
  const [enabled, setEnabled] = useState(() => loadEnabled());
  const [volume, setVolume] = useState(() => loadVolume());
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void loadLoop().then(setLoop).catch(() => {});
  }, []);

  // 14.25, 23.6 — hidden on a phone rather than offered and broken. A backgrounded mobile tab is
  // suspended and autoplay needs a gesture, so 14.12's "continuously while the timer is active"
  // is not something a phone browser can honour, and a switch that silently stops working is
  // worse than no switch.
  if (presentation === "mobile") return null;

  const take = async (file: File | undefined) => {
    if (!file) return;
    setLoop(await saveLoop(file));
  };

  return (
    <div className="card">
      <h3>Background audio, on this device</h3>
      <p className="muted" style={{ margin: "4px 0 12px", maxWidth: 620 }}>
        One file, looping while the timer runs. It never leaves this browser — the server is not
        told the file, the volume, or that you have set one up at all. Another device you use is
        entirely separate.
      </p>

      {/* 14.8 — the two controls ordinary use needs, and nothing else. */}
      <div className="row wrap" style={{ gap: 20, alignItems: "center" }}>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!loop}
            onChange={(e) => {
              setEnabled(e.target.checked);
              saveEnabled(e.target.checked);
            }}
          />
          Enabled
        </label>

        <label className="row" style={{ gap: 10, flex: 1, minWidth: 240 }}>
          <span className="faint" style={{ fontSize: 12 }}>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={volume}
            disabled={!loop}
            style={{ flex: 1 }}
            onChange={(e) => {
              const next = Number(e.target.value);
              setVolume(next);
              saveVolume(next);
            }}
          />
          <span className="tabular faint" style={{ fontSize: 12, minWidth: 52 }}>
            {labelFor(volume)}
          </span>
        </label>
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
        The slider is {RANGE_DB}{" "}
        dB of travel, so quiet settings are as controllable as loud ones, and all the way down is
        silence rather than nearly silence.
      </p>

      {/* 14.6 — one file, dropped or chosen. */}
      <div
        className={`dropzone ${dragging ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void take(e.dataTransfer.files[0]);
        }}
      >
        {loop
          ? (
            <div className="row between wrap">
              <span>
                <strong>{loop.name}</strong>{" "}
                <span className="faint">
                  ({Math.round(loop.bytes.byteLength / 1024)} kB, copied here)
                </span>
              </span>
              <button
                className="link"
                type="button"
                onClick={async () => {
                  await clearLoop();
                  setLoop(undefined);
                  setEnabled(false);
                  saveEnabled(false);
                }}
              >
                Remove
              </button>
            </div>
          )
          : (
            <label className="row" style={{ gap: 10, cursor: "pointer" }}>
              <span className="faint">Drop an audio file here, or</span>
              <span className="btn">Choose a file</span>
              <input
                type="file"
                accept="audio/*"
                style={{ display: "none" }}
                onChange={(e) => void take(e.target.files?.[0] ?? undefined)}
              />
            </label>
          )}
      </div>
    </div>
  );
}
