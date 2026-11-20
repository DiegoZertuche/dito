/**
 * WHAT A LANE RUN COST AND HOW LONG EACH CALL TOOK (ticket #148, AC 2).
 *
 * The precision lane printed one elapsed total over N model calls, which
 * answers neither question this ticket asks. Moving from Haiku 4.5 to
 * Sonnet 5 is a decision about latency and money as much as about dates —
 * Sonnet is 2× the input price and 2× the output price, and it thinks
 * before it answers — so the table needs per-CALL latency and a per-RUN
 * cost, not a wall-clock total.
 *
 * A LOOPBACK PASS-THROUGH, because that is the only layer that can see
 * both (ticket #328). The model calls are the Claude Agent SDK child's, made
 * from its own process, so nothing in this one can wrap them: the harness
 * points the child at a local server that forwards every request to the
 * provider unchanged and reads each response as it passes — the timing from
 * the clock, the numbers from the stream's own `message_start` and
 * `message_delta` events. Nothing here reads a header.
 *
 * WHAT A ROW IS: ONE ROUND, NOT ONE CHAT-DAY (ticket #199). The extraction
 * automation's budget is eight rounds, so a day that searches before it
 * files spends several requests — and every figure below is therefore per
 * ROUND, with the RUN totals summed over all of them. What one chat-day
 * cost is the report's own `cost` block, attributed off the runner's trace,
 * which is the only instrument that can tell one day's rounds from the
 * next's.
 *
 * THIS IS THE LANE'S INSTRUMENT, NOT THE RUNTIME'S. It is composed in the
 * two scripts that construct their own harness, and nothing under `src/`
 * knows it exists — the rig's harness is built elsewhere and is untouched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "@dito/execution";

/** One API call, as the meter saw it. */
export interface MeteredCall {
  /** Wall clock around the request, milliseconds. */
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly stopReason: string | null;
  /**
   * The HTTP status this response carried (Codex r2).
   *
   * RECORDED BECAUSE THE CHILD RETRIES ITSELF. A 429 or a 5xx is retried
   * automatically, so one ROUND can produce several rows here — and the
   * failed ones carry no tokens and a short fetch time, which would drag
   * the median down and inflate the call count exactly when service is
   * degraded. They are counted apart rather than silently averaged in, and
   * the renderer says so when there are any.
   */
  readonly status: number;
}

/**
 * Dollars per million tokens, per model (2026-09-02, from the ticket).
 *
 * A LOOKUP THAT CAN MISS, and says so rather than guessing. An unknown
 * model returns no cost at all — a table printing $0.00 for a model whose
 * price nobody entered is worse than one printing a dash, because the zero
 * reads as a measurement.
 */
const PRICES: Readonly<
  Record<
    string,
    readonly { readonly label: string; readonly inputPerMTok: number; readonly outputPerMTok: number }[]
  >
> = {
  // TWO RATES FOR SONNET 5, AND THE LANE PRINTS BOTH (ticket #148, both
  // review axes). The ticket says to price it at $2/$10; ADR-0015's
  // pricing note, taken at AD triage on 2026-08-26, says all planning
  // numbers use standard $3/$15 because the intro pricing ends
  // 2026-08-31. They disagree, and this measurement is the input to a
  // money decision — so picking one silently would understate or
  // overstate the switch by a third with nothing on the page to say so.
  // Which rate COGS uses is the owner's call and is recorded on #148.
  "claude-sonnet-5": [
    { label: "the ticket's $2/$10", inputPerMTok: 2, outputPerMTok: 10 },
    { label: "ADR-0015 planning $3/$15", inputPerMTok: 3, outputPerMTok: 15 },
  ],
  "claude-haiku-4-5": [{ label: "$1/$5", inputPerMTok: 1, outputPerMTok: 5 }],
};

/**
 * What a run's calls cost, or undefined for a model with no price here.
 *
 * Cache tokens are priced at the API's published multipliers — a write at
 * 1.25× input, a read at 0.1× input. The Claude Code child marks its
 * system prompt and its reminders for caching on every call (#328), so on
 * a real run both columns carry most of the input.
 */
export function costUsd(
  model: string,
  calls: readonly MeteredCall[],
): readonly { readonly label: string; readonly usd: number }[] | undefined {
  const prices = PRICES[model];
  if (prices === undefined) return undefined;
  return prices.map((price) => {
    let usd = 0;
    for (const call of calls) {
      usd +=
        ((call.inputTokens +
          call.cacheWriteTokens * 1.25 +
          call.cacheReadTokens * 0.1) *
          price.inputPerMTok) /
          1_000_000 +
        (call.outputTokens * price.outputPerMTok) / 1_000_000;
    }
    return { label: price.label, usd };
  });
}

/** The provider every metered call is forwarded to. */
const UPSTREAM = "https://api.anthropic.com";

/**
 * A harness holding the real key, whose every model call is timed and
 * counted on its way through.
 *
 * `close` stops the pass-through and removes the harness directory; a lane
 * calls it once its last execution has ended.
 */
