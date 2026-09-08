/**
 * Sending the frontend's own failures to the server (12.6, 12.8, 12.14, 16.4).
 *
 * **A queue, because the interesting errors happen when the connection is bad.** 12.14 asks for
 * transient failures to be held locally, and the reason is not politeness: an error worth reading
 * is disproportionately likely to be one that also stopped the report from being sent. A reporter
 * that only works while everything works is a reporter for the errors nobody needed.
 *
 * **What is sent is deliberately narrow** (16.4, 12.15). A message, a source, a stack, and the
 * screen it happened on. Not the local audio settings, not the window state, not the server
 * address — 16.1 and 16.2 keep those on the device, and an error reporter is exactly the sort of
 * well-meaning code that would post them for context.
 */

const QUEUE_KEY = "worklog.errorQueue";
const MAX_QUEUED = 20;

export interface ReportedError {
  message: string;
  context: Record<string, unknown>;
}

export type Sender = (report: ReportedError) => Promise<unknown>;

/**
 * Everything about the failure, and nothing about the device.
 *
 * The allow-list is the point: it is shorter than the list of things worth withholding, and it
 * cannot grow by accident the way a deny-list can.
 */
export function describeError(error: unknown, where: string): ReportedError {
  const err = error instanceof Error ? error : undefined;
  return {
    message: err ? `${err.name}: ${err.message}` : String(error),
    context: {
      where,
      // 12.8 — useful, and the server keeps it from non-admin readers (12.17).
      ...(err?.stack ? { stack: trimStack(err.stack) } : {}),
      // A tab that has been open for days behaves differently from one just opened.
      uptimeMs: Math.round(performance.now()),
    },
  };
}

/** The top of the stack is where the fault is; the rest is React's own machinery. */
function trimStack(stack: string): string {
  return stack.split("\n").slice(0, 12).join("\n");
}

function readQueue(): ReportedError[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) as ReportedError[] : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: ReportedError[]): void {
  try {
    // Newest kept: an old error from a session that has since been restarted is the least
    // interesting thing in the list, and a bounded queue must drop something.
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUED)));
  } catch {
    // Storage full or blocked. Losing a queued report is better than throwing inside the thing
    // whose job is to handle a throw.
  }
}

/**
 * Try to send, and keep it if that fails.
 *
 * Never throws. A reporter that can raise is a reporter that turns one error into two, and the
 * second one arrives from inside the error handler.
 */
export async function report(
  send: Sender,
  error: ReportedError,
): Promise<void> {
  try {
    await send(error);
  } catch {
    writeQueue([...readQueue(), error]);
  }
}

/** 12.14 — called once a connection is up, to drain whatever was held while it was not. */
export async function flushQueue(send: Sender): Promise<number> {
  const queued = readQueue();
  if (queued.length === 0) return 0;
  writeQueue([]);

  const failed: ReportedError[] = [];
  for (const item of queued) {
    try {
      await send(item);
    } catch {
      failed.push(item);
    }
  }
  if (failed.length) writeQueue(failed);
  return queued.length - failed.length;
}

export function queuedCount(): number {
  return readQueue().length;
}

/**
 * Catch what React does not: errors outside a render, and rejected promises nobody awaited.
 *
 * Returns a teardown, because a listener that outlives the app is a listener reporting to a
 * connection that has gone.
 */
export function installGlobalHandlers(send: Sender): () => void {
  const onError = (e: ErrorEvent) => {
    void report(send, describeError(e.error ?? e.message, "window.onerror"));
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    void report(send, describeError(e.reason, "unhandledrejection"));
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onRejection);
  return () => {
    globalThis.removeEventListener("error", onError);
    globalThis.removeEventListener("unhandledrejection", onRejection);
  };
}
