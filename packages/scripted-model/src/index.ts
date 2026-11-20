/**
 * The scripted model — the pre-agreed test seam at the model boundary
 * (spec #18; ADR-0028 as amended: CI never makes a real model call). The
 * REAL runner, the REAL Claude Agent SDK and the REAL Claude Code child run;
 * only the model is scripted: a loopback server speaking the Anthropic
 * Messages wire answers `/v1/messages` from a fixed turn list, and the
 * child is pointed at it by its harness (spec #318, *Testing decisions*;
 * ticket #328). The real-call path is the same code with a real key and no
 * base URL.
 *
 * ONE SERVER PER PROCESS, ONE ROUTE PER SCRIPT. The server binds once, when
 * this module loads, so `scriptedModel` stays a plain function every suite
 * can call wherever it builds its dependencies: each call takes a path of
 * its own under the server and hands out a base URL ending in it, which the
 * CLI keeps as the prefix of every request it makes. `close` takes the
 * route down and removes the harness directory; a request that arrives
 * after it is answered 404, never served another script's turn.
 *
 * WHY IT IS ITS OWN PACKAGE (ticket #128). Every package's `src/testing` is
 * excluded from its build, so no second package could reach a fake kept in
 * one of them, and `packages/execution` may not depend on twin-runtime at
 * all. One dev-only workspace package that every suite takes as a
 * devDependency leaves the wire in exactly one place.
 */
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What one scripted turn reports as spent.
 *
 * OPTIONAL ON PURPOSE (ticket #128): omitted, a turn reports one input and
 * one output token, which is right for a suite asserting what the model
 * SAID; a suite asserting what an execution SPENT names its numbers.
 */
export interface ScriptedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The provider's stop reason for a turn that was cut off (#176; #177
 * hotfix 1).
 *
 * Omitted means the model finished: `tool_use` for a call, `end_turn` for
 * text. The two words below are the only ones a script can say instead, so
 * there are never two ways to script one ending — and they are what the
 * truncation guard has to be shown refusing: a complete tool call under
 * either flag, and text that stopped mid-sentence.
 */
export type ScriptedCutoff = "max_tokens" | "model_context_window_exceeded";

/** One scripted assistant turn: a tool call, several, plain text, or a structured output. */
export type ScriptedTurn =
  | {
      readonly toolCall: { readonly name: string; readonly input: unknown };
      readonly usage?: ScriptedUsage;
      readonly stopReason?: ScriptedCutoff;
    }
  | {
      /**
       * SEVERAL TOOL CALLS IN ONE RESPONSE (ticket #195, Codex round 1): the
       * shape a one-submission contract must refuse even inside a single
       * round, and the shape that puts two handlers on one connection.
       */
      readonly toolCalls: readonly {
        readonly name: string;
        readonly input: unknown;
      }[];
      readonly usage?: ScriptedUsage;
      readonly stopReason?: ScriptedCutoff;
    }
  | {
      readonly text: string;
      readonly usage?: ScriptedUsage;
      readonly stopReason?: ScriptedCutoff;
    }
  | {
      /**
       * THE TURN'S STRUCTURED OUTPUT (ticket #357): served as the model calls
       * it, a call to the CLI's own `StructuredOutput` tool, so the real CLI
       * validates it against the execution's `outputFormat` and ends the turn
       * on it — or answers the mismatch and asks again, as it does a model.
       */
      readonly structured: unknown;
      readonly usage?: ScriptedUsage;
      readonly stopReason?: ScriptedCutoff;
    };

/**
 * The twin thread's deliberate silence, scripted (tickets #35, #363): the
 * model stops without writing anything, which is the whole of a silence now
 * that the thread's words are its final message.
 *
 * Since routing became total, every unquoted rep text in the twin thread
 * reaches a thread turn — so suites that plant a self-chat note while testing
 * something else (ingest, embedding) must script what the twin does with it.
 * Silence is the honest scripting for a note-to-self, and saying so in one
 * place keeps the suites that merely PASS THROUGH the routing from each
 * re-encoding how a turn ends.
 */
export function qaSilenceTurns(): ScriptedTurn[] {
  return [{ text: "" }];
}

/**
 * The kind determination, scripted (tickets #60, #363). Every entity created
 * from a binding carries one, so every suite that crosses a binding must
 * script it — `times` because a backlog sweep asks once per binding and an
 * exhausted script is a loud failure, never an improvised answer.
 *
 * ONE TURN PER DETERMINATION (ticket #154): the classification's typed
 * output, which ends its turn. A spare turn would be handed to the NEXT
 * determination's request.
 */
export function entityKindTurns(
  kind: "person" | "business" = "person",
  times = 1,
): ScriptedTurn[] {
  return Array.from({ length: times }, () => ({ structured: { kind } }));
}

