/**
 * Random work-detail prompts, decided by the server (5.6–5.20).
 *
 * **The process is memoryless and holds no future.** Every ten seconds while the timer runs, the
 * server asks "given the time that has actually passed, should a prompt fire now?" and forgets the
 * answer. 5.14 forbids the obvious alternative — drawing an exponential delay and remembering the
 * timestamp — and the reason is that a stored timestamp survives things it should not: a timer
 * stopped and restarted, a process restart, a clock step. A probability computed from measured
 * elapsed time cannot outlive the timer it belongs to, which is exactly 5.13.
 *
 * Two clamps, and both matter more than they look:
 *
 * - **Elapsed never reaches before the timer started** (5.11). Without it, the first poll after a
 *   start would price in however long the server had been idle, and a prompt would fire almost
 *   immediately every time work began.
 * - **The probability is capped at 1** (5.31). A poll delayed past the mean interval — a suspended
 *   laptop, a slow event loop — otherwise computes `p > 1`, which is certainty dressed up as
 *   arithmetic, and makes the "random" prompt deterministic exactly when the machine was struggling.
 */

import type { Instant } from "@worklog/shared/types";

export const POLL_INTERVAL_MS = 10_000; // 5.9

export interface PromptEvent {
  id: string;
  firedAt: Instant;
}

/**
 * The timing half: no listeners, no database, no side effects.
 *
 * `random` is injected so a test can drive the boundary rather than sample it, and `now` is passed
 * to every call for the same reason.
 */
export class PromptScheduler {
  #startedAt: Instant | null = null;
  #lastPollAt: Instant | null = null;

  /** Whether the process is live. False whenever no timer is running. */
  get running(): boolean {
    return this.#startedAt !== null;
  }

  onTimerStarted(at: Instant): void {
    this.#startedAt = at;
    this.#lastPollAt = at;
  }

  /** 5.13 — the state goes with the timer. There is nothing left to resume. */
  onTimerStopped(): void {
    this.#startedAt = null;
    this.#lastPollAt = null;
  }

  /** How much time this poll is pricing, after 5.11's clamp. Exposed for the tests and the logs. */
  elapsedFor(now: Instant): number {
    if (this.#startedAt === null) return 0;
    const since = Math.max(this.#lastPollAt ?? this.#startedAt, this.#startedAt);
    return Math.max(0, now - since);
  }

  /** 5.12 and 5.31 — `elapsed / mean`, never above 1. */
  probabilityFor(now: Instant, meanIntervalMs: number): number {
    if (!this.running || meanIntervalMs <= 0) return 0;
    return Math.min(1, this.elapsedFor(now) / meanIntervalMs);
  }

  /**
   * One poll. Returns whether a prompt should fire now (5.15 — one event per trigger).
   *
   * The poll always advances `lastPollAt`, fired or not: the elapsed time has been priced either
   * way, and not advancing it would let the same seconds be counted again on the next poll.
   */
  poll(now: Instant, meanIntervalMs: number, random: () => number = Math.random): boolean {
    if (!this.running) return false;
    const p = this.probabilityFor(now, meanIntervalMs);
    this.#lastPollAt = now;
    return random() < p;
  }
}

export interface PromptListener {
  /** An identifier for the connection, so it can be dropped when it goes away. */
  id: string;
  deliver: (event: PromptEvent) => void;
}

/**
 * Who is listening, and what happens when nobody is (5.16–5.20).
 *
 * A prompt with no listener is **dropped and logged, never queued** (5.18–5.20). The reason is that
 * the question a prompt asks is "what are you doing right now"; delivered forty minutes later, when
 * a frontend reconnects, it is a question about something the person has forgotten, arriving as a
 * notification tune for no reason.
 */
export class PromptHub {
  #listeners = new Map<string, PromptListener>();
  #dropped = 0;

  constructor(private readonly onDrop: (reason: string) => void = () => {}) {}

  add(listener: PromptListener): () => void {
    this.#listeners.set(listener.id, listener);
    return () => this.#listeners.delete(listener.id);
  }

  remove(id: string): void {
    this.#listeners.delete(id);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  get droppedCount(): number {
    return this.#dropped;
  }

  /** Returns the event if it reached anyone, or `null` if it was dropped. */
  fire(at: Instant, id: string = crypto.randomUUID()): PromptEvent | null {
    if (this.#listeners.size === 0) {
      this.#dropped++;
      // 12.5, 5.19 -- the only trace a dropped prompt leaves.
      this.onDrop(`work-detail prompt dropped: no frontend was listening`);
      return null;
    }
    const event: PromptEvent = { id, firedAt: at };
    for (const l of [...this.#listeners.values()]) {
      try {
        l.deliver(event);
      } catch {
        // A listener that throws is a connection on its way out. It must not stop the others
        // hearing the prompt, and it must not make the event look undelivered.
        this.#listeners.delete(l.id);
      }
    }
    return event;
  }
}
