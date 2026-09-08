/**
 * Always on top (section 15).
 *
 * **Absent, not disabled, in a browser tab** (15.5). The card asks `isDesktop()`, which asks
 * whether the desktop shell installed its bridge — so the control exists exactly where it can work,
 * and there is no build flag to keep in sync with reality.
 *
 * It is not behind `canWrite`: this is the shape of a window on one machine, and a read-only
 * device is still entitled to decide that (15.2).
 */

import { useEffect, useState } from "react";
import { isDesktop, loadAlwaysOnTop, setAlwaysOnTop } from "../desktop.ts";

export function AlwaysOnTopCard() {
  const [on, setOn] = useState(() => loadAlwaysOnTop());

  // 15.3, 15.4 — the stored preference is reapplied on every start, because the window opens
  // ordinary and the setting belongs to the device rather than to the shell's defaults.
  useEffect(() => {
    if (isDesktop()) void setAlwaysOnTop(loadAlwaysOnTop());
  }, []);

  if (!isDesktop()) return null;

  return (
    <div className="card">
      <h3>This window</h3>
      <label className="row" style={{ gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            void setAlwaysOnTop(e.target.checked);
          }}
        />
        Always on top
      </label>
      <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
        Keeps Worklog above other windows so the running clock stays visible. It applies to this
        window on this machine, and the server is not told about it.
      </p>
    </div>
  );
}