/**
 * The wire fields an extraction item may leave empty (ticket #194).
 *
 * THE SCHEMA IS FLAT AND FULLY-REQUIRED — every field present on every item,
 * null where it does not apply — so a fixture that named only the two fields
 * its claim is about would be scripting a submission the contract refuses.
 * Filled in here, once, for every suite that scripts this tool.
 */
const NULLABLE_EXTRACTION_FIELDS = [
  "item",
  "quantity",
  "unit",
  "amount",
  "currency",
  "commitment",
  "due_on",
  "pattern",
  "contact_name",
  "role",
  "phones",
  "emails",
  "rfcs",
];

/**
 * ONE LOOK AN EXTRACTION MAKES BEFORE IT FILES (ticket #196).
 *
 * The tool CALL is scripted and its RESULT is not: the reads are real, over a
 * real bundle and a real connection, so what comes back is what the seeded
 * store holds. That is the whole point of scripting at the wire — «what the
 * execution was shown changed what it did» is only provable if what it was
 * shown is real (`Script`'s own note).
 */
export interface ScriptedLook {
  readonly tool: string;
  readonly input: unknown;
}

/** A day that LOOKS before it files (ticket #196). */
export interface ExtractionScript {
  /** The reads this day makes, in order — one round each. */
  readonly looks: readonly ScriptedLook[];
  /** What it files after them. */
  readonly facts?: readonly Record<string, unknown>[];
}

/**
 * One chat-day's extraction step, scripted (tickets #194, #364): the call to
 * `file_facts` and then the model finishing.
 *
 * TWO TURNS, AND THE SECOND IS THE MODEL FINISHING. A refused call is
 * feedback the model can act on, so the loop serves the tool result and asks
 * again; the second turn is the model stopping. Omit it and the NEXT chat's
 * request finds the script exhausted.
 *
 * ONE HELPER RATHER THAN FOUR (the brief's own rule: extend, do not fork).
 * The extraction, corrections and own-sends suites all script this wire, and
 * a shape that changes — as it just did — has to change once.
 *
 * ...AND IT SCRIPTS THE LOOKS TOO (ticket #196), in the same helper and for
 * the same reason: a day that searches before it files is the same wire
 * with rounds in front of it, and a second helper would be the copy that
 * drifts.
 * The tool CALLS are scripted and their RESULTS are not — the reads run for
 * real against the seeded bundle and the real connection, which is what makes
 * a resolution a claim about the store rather than about the fixture.
 *
 * THE READING DEFAULTS TO `stated` (ticket #66): it is a required wire field
 * with a closed vocabulary rather than a nullable one, and a fixture about a
 * fact whose words say everything the record holds is the ordinary reading. A
 * fixture testing the other one passes it explicitly.
 */
export function extractionTurns(
  ...facts: readonly Record<string, unknown>[]
): ScriptedTurn[];
export function extractionTurns(script: ExtractionScript): ScriptedTurn[];
export function extractionTurns(
  ...given: readonly (Record<string, unknown> | ExtractionScript)[]
): ScriptedTurn[] {
  const script = asScript(given);
  return [
    // ONE ROUND PER LOOK, because that is what the loop really does: the SDK
    // serves each response's tool results and asks again, so a day that
    // searches and then files is two model calls.
    ...script.looks.map(
      (look): ScriptedTurn => ({
        toolCall: { name: look.tool, input: look.input },
      }),
    ),
    {
      toolCall: {
        name: "file_facts",
        input: {
          facts: (script.facts ?? []).map((fact) => {
            const full: Record<string, unknown> = { reading: "stated", ...fact };
            for (const key of NULLABLE_EXTRACTION_FIELDS) {
              if (!(key in full)) full[key] = null;
            }
            return full;
          }),
        },
      },
    },
    { text: "done" },
  ];
}

/**
 * The two call shapes, as one value.
 *
 * DISCRIMINATED BY `looks`, which is a key no wire item has: a filed fact's
 * fields are the flat fully-required set above, and a fixture that wrote one
 * called `looks` would be scripting a call the tool refuses anyway.
 * The variadic form is kept because four suites call it and none of them
 * looks at anything.
 */
function asScript(
  given: readonly (Record<string, unknown> | ExtractionScript)[],
): ExtractionScript {
  const first = given[0];
  if (given.length === 1 && first !== undefined && "looks" in first) {
    return first as ExtractionScript;
  }
  return { looks: [], facts: given as readonly Record<string, unknown>[] };
}

/**
 * What one day's disclosure posts around its lines (ticket #198).
 *
 * TWO SENTENCES, AND THAT IS THE WHOLE CONTRACT (ticket #218; spec #214
 * decision 3): the candidate-question route is retired, so what a fixture
 * composes is the prose around the day's own lines and nothing else.
 */
export interface DisclosureScript {
  /** The sentence that opens the post. */
  readonly opening: string;
  /** ...and the one that tells the rep how to correct a line. */
  readonly closing: string;
}

