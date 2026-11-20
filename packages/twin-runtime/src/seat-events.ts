/**
 * THE SEAT'S EVENT BUS: what the runtime writes while it works, and what the
 * local API's stream reads (ticket #263; spec #258 decision 14; ADR-0010).
 *
 * IN-PROCESS, AND ADR-0010 IS WHY THAT IS ENOUGH. One twin has one lease
 * holder, and the lease holder is the one process that runs the twin's
 * executions AND serves its local API — so the writer and every reader of a
 * seat's events are in the same process by construction. A broker between
 * them would be a second service carrying a twin's replies for a topology that
 * cannot exist.
 *
 * EPHEMERAL BY DESIGN. Nothing here is stored: an event published while no
 * stream is open is gone, which is the contract rather than a loss — a token
 * is a preview of a post that is written durably at the end, and a page that
 * was not listening reads that post when it opens (`TwinStreamEvent` argues
 * each word).
 *
 * KEYED BY SEAT, AND THE KEY IS THE FENCE. A publisher names the seat a
 * `dashboard_messages` row was typed under, and a stream subscribes under the
 * seat the API's three fences resolved — so an event can only reach a stream
 * opened for the seat it was published for, and there is no broadcast.
 */
import type { TwinStreamEvent } from "@dito/seam";

/** One subscriber: a stream writing a seat's events to its socket. */
export type SeatEventListener = (event: TwinStreamEvent) => void;

/** The bus, as the runtime and the local API each hold it. */
export interface SeatEvents {
  /** Hands `event` to every stream open for `seatId`, and to no other. */
  publish(seatId: string, event: TwinStreamEvent): void;
  /** Starts hearing `seatId`'s events; answers the unsubscribe. */
  subscribe(seatId: string, listener: SeatEventListener): () => void;
}

export function createSeatEvents(): SeatEvents {
  const bySeat = new Map<string, Set<SeatEventListener>>();
  return {
    publish(seatId, event) {
      for (const listener of [...(bySeat.get(seatId) ?? [])]) {
        // ONE LISTENER'S FAILURE IS ITS OWN. A stream whose socket went away
        // between the publish and the write must not stop the next stream
        // hearing the event — and above all must not throw into the execution
        // that published it, whose reply is still being composed.
        try {
          listener(event);
        } catch {
          // The stream that threw unsubscribes itself when its socket closes.
        }
      }
    },
    subscribe(seatId, listener) {
      let listeners = bySeat.get(seatId);
      if (listeners === undefined) {
        listeners = new Set();
        bySeat.set(seatId, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = bySeat.get(seatId);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) bySeat.delete(seatId);
      };
    },
  };
}
