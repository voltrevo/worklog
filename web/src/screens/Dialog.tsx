/**
 * 24.29, 25.4, 25.35 — one modal, for everything that cannot be undone by clicking again.
 *
 * The same `.sheet` as the work-note panel and the two editors, so this app has one thing that
 * means "answer before carrying on" rather than several that look slightly different.
 *
 * It lived inside `Invoices.tsx` while issuing and deleting an invoice were the only two things
 * that asked. 25.35 added revoking a device and changing its role, and the alternative to moving
 * it was a second dialog somewhere else that would drift — which is the fault 25.30 was about,
 * arriving in a different file.
 */
import { Sheet } from "./Sheet.tsx";

export function Dialog(
  { title, body, confirmLabel, danger, busy, onConfirm, onCancel }: {
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
    busy: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  },
) {
  return (
    <Sheet label={title} onDismiss={onCancel} dismissOnBackdrop>
      <div className="card stack" style={{ gap: 14, maxWidth: 520 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <p className="muted" style={{ margin: 0 }}>{body}</p>
        <div className="row">
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Not now
          </button>
        </div>
      </div>
    </Sheet>
  );
}