/**
 * One day's disclosure, scripted (ticket #198).
 *
 * TWO TURNS, AND THE SECOND IS THE MODEL FINISHING: the call to
 * `post_disclosure`, whose refusal by the structural guard is feedback (spec
 * #193 decision 23), and then the model stopping; omit the second turn and the
 * NEXT execution's request finds the script exhausted.
 *
 * THE PROSE IS THE CALLER'S, and it has to be: this package is swept by the
 * composed-language rule like every other source (`SWEPT_PACKAGES`), so a
 * helper that wrote a Spanish opening for its callers would be the offender
 * that sweep exists to find. A fixture writes what it wants the rep to read,
 * which is also what makes an assertion about a post readable.
 *
 * WHAT IT DOES NOT DO IS SATISFY THE GUARD FOR YOU. A lead for a question
 * nothing served, a digit anywhere, or a customer's typed name is refused by
 * the tool exactly as it would be from a real model — which is the point
 * of scripting at the wire (ADR-0028 as amended).
 */
export function disclosureTurns(script: DisclosureScript): ScriptedTurn[] {
  return [
    {
      toolCall: {
        name: "post_disclosure",
        input: { opening: script.opening, closing: script.closing },
      },
    },
    { text: "done" },
  ];
}

/**
 * What a scripted run answers with: a fixed list of turns, or a RULE read
 * off a conversation's own prompt.
 *
 * The rule form exists for the one claim a fixed list cannot make — "what
 * the model was SHOWN changed what it did" (ticket #98; ADR-0041). Two
 * worlds scripted with two different lists prove only that the fixture
 * differed; two worlds scripted with the SAME rule, whose answers differ,
 * prove that the transcript did.
 *
 * A RULE IS READ PER TURN, AND KEEPS ITS OWN CURSOR (tickets #173, #319):
 * two executions in flight INTERLEAVE their requests, and a shared cursor
 * would serve the second conversation's first request the first one's
 * second turn. The rule is read off the newest prompt — the material the
 * model is judging: a single-message execution's only one, a session turn's
 * wake — and the cursor is keyed by the SDK child's session, so two
 * executions shown the same prompt still get two cursors (#328) and a
 * session's next turn starts its own (#319). A line folded into a running
 * turn reaches the model as the CLI's reminder beside a tool result, never as
 * a new prompt, so it never restarts the cursor of the turn it joined.
 *
 * THE LIST FORM KEEPS ONE CURSOR FOR THE WHOLE RUN: several suites script a
 * pass that runs two executions in sequence as one flat list and rely on the
 * second picking up where the first stopped. Two executions that run AT
 * ONCE cannot share a list: each child takes its own time to start, so their
 * requests interleave in an order no suite controls and two machines do not
 * agree on (#328's CI). The list refuses that loudly rather than hand one
 * execution the other's turn, and a suite with concurrent executions
 * scripts a rule.
 */
export type Script =
  | readonly ScriptedTurn[]
  | ((prompt: string) => readonly ScriptedTurn[]);

/**
 * Where a scripted execution's SDK child lives and which endpoint it talks
 * to — the shape of `@dito/execution`'s `Harness`, declared here rather than
 * imported because the execution package takes this one as a devDependency
 * and the two would otherwise depend on each other.
 */
export interface ScriptedHarness {
  readonly directory: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}

/**
 * ONE HIT OF A SCRIPTED WEB SEARCH (ticket #326): what the provider's own
 * search tool would hand back for a query — the page's title and address,
 * and the passage the model reads from it.
 */
export interface ScriptedWebHit {
  readonly title: string;
  readonly url: string;
  readonly text: string;
}

export interface ScriptedModel {
  /** A harness pointing an SDK child at this script's route. */
  readonly harness: ScriptedHarness;
  /**
   * The parsed JSON body of every `/v1/messages` request an execution made,
   * in order — one per model call, retries included. Only a request that
   * offers this execution's own tools is one (`isExecutionRequest`).
   */
  readonly requests: Record<string, unknown>[];
  /**
   * The SDK child's session for each entry of `requests`, at the same index —
   * what groups a session's requests by the conversation file they belong to.
   */
  readonly sessions: (string | undefined)[];
  /**
   * Which cursor served each entry of `requests`, at the same index:
   * `list`, or `conversation <session>` for the rule form — what a failing
   * suite reads to see which execution was handed which turn.
   */
  readonly servedBy: string[];
  /**
   * Every `/v1/messages` request that was NOT an execution's — a side call
   * of the CLI's own. Each is answered with an empty end of turn and
   * advances no cursor, so it can never take a scripted turn from one.
   */
  readonly foreign: Record<string, unknown>[];
  /**
   * THE QUERY OF EVERY WEB SEARCH THE CHILD MADE, in order (ticket #326):
   * the SDK's `WebSearch` is the CLI asking the provider a request of its
   * own, carrying the provider's search tool, and each is answered with the
   * script's hits and recorded here — so a suite counts the searches a turn
   * made without any reaching the web.
   */
  readonly searches: string[];
  /** Takes the route down and removes the harness directory. */
  readonly close: () => void;
}

