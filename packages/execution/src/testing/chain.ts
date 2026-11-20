/**
 * The audit chain, in memory — a boundary fake, not a mock of this
 * package's own logic.
 *
 * The chain is INJECTED (ADR-0020's writer takes a `pg` client and this
 * package holds none), so a test that wants to see the one entry an
 * execution owes has to be handed something to append to. There is no
 * in-memory chain anywhere else in the repo: every existing writer chains
 * into real Postgres from an integration suite, and this package's suites
 * are hermetic by construction.
 *
 * Test plumbing, source-only: `src/testing` is excluded from the build, so
 * this never ships.
 */
import type { ExecutionAuditChain, ExecutionAuditEntry } from "../audit.js";

export interface RecordingChain {
  readonly chain: ExecutionAuditChain;
  /** Every entry appended, in order. */
  readonly entries: ExecutionAuditEntry[];
}

/** A chain that keeps what it is given and nothing more. */
export function recordingChain(): RecordingChain {
  const entries: ExecutionAuditEntry[] = [];
  return {
    entries,
    chain: {
      append: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    },
  };
}
