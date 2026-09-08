/**
 * The two shells, and which one is showing (section 23).
 *
 * **The shells are separate components, not one layout with breakpoints** (23.2). A sidebar does
 * not become a tab bar by getting narrower; the navigation model is genuinely different, and the
 * mockups describe the desktop one only. What they share is everything below them: the screens are
 * the same components, reading the same store, because 23.3 wants the difference to be the shell
 * and nothing else.
 *
 * **The viewport decides, not the runtime** (23.4). A narrow desktop window gets the mobile shell
 * and a tablet in landscape gets the desktop one, which is right — the constraint being solved is
 * how much room there is, not what the app was compiled into.
 */

import { useEffect, useState } from "react";
import { StoreProvider, useStore } from "./state.tsx";
import { Connect } from "./screens/Connect.tsx";
import { Timer } from "./screens/Timer.tsx";
import { History } from "./screens/History.tsx";
import { Pacing } from "./screens/Pacing.tsx";
import { Invoices } from "./screens/Invoices.tsx";
import { Admin } from "./screens/Admin.tsx";
import { Settings } from "./screens/Settings.tsx";

export type ScreenId =
  | "timer"
  | "history"
  | "pacing"
  | "invoices"
  | "admin"
  | "settings";

interface NavItem {
  id: ScreenId;
  label: string;
  glyph: string;
  /** Admin-only screens are hidden rather than shown broken (19.12, 19.13). */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { id: "timer", label: "Timer", glyph: "◷" },
  { id: "history", label: "History", glyph: "☰" },
  { id: "pacing", label: "Pacing", glyph: "◑" },
  { id: "invoices", label: "Invoices", glyph: "▤" },
  { id: "admin", label: "Admin", glyph: "⚿", adminOnly: true },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

/** 23.4 — one media query, read once and watched. 900px is where the sidebar stops earning its width. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    globalThis.matchMedia?.("(max-width: 900px)").matches ?? false
  );
  useEffect(() => {
    const mq = globalThis.matchMedia("(max-width: 900px)");
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function Screen({ id }: { id: ScreenId }) {
  switch (id) {
    case "timer":
      return <Timer />;
    case "history":
      return <History />;
    case "pacing":
      return <Pacing />;
    case "invoices":
      return <Invoices />;
    case "admin":
      return <Admin />;
    case "settings":
      return <Settings />;
  }
}

function ConnectionDot() {
  const { phase } = useStore();
  const tone = phase.k === "ready" ? "on" : phase.k === "failed" ? "bad" : "";
  const label = phase.k === "ready"
    ? "Connected"
    : phase.k === "connecting"
    ? "Connecting…"
    : phase.k === "failed"
    ? "Disconnected"
    : "Not connected";
  return (
    <>
      <span className={`dot ${tone}`} aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </>
  );
}

function DesktopShell(
  { screen, setScreen }: { screen: ScreenId; setScreen: (s: ScreenId) => void },
) {
  const { phase } = useStore();
  const isAdmin = phase.k === "ready" && phase.role === "admin";
  return (
    <div className="app desktop">
      <nav className="sidebar">
        <div className="brand">
          <ConnectionDot />
          Worklog
        </div>
        <div className="conn muted">
          {phase.k === "ready"
            ? "Connected"
            : phase.k === "connecting"
            ? "Connecting…"
            : phase.k === "failed"
            ? "Disconnected"
            : "Not connected"}
        </div>
        <div className="nav">
          {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={screen === n.id ? "page" : undefined}
              onClick={() => setScreen(n.id)}
            >
              <span aria-hidden="true">{n.glyph}</span>
              {n.label}
            </button>
          ))}
        </div>
      </nav>
      <main className="main">
        <Screen id={screen} />
      </main>
    </div>
  );
}

function MobileShell(
  { screen, setScreen }: { screen: ScreenId; setScreen: (s: ScreenId) => void },
) {
  const { phase } = useStore();
  const isAdmin = phase.k === "ready" && phase.role === "admin";
  const items = NAV.filter((n) => !n.adminOnly || isAdmin);
  const current = items.find((n) => n.id === screen);
  return (
    <div className="app mobile">
      <header className="topbar">
        <div className="brand">
          <ConnectionDot />
          {current?.label ?? "Worklog"}
        </div>
      </header>
      <main className="main">
        <Screen id={screen} />
      </main>
      <nav className="tabbar">
        {items.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={screen === n.id ? "page" : undefined}
            onClick={() => setScreen(n.id)}
          >
            <span className="glyph" aria-hidden="true">{n.glyph}</span>
            {n.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Shell() {
  const { phase } = useStore();
  const [screen, setScreen] = useState<ScreenId>("timer");
  const mobile = useIsMobile();

  // Everything before `ready` is one screen with no navigation, because there is exactly one
  // useful thing to do and a sidebar of dead links is worse than no sidebar.
  if (phase.k !== "ready") return <Connect />;

  return mobile
    ? <MobileShell screen={screen} setScreen={setScreen} />
    : <DesktopShell screen={screen} setScreen={setScreen} />;
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