/** One live script, as the server routes to it. */
type Route = (
  path: string,
  body: Record<string, unknown> | undefined,
  session: string | undefined,
) => Promise<Answer>;

/**
 * The header the Claude Code child stamps on every request with its own
 * session id — one per execution, since every execution is its own child.
 */
const SESSION_HEADER = "x-claude-code-session-id";

interface Answer {
  readonly status: number;
  readonly contentType: string;
  /** The whole body, or — for a stream — its frames, written one at a time. */
  readonly body: string | readonly string[];
}

const routes = new Map<string, Route>();
/** Every open script's own `close`, so a suite can close them all at once. */
const open = new Set<() => void>();
let nextRoute = 0;

/**
 * THE ROUTE PREFIX every scripted base URL carries. The CLI's own probe
 * (`HEAD /api/hello`) and anything else outside a route is answered 404,
 * naming the path, so a request nobody scripted shows up in a failing test
 * rather than as a hang.
 */
const ROUTE_PREFIX = "/scripted/";

const server = createServer((request, response) => {
  void serve(request, response);
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
// THE SERVER NEVER HOLDS ITS PROCESS OPEN: a suite that ends is a process
// that may exit, whatever routes it left up.
server.unref();
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  // A SCRIPT THAT THROWS IS A REQUEST THE PROVIDER REFUSED — `onRequest`
  // rejecting is how a suite says so — and it is answered as one: a 400 the
  // child reports as an API error, never a socket left open for it to wait on.
  const session = request.headers[SESSION_HEADER];
  const answer = await answerFor(
    request.method ?? "GET",
    path,
    raw,
    typeof session === "string" ? session : undefined,
  ).catch(
    (error: unknown): Answer =>
      json(400, { type: "error", error: { type: "invalid_request_error", message: String(error) } }),
  );
  response.writeHead(answer.status, { "content-type": answer.contentType });
  if (typeof answer.body === "string") {
    response.end(answer.body);
    return;
  }
  // A STREAM IS WRITTEN AS ONE: frame by frame, yielding to the event loop
  // between them, so a reader sees `message_start` before `message_stop`
  // exists — what the door's streaming is proven against (Codex r1).
  for (const frame of answer.body) {
    response.write(frame);
    await new Promise((resolve) => setImmediate(resolve));
  }
  response.end();
}

async function answerFor(
  method: string,
  path: string,
  raw: string,
  session: string | undefined,
): Promise<Answer> {
  if (method === "POST" && path.startsWith(ROUTE_PREFIX)) {
    const [id, ...rest] = path.slice(ROUTE_PREFIX.length).split("/");
    const route = routes.get(id ?? "");
    if (route !== undefined) {
      return await route(
        `/${rest.join("/")}`,
        JSON.parse(raw) as Record<string, unknown>,
        session,
      );
    }
  }
  return json(404, { type: "error", error: { type: "not_found_error", message: `the scripted model serves no ${method} ${path}` } });
}

function json(status: number, value: unknown): Answer {
  return { status, contentType: "application/json", body: JSON.stringify(value) };
}

/**
 * Builds the scripted model. The script must cover every request the run
 * makes — exhaustion is a loud failure, never an improvised reply.
 *
 * EXHAUSTION IS A 400, the provider's own word for a request it will not
 * answer. The CLI reports it as an API error result, which the runner reads
 * as a wire failure; it retries a 400 once without its newest beta header,
 * so an exhausted script logs two requests for the one call.
 *
 * `onRequest` runs before each scripted turn is served, and it is how a
 * suite reproduces something committing WHILE a pass is inside its model
 * call — the one window where a pass holds no transaction and no lock, and
 * therefore the only place a concurrent writer can land (ticket #53, Codex
 * r2). It is a test seam and nothing else: production has no hook.
 */
export function scriptedModel(
  script: Script,
  options: {
    onRequest?: (requestNumber: number) => Promise<void>;
    /**
     * What every web search the child makes finds (`ScriptedWebHit`); absent,
     * a search finds nothing — the honest empty a real search can return.
     */
    webSearch?: readonly ScriptedWebHit[];
  } = {},
): ScriptedModel {
  const requests: Record<string, unknown>[] = [];
  const searches: string[] = [];
  const sessions: (string | undefined)[] = [];
  const servedBy: string[] = [];
  const foreign: Record<string, unknown>[] = [];
  // The list form's single cursor, shared by every request of the run, and
  // the sessions it has served, in the order they first asked.
  let next = 0;
  const listSessions: string[] = [];
  const flat: readonly ScriptedTurn[] | undefined =
    typeof script === "function" ? undefined : script;
  // The rule form's cursors, one per conversation — keyed by the child's
  // session, which is one execution's alone, and by the prompt where a
  // request carries no session.
  const conversations = new Map<
    string,
    { prompt: string; turns: readonly ScriptedTurn[]; next: number }
  >();

  const route: Route = async (path, body, session) => {
    if (path === "/v1/messages/count_tokens") {
      // A PLAUSIBLE COUNT, never a scripted one: the CLI treats the endpoint
      // as optional and nothing here asserts on it.
      return json(200, { input_tokens: Math.ceil(JSON.stringify(body ?? {}).length / 4) });
    }
    if (path !== "/v1/messages" || body === undefined) {
      return json(404, { type: "error", error: { type: "not_found_error", message: `the scripted model serves no POST ${path}` } });
    }
    if (offersWebSearch(body)) {
      const query = searchedFor(body);
      searches.push(query);
      const found = webSearchMessage(query, options.webSearch ?? [], searches.length);
      return body["stream"] === true
        ? { status: 200, contentType: "text/event-stream", body: framesOf(found) }
        : json(200, found);
    }
    if (!isExecutionRequest(body)) {
      foreign.push(body);
      const message = messageOf({ text: "" }, body, 0);
      return body["stream"] === true
        ? { status: 200, contentType: "text/event-stream", body: framesOf(message) }
        : json(200, message);
    }
    requests.push(body);
    sessions.push(session);
    if (options.onRequest !== undefined) await options.onRequest(requests.length);
    // A SILENCE STAYS SILENT WHEN THE CLI ASKS FOR VISIBLE OUTPUT (ticket #363).
    // The child answers a response with no text by asking the model, once, to
    // produce some (`NO_VISIBLE_OUTPUT`); a scripted `{ text: "" }` is a model
    // that meant to say nothing, as the thread is told to, so it says nothing
    // again — and the script's next turn is the next thing the model does.
    if (asksForVisibleOutput(body)) {
      const silence = messageOf({ text: "" }, body, requests.length);
      return body["stream"] === true
        ? { status: 200, contentType: "text/event-stream", body: framesOf(silence) }
        : json(200, silence);
    }
    let turn: ScriptedTurn | undefined;
    if (flat === undefined) {
      const key = session ?? promptOf(body);
      const latest = latestPromptOf(body);
      servedBy.push(`conversation ${key.slice(0, 80)}`);
      let conversation = conversations.get(key);
      if (
        conversation === undefined ||
        (startsTurn(body) && conversation.prompt !== latest)
      ) {
        conversation = { prompt: latest, turns: resolveScript(script, latest), next: 0 };
        conversations.set(key, conversation);
      }
      turn = conversation.turns[conversation.next];
      conversation.next += 1;
    } else {
      servedBy.push("list");
      // TWO EXECUTIONS INTERLEAVING ON ONE LIST is refused, loudly: once a
      // second session has asked, a request from an earlier one means they
      // ran at once, and whichever turn the cursor holds is the wrong
      // execution's as often as not (`Script`).
      if (session !== undefined) {
        if (listSessions.includes(session) && listSessions.at(-1) !== session) {
          return json(400, {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `scripted model: two executions ran at once on one list script (request ${requests.length}); script a rule so each conversation keeps its own cursor`,
            },
          });
        }
        if (!listSessions.includes(session)) listSessions.push(session);
      }
      turn = flat[next];
      next += 1;
    }
    if (turn === undefined) {
      return json(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `scripted model exhausted: request ${requests.length} has no scripted turn`,
        },
      });
    }
    const message = messageOf(turn, body, requests.length);
    return body["stream"] === true
      ? { status: 200, contentType: "text/event-stream", body: framesOf(message) }
      : json(200, message);
  };

  const id = String((nextRoute += 1));
  routes.set(id, route);
  const directory = mkdtempSync(join(tmpdir(), "dito-scripted-harness-"));
  const close = (): void => {
    routes.delete(id);
    open.delete(close);
    rmSync(directory, { recursive: true, force: true });
  };
  open.add(close);
  return {
    harness: {
      directory,
      apiKey: "scripted-model",
      baseUrl: `${origin}${ROUTE_PREFIX}${id}`,
    },
    requests,
    sessions,
    servedBy,
    foreign,
    searches,
    close,
  };
}

