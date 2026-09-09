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

import { createContext, useContext, useEffect, useState } from "react";
import { type Phase, StoreProvider, useStore } from "./state.tsx";
import { Connect } from "./screens/Connect.tsx";
import { Timer } from "./screens/Timer.tsx";
import { Notes } from "./screens/Notes.tsx";
import { History } from "./screens/History.tsx";
import { Pacing } from "./screens/Pacing.tsx";
import { Invoices } from "./screens/Invoices.tsx";
import { Admin } from "./screens/Admin.tsx";
import { Settings } from "./screens/Settings.tsx";
import { WorkNote } from "./screens/WorkNote.tsx";
import { LoopPlayback } from "./screens/LocalAudio.tsx";

export type ScreenId =
  | "timer"
  | "notes"
  | "history"
  | "pacing"
  | "invoices"
  | "admin"
  | "settings";

/**
 * Which presentation a screen is being drawn in.
 *
 * 23.3 lets the shell, the navigation *and the layout* differ, and this is how a screen finds out.
 * It is not a licence to fork behaviour: what changes is how a list is drawn, never what the list
 * says. The first thing it bought was history, whose desktop table clipped its own Edit and Delete
 * off the right edge of a phone — precisely the narrowed-desktop layout that 23.2 forbids.
 */
const Presentation = createContext<"desktop" | "mobile">("desktop");

export function usePresentation(): "desktop" | "mobile" {
  return useContext(Presentation);
}

interface NavItem {
  id: ScreenId;
  label: string;
  glyph: string;
  /** Admin-only screens are hidden rather than shown broken (19.12, 19.13). */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { id: "timer", label: "Timer", glyph: "◷" },
  { id: "notes", label: "Notes", glyph: "✎" },
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
    case "notes":
      return <Notes />;
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

/**
 * What the header says about the connection. One ladder, used by the dot and by the words.
 *
 * A `read` device says so here, and here only. Its controls are disabled all over the app — Start,
 * Save, Delete, the whole invoice editor — and a disabled control does not say why it is disabled;
 * it looks the same as one that is broken, or one you have not filled the form for yet. Saying it
 * once in the one place every screen carries is cheaper for the reader than a note beside each of
 * them, and it is the truth about the device rather than about the button.
 */
function connectionLabel(phase: Phase, reconnecting: boolean): string {
  if (reconnecting) return "Reconnecting…";
  if (phase.k === "ready") {
    return phase.role === "read" ? "Connected · read-only access" : "Connected";
  }
  if (phase.k === "connecting") return "Connecting…";
  if (phase.k === "failed") return "Disconnected";
  return "Not connected";
}

/**
 * The dot, and — where nothing else says it — the words.
 *
 * The dot is decorative, so it needs a text equivalent; the desktop sidebar already prints that
 * text underneath in `.conn`, and rendering both meant a screen reader said "Connected, Worklog,
 * Connected". The phone's header has no room for the sentence and no `.conn`, so there the hidden
 * label is the only thing carrying it. One prop rather than two components, because the ladder
 * behind the words is shared and was two copies of itself once already.
 */
function ConnectionDot({ spoken = true }: { spoken?: boolean }) {
  const { phase, reconnecting } = useStore();
  /*
   * 22.8 — a transient loss keeps the app on screen and says so here.
   *
   * The alternative, and what this used to do, is replace everything with a failure screen the
   * moment a stream ends. On a local network that is almost never a real outage, and throwing the
   * whole interface away for half a second is a worse answer than an amber dot.
   */
  const tone = reconnecting
    ? "warn"
    : phase.k === "ready"
    ? "on"
    : phase.k === "failed"
    ? "bad"
    : "";
  const label = connectionLabel(phase, reconnecting);
  return (
    <>
      <span className={`dot ${tone}`} aria-hidden="true" />
      {spoken && <span className="visually-hidden">{label}</span>}
    </>
  );
}

function DesktopShell(
  { screen, setScreen }: { screen: ScreenId; setScreen: (s: ScreenId) => void },
) {
  const { phase, reconnecting } = useStore();
  const isAdmin = phase.k === "ready" && phase.role === "admin";
  return (
    <div className="app desktop">
      <nav className="sidebar">
        <div className="brand">
          <ConnectionDot spoken={false} />
          Worklog
        </div>
        {/* One source for this sentence and the dot's: they were two copies of the same ladder. */}
        <div className="conn muted">{connectionLabel(phase, reconnecting)}</div>
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
  const { phase, prompt, dismissPrompt } = useStore();
  const [screen, setScreen] = useState<ScreenId>("timer");
  const mobile = useIsMobile();

  // Everything before `ready` is one screen with no navigation, because there is exactly one
  // useful thing to do and a sidebar of dead links is worse than no sidebar.
  if (phase.k !== "ready") return <Connect />;

  return (
    <Presentation.Provider value={mobile ? "mobile" : "desktop"}>
      {mobile
        ? <MobileShell screen={screen} setScreen={setScreen} />
        : <DesktopShell screen={screen} setScreen={setScreen} />}
      {/* 5.16 — a prompt interrupts whichever screen is showing, because that is what it is for. */}
      {prompt && <WorkNote prompted onClose={dismissPrompt} />}
      {/* 14.12-14.14 — renders nothing; it exists so the loop outlives the settings screen. */}
      <LoopPlayback />
    </Presentation.Provider>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
