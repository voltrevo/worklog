/**
 * The one thing in this app that means "answer this before carrying on".
 *
 * **Four of these existed and none of them handled a key.** Every one declared
 * `role="dialog" aria-modal="true"` — a promise to assistive technology that the rest of the page
 * is inert — and then behaved like a `<div>` with a grey background: Escape did nothing, focus
 * stayed wherever it was, and Tab wandered off behind the overlay into controls the overlay exists
 * to cover. Announcing yourself as a modal and not being one is worse than not announcing it,
 * because the announcement is what stops somebody looking for another way out.
 *
 * Escape closes. Focus moves in when it opens and back to where it was when it closes, because a
 * dialog that leaves the caret behind it is one a keyboard cannot reach at all.
 *
 * **Clicking the backdrop is opt-in**, and only the confirmation dialog takes it. On a form it
 * would mean a stray click at the edge of a long invoice discards every edit, with no warning and
 * no undo — a destructive action triggered by a miss.
 */

import { type ReactNode, useEffect, useRef } from "react";

export function Sheet(
  { label, onDismiss, dismissOnBackdrop, children }: {
    label: string;
    /** Escape, and the backdrop where that is allowed. Cancelling, not saving. */
    onDismiss: () => void;
    dismissOnBackdrop?: boolean;
    children: ReactNode;
  },
) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Captured before focus moves, so it can go back to the control that opened this.
    const opener = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Stopped, so one Escape closes one sheet: the work-note panel can be open over a prompt,
      // and a bubbling key would take both.
      e.stopPropagation();
      onDismiss();
    };
    globalThis.addEventListener("keydown", onKey, true);

    /*
     * Focus the first thing worth typing into, or the card itself.
     *
     * The card is `tabIndex={-1}` so it can hold focus without joining the tab order — which is
     * what makes "focus is inside the dialog" true even for a sheet whose only controls are
     * buttons the person has not reached yet.
     */
    const first = card.current?.querySelector<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
    );
    (first ?? card.current)?.focus();

    return () => {
      globalThis.removeEventListener("keydown", onKey, true);
      /*
       * Give focus back, unless something else has taken it.
       *
       * This was `if (card.current?.contains(document.activeElement))` and never fired: by the
       * time a cleanup runs React has already detached the node, so the card contains nothing and
       * `activeElement` is `<body>`. Focus was simply dropped, which for a keyboard is being put
       * back at the top of the page after every dialog.
       *
       * `<body>` is precisely the tell that focus was *lost* rather than moved on purpose, so
       * that is the condition. And only if the opener is still on the page — the control that
       * opened a sheet is sometimes the row the sheet then deleted.
       */
      if (document.activeElement === document.body && opener?.isConnected) opener.focus();
    };
  }, [onDismiss]);

  return (
    <div
      ref={card}
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      // Focusable without joining the tab order, so a sheet whose controls have not been reached
      // yet can still hold focus. An element with `display: contents` cannot, which is how the
      // first version of this silently focused nothing.
      tabIndex={-1}
      onMouseDown={(e) => {
        // `currentTarget` only: a mousedown that began inside the card and ended out here is a
        // drag-select that overshot, not a click on the backdrop.
        if (dismissOnBackdrop && e.target === e.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>
  );
}