/**
 * Whether a request is an execution's: it offers the model at least one tool
 * it calls by name — one of ours under the runner's server prefix, the CLI's
 * structured-output tool, or an SDK tool the execution names (ticket #326). A
 * side call the CLI makes on its own account offers none, and its web search
 * offers only the provider's own search tool, which carries a `type`.
 */
function isExecutionRequest(body: Record<string, unknown>): boolean {
  const tools = (body["tools"] ?? []) as { readonly type?: unknown }[];
  return tools.some((tool) => tool.type === undefined || tool.type === "custom");
}

/** Whether a request is the CLI's own web search: it offers the provider's search tool. */
function offersWebSearch(body: Record<string, unknown>): boolean {
  const tools = (body["tools"] ?? []) as { readonly type?: unknown }[];
  return tools.some((tool) => typeof tool.type === "string" && tool.type.startsWith("web_search"));
}

/** The query a web search request carries: the CLI's one line asking for it. */
function searchedFor(body: Record<string, unknown>): string {
  return latestPromptOf(body).replace(/^Perform a web search for the query:\s*/u, "");
}

/**
 * The provider's answer to a web search, as the CLI's `WebSearch` reads it: the
 * search call, its result blocks — a title and an address each — and the text
 * the provider writes over them, which is where the passages are.
 */
