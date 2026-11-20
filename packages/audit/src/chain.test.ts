/**
 * Hash-chain tests (ADR-0020 skeleton). Real HMAC — the chain must verify
 * end to end and every form of tampering must be detectable.
 */
import { describe, expect, it } from "vitest";
import {
  appendEntry,
  verifyChain,
  type AuditEntry,
  type ChainedEntry,
} from "./chain.js";

const HMAC_KEY = new TextEncoder().encode(
  "dito-test-audit-hmac-key-32-bytes-plus",
);

/**
 * Three content-free refusal entries, in the send-lock writer's own shape.
 *
 * THE WORDS CAME FROM THE FENCE (ticket #78). These fixtures used to invent
 * `send_refused_off_allowlist` and `send_refused_pacing` — words no writer
 * has produced since #24 shipped `customer_send` with the reason in the
 * outcome. Typing `AuditEntry.action` by the closed vocabulary is what
 * surfaced them: the drift had been invisible because the fixture and the
 * writer agreed about nothing at all.
 */
function buildChain(): ChainedEntry[] {
  const entries: ChainedEntry[] = [];
  const inputs: AuditEntry[] = [
    {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: "draft:6b1f6ac0-0000-4000-8000-000000000001",
      outcome: "refused:off_allowlist",
    },
    {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: "draft:6b1f6ac0-0000-4000-8000-000000000002",
      outcome: "refused:pacing",
    },
    {
      caller: "affirmation_matcher",
      action: "customer_send",
      ref: null,
      outcome: "refused:off_allowlist",
    },
  ];
  for (const input of inputs) {
    entries.push(appendEntry(HMAC_KEY, entries.at(-1) ?? null, input));
  }
  return entries;
}

describe("audit hash chain (ADR-0020)", () => {
  it("verifies an intact chain and detects a tampered entry", () => {
    const chain = buildChain();
    expect(verifyChain(HMAC_KEY, chain)).toBe(true);

    const tampered = chain.map((e, i) =>
      i === 1 ? { ...e, outcome: "sent" } : e,
    );
    expect(verifyChain(HMAC_KEY, tampered)).toBe(false);
  });

  it("detects a removed entry", () => {
    const chain = buildChain();
    expect(verifyChain(HMAC_KEY, [chain[0]!, chain[2]!])).toBe(false);
  });

  it("detects reordering", () => {
    const chain = buildChain();
    expect(verifyChain(HMAC_KEY, [chain[1]!, chain[0]!, chain[2]!])).toBe(
      false,
    );
  });

  it("detects a truncated head: the chain must start from null", () => {
    const chain = buildChain();
    expect(verifyChain(HMAC_KEY, chain.slice(1))).toBe(false);
  });

  it("rejects verification under a different HMAC key", () => {
    const chain = buildChain();
    expect(
      verifyChain(
        new TextEncoder().encode("some-other-key-padded-to-32-bytes"),
        chain,
      ),
    ).toBe(false);
  });

  it("refuses a weak HMAC key at both primitives — never chains forgeable hashes", () => {
    const weak = new TextEncoder().encode("short-key");
    expect(() =>
      appendEntry(weak, null, {
        caller: "affirmation_matcher",
        action: "customer_send",
        ref: null,
        outcome: "refused:pacing",
      }),
    ).toThrow(/32 bytes/);
    expect(() => verifyChain(weak, buildChain())).toThrow(/32 bytes/);
  });

  it("accepts the empty chain and a chain truncated only at the tail (tamper-evidence is forward-only)", () => {
    const chain = buildChain();
    expect(verifyChain(HMAC_KEY, [])).toBe(true);
    // Dropping the newest entries is not detectable from the chain alone —
    // that is what the append-only table trigger and row count are for.
    expect(verifyChain(HMAC_KEY, chain.slice(0, 2))).toBe(true);
  });
});
