// Change notices inside the observation page: when the page's change-token check sees stored values
// change, it reloads its rows and tells any open dialog (Details, overlapping windows) to reload too,
// so a dialog never polls on its own and never shows older values than the table behind it.

export interface ObservationChange {
  spot: boolean;
  futures: boolean;
}

type Listener = (c: ObservationChange) => void;
const listeners = new Set<Listener>();

export function notifyObservationChange(c: ObservationChange): void {
  for (const l of listeners) l(c);
}

/** Subscribe; returns the unsubscribe function (use in an effect's cleanup). */
export function onObservationChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