export async function meteredHarness(apiKey: string): Promise<{
  readonly harness: Harness;
  readonly calls: MeteredCall[];
  readonly close: () => Promise<void>;
}> {
  const calls: MeteredCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === "host" || name === "content-length" || value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const startedAt = Date.now();
      const upstream = await fetch(`${UPSTREAM}${request.url ?? "/"}`, {
        method: request.method ?? "GET",
        headers,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      const text = await upstream.text();
      // ONLY THE MODEL CALLS ARE ROWS: the child's probe and its token
      // counts pass through unmetered.
      if ((request.url ?? "").split("?")[0] === "/v1/messages") {
        calls.push({ ms: Date.now() - startedAt, status: upstream.status, ...usageOf(text) });
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(text);
    })().catch((error: unknown) => {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`the metering pass-through failed: ${String(error)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "dito-metered-harness-"));
  return {
    harness: {
      directory,
      apiKey,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    calls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * What one response spent, read off its server-sent events — or its JSON,
 * for a response that did not stream. A body neither parses is an API error
 * the child is about to report properly, and counts nothing.
 */
function usageOf(text: string): Omit<MeteredCall, "ms" | "status"> {
  const spent = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    stopReason: null as string | null,
  };
  const n = (usage: Record<string, unknown> | undefined, key: string): number | undefined =>
    typeof usage?.[key] === "number" ? (usage[key] as number) : undefined;
  const read = (event: {
    type?: string;
    message?: { usage?: Record<string, unknown> };
    usage?: Record<string, unknown>;
    delta?: { stop_reason?: string | null };
    stop_reason?: string | null;
  }): void => {
    const usage = event.type === "message_start" ? event.message?.usage : event.usage;
    spent.inputTokens = n(usage, "input_tokens") ?? spent.inputTokens;
    spent.outputTokens = n(usage, "output_tokens") ?? spent.outputTokens;
    spent.cacheWriteTokens = n(usage, "cache_creation_input_tokens") ?? spent.cacheWriteTokens;
    spent.cacheReadTokens = n(usage, "cache_read_input_tokens") ?? spent.cacheReadTokens;
    spent.stopReason = event.delta?.stop_reason ?? event.stop_reason ?? spent.stopReason;
  };
  try {
    if (text.trimStart().startsWith("{")) {
      read(JSON.parse(text) as Parameters<typeof read>[0]);
    } else {
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) read(JSON.parse(line.slice(6)) as Parameters<typeof read>[0]);
      }
    }
  } catch {
    // Unparseable: counted as nothing, never as a different error.
  }
  return spent;
}

/** The per-call table and the run's totals, for the terminal. */
export function renderMeter(
  model: string,
  effort: string | undefined,
  calls: readonly MeteredCall[],
): string {
  const out: string[] = [];
  // ONLY THE ANSWERS COUNT AS CALLS. A retried 429 is not a round.
  const answered = calls.filter((call) => call.status === 200);
  const retried = calls.filter((call) => call.status !== 200);
  const latencies = answered.map((call) => call.ms).sort((a, b) => a - b);
  const total = (pick: (call: MeteredCall) => number): number =>
    answered.reduce((sum, call) => sum + pick(call), 0);
  const priced = costUsd(model, answered);
  out.push(
    `WHAT THE RUN COST — ${answered.length} answered model call(s) on ${model} at effort ${effort ?? "(the model's own default)"}`,
  );
  if (retried.length > 0) {
    // Loud, because it changes how the latency below should be read: the
    // backoff between a retry and its retry is not in these numbers at all.
    out.push(
      `  RETRIES           ${retried.length} non-200 response(s) (${[...new Set(retried.map((c) => c.status))].join(", ")}) are excluded from every figure below — the child retried them, so a chat-day here cost more wall clock than the median says`,
    );
  }
  out.push(
    `  latency per call  median ${median(latencies)} ms   min ${latencies[0] ?? 0} ms   max ${latencies[latencies.length - 1] ?? 0} ms   total ${Math.round(total((c) => c.ms) / 1000)} s`,
  );
  out.push(
    `  tokens            ${total((c) => c.inputTokens)} in, ${total((c) => c.outputTokens)} out (${total((c) => c.cacheWriteTokens)} cache write, ${total((c) => c.cacheReadTokens)} cache read)`,
  );
  out.push(
    priced === undefined
      ? `  cost              — (no price recorded for ${model}; add it to metering.ts rather than reading a zero)`
      : `  cost              ${priced.map((p) => `$${p.usd.toFixed(4)} (${p.label})`).join("   ")}`,
  );
  const truncated = answered.filter((call) => call.stopReason === "max_tokens");
  out.push(
    truncated.length === 0
      ? "  stop reasons      none hit the token ceiling"
      : `  CEILING HIT       ${truncated.length} call(s) ended on max_tokens — the answer was cut off, which is the #148 failure returning`,
  );
  out.push("  per call, in order:");
  for (const [index, call] of answered.entries()) {
    out.push(
      `    ${String(index + 1).padStart(3)}  ${String(call.ms).padStart(6)} ms  ${String(call.inputTokens).padStart(6)} in  ${String(call.outputTokens).padStart(6)} out  ${call.stopReason ?? "—"}`,
    );
  }
  return out.join("\n");
}

/** The middle value of an already-sorted list; 0 for an empty one. */
function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