function webSearchMessage(query: string, hits: readonly ScriptedWebHit[], served: number): StreamedMessage {
  const id = `srvtoolu_scripted_${served}`;
  return {
    id: `msg_scripted_search_${served}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content: [
      { type: "server_tool_use", id, name: "web_search", input: { query } },
      {
        type: "web_search_tool_result",
        tool_use_id: id,
        content: hits.map((hit) => ({
          type: "web_search_result",
          title: hit.title,
          url: hit.url,
          encrypted_content: "scripted",
          page_age: null,
        })),
      },
      ...(hits.length === 0 ? [] : [{ type: "text", text: hits.map((hit) => `${hit.title}: ${hit.text}`).join("\n") }]),
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * Closes every script this process still has open — for a suite whose
 * fixtures build models in helpers it does not keep, in its `afterAll`.
 */
export function closeScriptedModels(): void {
  for (const close of [...open]) close();
}

/**
 * The prefix the SDK child puts on every tool our in-process server serves
 * (`runner.ts`): a script names a tool by its bare name, and the wire
 * carries `mcp__dito__<name>`.
 */
const SERVED_PREFIX = "mcp__dito__";

/** The CLI's own tool for a structured output — `@dito/execution`'s `STRUCTURED_OUTPUT_TOOL`, restated for the reason `ScriptedHarness` is. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * One turn as the assistant message the provider would send.
 *
 * A SCRIPTED NAME IS SERVED AS THE REQUEST OFFERS IT: a tool the request
 * lists under the served prefix is called by that name, and any other name
 * goes out exactly as scripted — which is how a script calls a tool that is
 * not on the execution's list.
 */
function messageOf(
  turn: ScriptedTurn,
  body: Record<string, unknown>,
  served: number,
): StreamedMessage {
  const offered = new Set(toolNamesOf(body, { prefixed: true }));
  const named = (name: string): string =>
    offered.has(`${SERVED_PREFIX}${name}`) ? `${SERVED_PREFIX}${name}` : name;
  const content: Record<string, unknown>[] =
    "toolCall" in turn
      ? [
          {
            type: "tool_use",
            id: `toolu_scripted_${served}`,
            name: named(turn.toolCall.name),
            input: turn.toolCall.input,
          },
        ]
      : "toolCalls" in turn
        ? turn.toolCalls.map((call, at) => ({
            type: "tool_use",
            id: `toolu_scripted_${served}_${at + 1}`,
            name: named(call.name),
            input: call.input,
          }))
        : "structured" in turn
          ? [
              {
                type: "tool_use",
                id: `toolu_scripted_${served}`,
                name: STRUCTURED_OUTPUT_TOOL,
                input: turn.structured,
              },
            ]
          : // A TURN THAT SAYS NOTHING SENDS NO BLOCK AT ALL, as a provider does
            // when the model stops without writing (ticket #363).
            turn.text === ""
            ? []
            : [{ type: "text", text: turn.text }];
  return {
    id: `msg_scripted_${served}`,
    type: "message",
    role: "assistant",
    model: body["model"],
    content,
    stop_reason: turn.stopReason ?? ("text" in turn ? "end_turn" : "tool_use"),
    stop_sequence: null,
    usage: {
      input_tokens: turn.usage?.inputTokens ?? 1,
      output_tokens: turn.usage?.outputTokens ?? 1,
    },
  };
}

interface StreamedMessage {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: unknown;
  readonly content: readonly Record<string, unknown>[];
  readonly stop_reason: string;
  readonly stop_sequence: null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * How many characters one scripted piece of a streamed block carries.
 *
 * SMALL, SO EVERY BLOCK ARRIVES IN SEVERAL PIECES (ticket #263): the claim a
 * streaming suite makes is that a reply reaches the page before it is whole,
 * and a script whose sentence fits in one piece could not tell a stream from
 * a finished text delivered once. Twelve cuts a short answer into a handful
 * and splits the JSON around it mid-token, which is what a provider does.
 */
const STREAM_PIECE_CHARS = 12;

/** One turn's message, as the server-sent events a streaming request receives. */
function framesOf(message: StreamedMessage): string[] {
  const frames: unknown[] = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 },
      },
    },
  ];
  message.content.forEach((block, index) => {
    // A SEARCH'S RESULT ARRIVES WHOLE, as the provider sends it: its block
    // starts carrying everything and no delta follows.
    if (block["type"] === "web_search_tool_result") {
      frames.push({ type: "content_block_start", index, content_block: block });
      frames.push({ type: "content_block_stop", index });
      return;
    }
    const called = block["type"] === "tool_use" || block["type"] === "server_tool_use";
    const whole = called ? JSON.stringify(block["input"]) : String(block["text"]);
    frames.push({
      type: "content_block_start",
      index,
      content_block: called ? { ...block, input: {} } : { type: "text", text: "" },
    });
    for (const piece of piecesOf(whole)) {
      frames.push({
        type: "content_block_delta",
        index,
        delta: called
          ? { type: "input_json_delta", partial_json: piece }
          : { type: "text_delta", text: piece },
      });
    }
    frames.push({ type: "content_block_stop", index });
  });
  frames.push({
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  frames.push({ type: "message_stop" });
  return frames.map(
    (frame) =>
      `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`,
  );
}

/** A block's text in `STREAM_PIECE_CHARS` pieces, whole code points each. */
function piecesOf(text: string): string[] {
  const points = [...text];
  const pieces: string[] = [];
  for (let at = 0; at < points.length; at += STREAM_PIECE_CHARS) {
    pieces.push(points.slice(at, at + STREAM_PIECE_CHARS).join(""));
  }
  return pieces;
}

/** A rule's answer, read once off the prompt; a fixed list, as it stands. */
function resolveScript(script: Script, prompt: string): readonly ScriptedTurn[] {
  return typeof script === "function" ? script(prompt) : script;
}

/** The text a message's content carries: a string as it is, blocks' text joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: unknown }[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n");
}

/**
 * The prompt the model was shown: the first user turn of one request body,
 * which is where the runner puts the material the model is judging (the
 * day's transcript, the chat's context, the question).
 *
 * THE FIRST USER TURN, NOT THE FIRST MESSAGE. The CLI follows ours with
 * system-role messages of its own (the environment, the model, the date),
 * and on every later request it keeps that first user turn unchanged — so
 * it is both what the model was shown and a key that holds for the length
 * of one run.
 *
 * EXPORTED because it is also how a suite asserts what the model was SHOWN.
 */
export function promptOf(body: Record<string, unknown>): string {
  const messages = (body["messages"] ?? []) as {
    readonly role?: string;
    readonly content?: unknown;
  }[];
  return textOf(messages.find((message) => message.role === "user")?.content);
}

/**
 * The newest prompt a request carries: the last user message that is not a
 * tool result — a single-message execution's one prompt, a session turn's
 * wake (ticket #319).
 */
export function latestPromptOf(body: Record<string, unknown>): string {
  const prompts = userMessagesOf(body)
    .map((message) => promptTextOf(message.content))
    .filter((text) => text !== "");
  return prompts.at(-1) ?? "";
}

/**
 * A user message's text as a prompt: the text blocks after its last tool
 * result, less the ones the child writes to the model of its own accord — its
 * ask for visible output and a `Stop` hook's reason (ticket #363). A request
 * merges consecutive user turns into one message, so a turn that ended
 * without writing leaves its tool results, the child's ask and the next
 * prompt side by side in one.
 */
function promptTextOf(content: unknown): string {
  if (typeof content === "string") return isChildsOwn(content) ? "" : content;
  if (!Array.isArray(content)) return "";
  const blocks = content as { type?: string; text?: unknown }[];
  const afterResults = blocks.slice(blocks.findLastIndex((block) => block.type === "tool_result") + 1);
  return afterResults
    .filter((block) => block.type === "text" && typeof block.text === "string" && !isChildsOwn(block.text))
    .map((block) => block.text as string)
    .join("\n\n");
}

/** Whether a text is the child's own word to the model rather than a prompt. */
function isChildsOwn(text: string): boolean {
  return text.includes(NO_VISIBLE_OUTPUT) || text.trimStart().startsWith("Stop hook feedback:");
}

/**
 * Whether a request begins a turn: its last user message is a prompt rather
 * than a tool result. A retry of the same request begins the same turn, so
 * the cursor only moves on when the prompt itself is new.
 */
function startsTurn(body: Record<string, unknown>): boolean {
  const last = userMessagesOf(body).at(-1);
  const text = last === undefined ? undefined : lastTextOf(last.content);
  return text !== undefined && !isChildsOwn(text);
}

/** A user message's last block, when it is text — the newest thing the request says. */
function lastTextOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const last = (content as { type?: string; text?: unknown }[]).at(-1);
  return last?.type === "text" && typeof last.text === "string" ? last.text : undefined;
}

/**
 * THE CHILD'S OWN ASK FOR VISIBLE OUTPUT, word for word as the CLI sends it
 * after a response that wrote nothing (measured on the bundled CLI, SDK
 * 0.3.288): once per turn, after which a second silent response ends it.
 */
const NO_VISIBLE_OUTPUT =
  "[Your previous response had no visible output. Please continue and produce a user-visible response.]";

/** Whether a request's last word is the CLI's ask for visible output (`NO_VISIBLE_OUTPUT`). */
function asksForVisibleOutput(body: Record<string, unknown>): boolean {
  const last = userMessagesOf(body).at(-1);
  // THE ASK MAY SHARE ITS MESSAGE WITH THE TOOL RESULTS BEFORE IT: a request
  // merges consecutive user turns into one.
  return last !== undefined && (lastTextOf(last.content) ?? "").includes(NO_VISIBLE_OUTPUT);
}


function userMessagesOf(
  body: Record<string, unknown>,
): { readonly role?: string; readonly content?: unknown }[] {
  const messages = (body["messages"] ?? []) as {
    readonly role?: string;
    readonly content?: unknown;
  }[];
  return messages.filter((message) => message.role === "user");
}

/** One entry of a conversation as a request carries it (`transcriptOf`). */
export type TranscriptEntry =
  | { readonly role: "user" | "assistant"; readonly text: string }
  | { readonly role: "assistant"; readonly tool: string; readonly input: unknown }
  | { readonly role: "user"; readonly toolResult: string };

/**
 * THE CONVERSATION A REQUEST CARRIED, entry by entry — the user's prompts,
 * the assistant's text and tool calls, the tool results — with the CLI's own
 * system-role reminders left out (ticket #319).
 *
 * It is how a suite proves a session reads its earlier turns NATIVELY: the
 * second turn's request holds the first turn's line, call and result as
 * messages, not as text rendered into a prompt. A tool's name is given bare,
 * as a definition declares it.
 */
export function transcriptOf(
  request: Record<string, unknown> | undefined,
): TranscriptEntry[] {
  const messages = (request?.["messages"] ?? []) as {
    readonly role?: string;
    readonly content?: unknown;
  }[];
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : ((message.content ?? []) as {
            type?: string;
            text?: string;
            name?: string;
            input?: unknown;
            content?: unknown;
          }[]);
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        entries.push({ role: message.role, text: block.text });
      } else if (block.type === "tool_use" && message.role === "assistant") {
        const name = String(block.name);
        entries.push({
          role: "assistant",
          tool: name.startsWith(SERVED_PREFIX) ? name.slice(SERVED_PREFIX.length) : name,
          input: block.input,
        });
      } else if (block.type === "tool_result" && message.role === "user") {
        entries.push({ role: "user", toolResult: textOf(block.content) });
      }
    }
  }
  return entries;
}

/**
 * The system prompt a request carried, its text blocks joined in order.
 *
 * OURS IS THE LAST BLOCK, AND THE OTHERS ARE THE CLI'S: a billing line and
 * the SDK's one-line identity come first. A suite asserting on our
 * instructions asserts containment and order within them, which the CLI's
 * blocks ahead of ours cannot disturb.
 */
export function systemOf(request: Record<string, unknown> | undefined): string {
  return textOf(request?.["system"]);
}

/**
 * The tool names a request offered the model, with the served prefix
 * stripped — the names a definition declares — or as the wire carries them.
 */
export function toolNamesOf(
  request: Record<string, unknown> | undefined,
  options: { readonly prefixed?: boolean } = {},
): string[] {
  const tools = (request?.["tools"] ?? []) as { readonly name?: unknown }[];
  return tools
    .map((tool) => String(tool.name))
    .map((name) =>
      options.prefixed === true || !name.startsWith(SERVED_PREFIX)
        ? name
        : name.slice(SERVED_PREFIX.length),
    );
}

/**
 * WHAT A REQUEST'S TOOL RESULTS ACTUALLY SAID — the strings the MODEL was
 * handed back, and nothing else in the body (ticket #196).
 *
 * IT IS NOT `JSON.stringify(request)`, and the difference bites on exactly
 * one claim: a request also carries the assistant's own `tool_use` block, so
 * a search asked for «900 bultos» puts that phrase in the body whatever the
 * tool answered. What a read SERVED is the `tool_result` and only that — its
 * text, whether the wire carries it as a string or as text blocks.
 */
export function toolResultsOf(
  request: Record<string, unknown> | undefined,
): string[] {
  const messages = (request?.["messages"] ?? []) as {
    readonly content?: unknown;
  }[];
  const results: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: string; content?: unknown }[]) {
      if (block.type === "tool_result") results.push(textOf(block.content));
    }
  }
  return results;
}
