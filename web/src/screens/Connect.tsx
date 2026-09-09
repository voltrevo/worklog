/**
 * Everything before there is a session: the address, the claim, and the wait (section 22, 13.6–13.13).
 *
 * One screen with no navigation, because at every one of these steps there is exactly one useful
 * thing to do, and a sidebar full of links that cannot work yet is worse than no sidebar.
 */

import { useState } from "react";
import { useStore } from "../state.tsx";
import { addressProblem } from "../deviceKeys.ts";
import type { AccessRole } from "@worklog/shared/auth";

export function Connect() {
  // 25.31. Write by default: it is what almost every device asking is for.
  const [wanted, setWanted] = useState<AccessRole>("write");
  const {
    phase,
    connectTo,
    claimAdmin,
    requestAccess,
    deviceName,
    setDeviceName,
    forget,
  } = useStore();
  const [address, setAddress] = useState(
    () => ("address" in phase ? phase.address : ""),
  );
  const [name, setName] = useState(deviceName);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // 22.9 — a malformed address is a configuration mistake, and saying "could not connect" would
    // send someone to look at their network instead of at what they pasted.
    const trouble = addressProblem(address);
    setProblem(trouble);
    if (trouble) return;
    setDeviceName(name);
    void connectTo(address, name);
  };

  if (phase.k === "no-address" || phase.k === "failed") {
    return (
      <div className="centered">
        <form className="card stack" onSubmit={submit}>
          <h1>Worklog</h1>
          <p className="muted">
            Worklog keeps your time on a server you run. Paste the address it printed when it
            started — it is the only way in, so it is worth treating as a secret.
          </p>

          {phase.k === "failed" && <div className="notice bad">{phase.message}</div>}

          <label className="field">
            Server address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="192.168.1.5:41108:uEiA…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-invalid={problem ? true : undefined}
            />
          </label>
          {problem && <div className="notice warn">{problem}</div>}

          <label className="field">
            What to call this device
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="faint" style={{ fontSize: 12, margin: 0 }}>
            Shown to whoever approves this device. It is a label, not a login.
          </p>

          <div className="row">
            <button className="btn primary" type="submit">Connect</button>
            {phase.k === "failed" && (
              <button className="btn" type="button" onClick={forget}>
                Use a different server
              </button>
            )}
          </div>
        </form>
      </div>
    );
  }

  if (phase.k === "ready") return null; // App renders a shell in this case; here for narrowing.

  /**
   * 25.33 — approved, and told so.
   *
   * The waiting page promised "this page will carry on once they do" and then did not: the device
   * only found out by being reloaded, which nothing on screen suggested. It knows now, and says
   * so, and going in is a deliberate press rather than the app appearing under whoever happened
   * to be reading the previous sentence.
   */
  if (phase.k === "approved") {
    return (
      <div className="centered">
        <div className="card stack">
          <h1>Approved</h1>
          <p className="muted">
            <strong>{deviceName}</strong> has been given access to this server.
          </p>
          <div className="row">
            <button
              className="btn primary big"
              type="button"
              onClick={() => void connectTo(phase.address, deviceName)}
            >
              Continue
            </button>
            <button className="btn" type="button" onClick={forget}>
              Use a different server
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.k === "connecting") {
    return (
      <div className="centered">
        <div className="card stack">
          <h1>Connecting…</h1>
          <p className="muted mono">{phase.address}</p>
          <button className="btn" type="button" onClick={forget}>Cancel</button>
        </div>
      </div>
    );
  }

  // 13.7 vs 13.11 — the same screen with a different offer, decided by the server.
  return (
    <div className="centered">
      <div className="card stack">
        {phase.offer === "claim"
          ? (
            <>
              <h1>Claim admin</h1>
              <p className="muted">
                This server has no authorized devices yet, so this one can take administrator
                access. Once it does, every other device has to be approved from here.
              </p>
              <div className="notice info">
                Only do this on a server you started yourself. If someone sent you this address, ask
                for access instead.
              </div>
              <div className="row">
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => void claimAdmin()}
                >
                  Claim admin
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void requestAccess("write")}
                >
                  Request access instead
                </button>
              </div>
            </>
          )
          : phase.asked
          ? (
            <>
              <h1>Waiting for approval</h1>
              <p className="muted">
                <strong>{deviceName}</strong>{" "}
                has asked for access. An administrator has to approve it from a device that already
                has admin. This page will carry on once they do.
              </p>
              <button className="btn" type="button" onClick={forget}>
                Use a different server
              </button>
            </>
          )
          : (
            <>
              <h1>Request access</h1>
              <p className="muted">
                This server already has an administrator. Ask them to approve{" "}
                <strong>{deviceName}</strong>.
              </p>
              {
                /*
                25.31 — one dropdown and one button. Three buttons read as three different acts
                and put the least common one, admin, the same distance away as the one almost
                everybody wants; and "Ask for write access" beside a plain "Admin" gave no clue
                that they were alternatives rather than a request and a claim.
              */
              }
              <div className="row wrap" style={{ alignItems: "flex-end" }}>
                <label className="field">
                  Access needed
                  <select
                    value={wanted}
                    onChange={(e) => setWanted(e.target.value as AccessRole)}
                  >
                    <option value="read">read — see everything, change nothing</option>
                    <option value="write">write — record and edit work</option>
                    <option value="admin">admin — also approve other devices</option>
                  </select>
                </label>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => void requestAccess(wanted)}
                >
                  Ask for access
                </button>
              </div>
            </>
          )}
      </div>
    </div>
  );
}
