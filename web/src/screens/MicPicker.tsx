/**
 * Which microphone, said out loud, with a cog beside it (27.5).
 *
 * Reported as: "the record function should show the microphone it is going to use, and a cog to
 * pick another one." Both halves matter — the naming is the part you read without asking, and the
 * cog is there for the machine with a webcam microphone in front of a headset.
 *
 * **A glyph with a name**, following `MonthNav`: read aloud a bare "⚙" announces itself as "⚙".
 */

import { useEffect, useState } from "react";
import {
  activeMic,
  chooseMic,
  chosenMic,
  listMics,
  type Microphone,
  reveal,
} from "../microphone.ts";

export function MicPicker() {
  /*
   * `undefined` until `enumerateDevices` answers, not `[]` (25.1).
   *
   * The two are different claims and this component makes both of them out loud: `[]` is "no
   * microphone on this device", which is a sentence, and it would be on screen for the frame or
   * two before the browser has said anything. So nothing is drawn until there is an answer.
   */
  const [mics, setMics] = useState<Microphone[]>();
  const [chosen, setChosen] = useState(chosenMic());
  const [open, setOpen] = useState(false);
  /** Set when `reveal()` was pressed and refused, so the panel does not keep offering it. */
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    const refresh = () => void listMics().then(setMics);
    refresh();
    // Plugging a headset in while the note is open changes the answer, and the browser says so.
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refresh);
    return () => md?.removeEventListener?.("devicechange", refresh);
  }, []);

  if (!mics) return null;

  const active = activeMic(mics, chosen);
  const named = active?.label.trim();
  // A microphone with a stored id that is no longer in the list: the picker is the place to say so,
  // because `getUserMedia` will not fail until the moment somebody presses Record.
  const missing = chosen !== undefined && !mics.some((m) => m.deviceId === chosen);

  const pick = (deviceId: string | undefined) => {
    chooseMic(deviceId);
    setChosen(deviceId);
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className="faint" style={{ fontSize: 12 }}>
          {missing ? "The microphone you chose is not plugged in" : named
            ? `Microphone: ${named}`
            /* 27.5 says "when that is known", and until this origin has recorded once it is
                 not: the browser lists the microphones and withholds their names. */
            : "Microphone: not named until you have allowed recording once"}
        </span>
        <button
          className="btn"
          type="button"
          aria-label="Choose a microphone"
          title="Choose a microphone"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          ⚙
        </button>
      </div>

      {open && (
        <div className="card stack" style={{ gap: 8, padding: 12 }}>
          {mics.length === 0
            ? <span className="faint" style={{ fontSize: 12 }}>No microphone on this device.</span>
            : (
              <>
                <label className="row" style={{ gap: 8, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="worklog-mic"
                    checked={chosen === undefined}
                    onChange={() => pick(undefined)}
                  />
                  <span>Whatever this device calls its default</span>
                </label>
                {mics.map((m, i) => (
                  <label key={m.deviceId} className="row" style={{ gap: 8, alignItems: "center" }}>
                    <input
                      type="radio"
                      name="worklog-mic"
                      checked={chosen === m.deviceId}
                      onChange={() =>
                        pick(m.deviceId)}
                    />
                    {
                      /* Numbered when unnamed, so a list of four empty strings is still a list of
                        four things you can choose between. */
                    }
                    <span>{m.label.trim() || `Microphone ${i + 1}`}</span>
                  </label>
                ))}
              </>
            )}

          {mics.every((m) => !m.label.trim()) && mics.length > 0 && (
            refused
              ? (
                <span className="faint" style={{ fontSize: 12 }}>
                  Recording was not allowed, so the names stay hidden.
                </span>
              )
              : (
                <button
                  className="link"
                  type="button"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    void reveal().then(async (ok) => {
                      setRefused(!ok);
                      if (ok) setMics(await listMics());
                    })}
                >
                  Allow recording once, to see their names
                </button>
              )
          )}

          <button
            className="btn"
            type="button"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setOpen(false)}
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
