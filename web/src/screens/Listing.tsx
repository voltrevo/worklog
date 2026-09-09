/**
 * 25.1 — "we have not looked yet" and "there is nothing" are different sentences.
 *
 * Three lists in this app said the second when they meant the first. The notes list started at
 * `useState<NoteWire[]>([])`, so before the first response arrived it rendered "Nothing noted
 * yet."; the admin screen tested `pending?.length === 0`, which is false while `pending` is
 * `undefined`, so it fell through to `(pending ?? []).map` and drew an empty card with no words
 * in it at all.
 *
 * Both are worse than a spinner, and in the same way: they are a confident answer to a question
 * that has not been asked yet. On a slow connection — which is every connection to a server on
 * somebody's desk, sometimes — the first thing a device tells you about your own work is that
 * there is none of it.
 *
 * `undefined` means not yet, an empty array means empty. Keeping those two apart is a discipline
 * about the *type*, and this component exists so that the discipline has somewhere to be enforced
 * rather than being remembered at each of the sites.
 */

import type { ReactNode } from "react";

export function Listing<T>(
  { items, empty, children }: {
    /** `undefined` until the first answer arrives. Not `[]` — that is a different fact. */
    items: readonly T[] | undefined;
    /** What to say when the answer was "none". */
    empty: string;
    children: (items: readonly T[]) => ReactNode;
  },
) {
  if (items === undefined) {
    return (
      <p className="muted" style={{ margin: 0 }} aria-busy="true">
        Loading…
      </p>
    );
  }
  if (items.length === 0) return <p className="muted" style={{ margin: 0 }}>{empty}</p>;
  return <>{children(items)}</>;
}
