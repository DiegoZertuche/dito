/**
 * The scripted model server, at its own wire (ticket #328): what an SDK
 * child pointed at it receives for a tool turn and a text turn, streamed and
 * not, and what it answers to everything it does not serve.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeScriptedModels,
  promptOf,
  scriptedModel,
  systemOf,
  toolNamesOf,
  toolResultsOf,
} from "./index.js";

afterEach(closeScriptedModels);

/** A request body shaped like the one the CLI sends. */
function body(stream: boolean): Record<string, unknown> {
  return {
    model: "claude-sonnet-5",
    max_tokens: 512,
    stream,
    system: [
      { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: "text", text: "## grounding\n\nAnswer only." },
    ],
    tools: [{ name: "mcp__dito__read_timeline" }, { name: "mcp__dito__submit_answer" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "## question\n\n¿Torres?" }] },
      { role: "system", content: "<system-reminder>Today's date is 2026-10-03.</system-reminder>" },
    ],
  };
}

async function post(url: string, value: unknown, session?: string): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session === undefined ? {} : { "x-claude-code-session-id": session }),
    },
    body: JSON.stringify(value),
  });
}

/** The server-sent events of one streamed response, parsed. */
function events(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data?.slice("data: ".length) ?? "null") as Record<string, unknown>;
    });
}

describe("the scripted model serves the Messages wire", () => {
  it("streams a tool turn from message_start to message_stop, under the name the request offered", async () => {
    const { harness, requests } = scriptedModel([
      { toolCall: { name: "submit_answer", input: { prose: "El jueves, a primera hora." } } },
    ]);

    const response = await post(`${harness.baseUrl}/v1/messages?beta=true`, body(true));

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = events(await response.text());
    expect(frames.map((frame) => frame["type"])[0]).toBe("message_start");
    expect(frames.at(-1)?.["type"]).toBe("message_stop");
    expect(frames[1]).toMatchObject({
      type: "content_block_start",
      content_block: { type: "tool_use", name: "mcp__dito__submit_answer", id: "toolu_scripted_1" },
    });
    const pieces = frames
      .filter((frame) => frame["type"] === "content_block_delta")
      .map((frame) => (frame["delta"] as { partial_json: string }).partial_json);
    expect(pieces.length).toBeGreaterThan(1);
    expect(JSON.parse(pieces.join(""))).toEqual({ prose: "El jueves, a primera hora." });
    expect(frames.find((frame) => frame["type"] === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
    });
    expect(requests).toHaveLength(1);
  });

  it("writes a stream frame by frame, so its start arrives before its end is written", async () => {
    const { harness } = scriptedModel([
      { toolCall: { name: "submit_answer", input: { prose: "El jueves, a primera hora." } } },
    ]);

    const response = await post(`${harness.baseUrl}/v1/messages`, body(true));
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("message_start");
    expect(chunks[0]).not.toContain("message_stop");
  });

  it("answers a text turn as JSON when no stream was asked for", async () => {
    const { harness } = scriptedModel([
      { text: "listo", stopReason: "max_tokens", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);

    const response = await post(`${harness.baseUrl}/v1/messages`, body(false));

    expect(await response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "listo" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 7, output_tokens: 3 },
    });
  });

  it("answers the token count without spending a scripted turn", async () => {
    const { harness, requests } = scriptedModel([]);

    const response = await post(`${harness.baseUrl}/v1/messages/count_tokens`, body(false));

    expect(response.status).toBe(200);
    expect((await response.json()) as { input_tokens: number }).toMatchObject({
      input_tokens: expect.any(Number) as number,
    });
    expect(requests).toHaveLength(0);
  });

  it("refuses an exhausted script with a 400 that names it", async () => {
    const { harness } = scriptedModel([]);

    const response = await post(`${harness.baseUrl}/v1/messages`, body(false));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("scripted model exhausted");
  });

  it("answers a request the script refuses with a 400 that carries the reason", async () => {
    const { harness } = scriptedModel([{ text: "listo" }], {
      onRequest: () => Promise.reject(new Error("the provider refused this request")),
    });

    const response = await post(`${harness.baseUrl}/v1/messages`, body(false));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("the provider refused this request");
  });

  it("answers a request that offers none of our tools without spending a turn, and keeps it apart", async () => {
    const { harness, requests, foreign } = scriptedModel([{ text: "listo" }]);

    const side = await post(`${harness.baseUrl}/v1/messages`, { ...body(false), tools: [] });
    expect(await side.json()).toMatchObject({ stop_reason: "end_turn" });
    const ours = await post(`${harness.baseUrl}/v1/messages`, body(false));

    expect(await ours.json()).toMatchObject({ content: [{ type: "text", text: "listo" }] });
    expect(foreign).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("refuses two executions interleaving on one list, and keeps a rule's cursors apart", async () => {
    const list = scriptedModel([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect((await post(`${list.harness.baseUrl}/v1/messages`, body(false), "s1")).status).toBe(200);
    expect((await post(`${list.harness.baseUrl}/v1/messages`, body(false), "s2")).status).toBe(200);
    const interleaved = await post(`${list.harness.baseUrl}/v1/messages`, body(false), "s1");
    expect(interleaved.status).toBe(400);
    expect(await interleaved.text()).toContain("two executions ran at once");

    const rule = scriptedModel(() => [{ text: "first" }, { text: "second" }]);
    const said = async (session: string): Promise<unknown> =>
      ((await (await post(`${rule.harness.baseUrl}/v1/messages`, body(false), session)).json()) as {
        content: { text: string }[];
      }).content[0]!.text;
    expect([await said("s1"), await said("s2"), await said("s1")]).toEqual([
      "first",
      "first",
      "second",
    ]);
    expect(rule.servedBy).toEqual(["conversation s1", "conversation s2", "conversation s1"]);
  });

  it("answers the CLI's probe and anything unrouted with a 404 naming the path", async () => {
    const { harness } = scriptedModel([]);
    const origin = new URL(harness.baseUrl).origin;

    const probe = await fetch(`${origin}/api/hello`, { method: "HEAD" });
    expect(probe.status).toBe(404);

    const stray = await post(`${harness.baseUrl}/v1/files`, {});
    expect(stray.status).toBe(404);
    expect(await stray.text()).toContain("/v1/files");
  });

  it("takes the route down and the harness directory with it on close", async () => {
    const model = scriptedModel([{ text: "listo" }]);
    expect(existsSync(model.harness.directory)).toBe(true);

    model.close();

    expect(existsSync(model.harness.directory)).toBe(false);
    const response = await post(`${model.harness.baseUrl}/v1/messages`, body(false));
    expect(response.status).toBe(404);
  });
});

describe("the readers find our words among the CLI's", () => {
  it("reads the prompt, the system text, the tool names and the tool results", () => {
    const request = {
      ...body(true),
      messages: [
        ...(body(true)["messages"] as unknown[]),
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__dito__read_timeline", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '[{"ref":"f1"}]' }] }],
        },
      ],
    };

    expect(promptOf(request)).toBe("## question\n\n¿Torres?");
    expect(systemOf(request)).toContain("## grounding\n\nAnswer only.");
    expect(toolNamesOf(request)).toEqual(["read_timeline", "submit_answer"]);
    expect(toolResultsOf(request)).toEqual(['[{"ref":"f1"}]']);
  });
});
