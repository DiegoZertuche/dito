/**
 * THE ORDER A PASS'S TURNS REACH THE DAY'S SESSION (ticket #358; ADR-0012 —
 * the pass reads its rows in order; ADR-0014 as amended — a turn on the day
 * session is one wake).
 *
 * A pass raises its thread turns in order — the lines typed at the doors,
 * then the rep's wordless asks, then the told events — and submits each to
 * the realtime lane, which runs up to four at once. Inside its task each turn
 * awaits things of its own before it wakes the session (the day's lease, a
 * connection, a transaction), so two tasks submitted in order could reach
 * `wake()` in either order, and the session runs its turns in the order it
 * received them. So each turn takes a place when it is submitted and hands
 * itself to the session only once the turn before it has: the hand-over is
 * ordered, the turns are not — each awaits its own settlement outside the
 * order, and the lane still runs them side by side.
 */

/** One turn's place: when it may hand itself over, and the call that says it has. */
export interface HandOver {
  /** Resolves once the turn before this one has handed itself over (or ended without). */
  readonly ready: Promise<void>;
  /** This turn is with the session — or ended without reaching it. Idempotent. */
  handed(): void;
}

/** A pass's places, given out in the order it submits its turns. */
export class HandOverOrder {
  #last: Promise<void> = Promise.resolve();

  /** The next place, behind every place given out before it. */
  next(): HandOver {
    const ready = this.#last;
    let handed = (): void => undefined;
    this.#last = new Promise<void>((resolve) => {
      handed = resolve;
    });
    return { ready, handed };
  }
}
