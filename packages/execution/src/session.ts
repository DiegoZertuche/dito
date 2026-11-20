/**
 * THE SESSION: ONE THREAD OF THE MACHINE THE CHILD HOLDS, FED BY AN INBOX, WITH ONE
 * EXECUTION PER TURN (ADR-0014 and ADR-0012 as amended 2026-09-27; spec #318
 * decisions 8 and 14; design D1, D3 and D7; ticket #319).
 *
 * The second shape of the harness. The single-message runner (`runner.ts`)
 * hands the SDK one prompt and reads one result; a session opens one
 * streaming-input `query()` whose prompt is an inbox the caller keeps
 * feeding, and the child answers each user message it is handed as a turn of
 * one session, written to one file under the harness directory
 * (`sessionFile`). What the model reads is native: the earlier lines, its own
 * replies and tool calls, the events — nothing is rendered from rows into a
 * prompt.
 *
 * EVERY TURN IS STILL ONE EXECUTION (D1). A wake carries its own trigger and
 * its own definition, whose tools are bound to that turn's connection and
 * evidence; the child lists the tools once, when it opens, and every call is
 * answered by the handlers of the turn that is running. The wrapper is the
 * runner's (`turn.ts`): one book per wake, the same ladder, the same record,
 * one audit entry.
 *
 * THE CHILD'S QUEUE IS THE FOLD (D7; spike #290 fact 3). A line pushed while
 * a turn runs lands at the next tool boundary and that turn's one result
 * answers both. Which wakes a result answered is the child's own word — the
 * result's `user_message_uuids`, every user message the turn consumed —
 * never a guess from timing: the earliest of them owns the execution and the
 * rest are FOLDED into it. A wake pushed `later` (an event) waits for a turn
 * of its own; an append (`shouldQuery: false`) joins the transcript and wakes
 * nothing.
 *
 * A FAILED TURN IS NOT KEPT (spec #258 decision 13; spec #318 decision 14).
 * The ladder is decided the moment the result arrives, before the child can
 * start another turn, and a failed one closes the child: the next child
 * resumes with `resumeSessionAt` the last entry the session keeps and
 * `resumeDropsTurn` the failed turn's prompt, forked into a new id, so not
 * one entry of the failed turn survives. When the CLI refuses that cut
 * (`Resume rejected by --resume-drops-turn:`) the SDK's own guidance is
 * followed: resume plainly and keep the evidence, never retry the fork.
 *
 * A CHILD THAT DIES IS RESUMED, NOT LOST. Between turns, the next child
 * resumes the same id and every item is there (spike #290 fact 6); in the
 * middle of a turn, that turn failed and is dropped as above. A wake the dead
 * child never began is handed to the next child as it was.
 *
 * WHAT IT DOES NOT DECIDE: which day a session belongs to, when it is
 * cut, what it opens with, and where its id is kept. Those are the owning
 * app's (`hooks` tell it what moved); this module holds no clock, no zone and
 * no connection.
 */
import { randomUUID } from "node:crypto";
import {
  query,
  type HookCallback,
  type HookJSONOutput,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionAuditChain } from "./audit.js";
import {
  renderParts,
  ExecutionDefinitionError,
  type Budget,
  type ExecutionDefinition,
  type NamedPart,
} from "./definition.js";
import { placeChild, type Harness } from "./harness.js";
import { confineToWorkspace, type SdkTool } from "./sdk-tools.js";
import type { Trace } from "./trace.js";
import type { Trigger } from "./trigger.js";
import {
  assertRunnable,
  denyOffList,
  DISALLOWED_SDK_TOOLS,
  ExecutionError,
  failed,
  onTheListOf,
  SERVER,
  sdkOutputFormat,
  toolServer,
  TurnBook,
  wireFailureOf,
  type ExecutionOutcome,
  type ListedTool,
  type ServedAnswer,
  type Settled,
  type WordsPiece,
} from "./turn.js";
import type { ToolInputSchema } from "./tool.js";

/**
 * What every turn of one child shares, because the child is told it once,
 * when it opens: the system prompt, the tools it lists, how its turns end —
 * on a structured output's schema or on their words — and the budget.
 *
 * A WAKE WHOSE DEFINITION SAYS ANYTHING ELSE IS REFUSED (`Session.wake`).
 * Its record would carry the digest of instructions the model was not given,
 * which is the one thing a stamp exists to prevent; so the owning app builds
 * every turn's definition from the same standing parts it opened with.
 */
export interface SessionShape {
  readonly instructions: readonly NamedPart[];
  readonly tools: readonly ListedTool[];
  /** The SDK's own tools the child is given, by name (ticket #326); absent, none. */
  readonly sdkTools?: readonly SdkTool[];
  readonly outputFormat?: ToolInputSchema;
  readonly budget: Budget;
}

/** The shape a definition opens a session with — its context is the turn's, and is left out. */
export function sessionShapeOf<S, Handled>(
  definition: ExecutionDefinition<S, Handled>,
): SessionShape {
  return {
    instructions: [...definition.instructions, ...(definition.standing ?? [])],
    tools: definition.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...(definition.sdkTools === undefined || definition.sdkTools.length === 0 ? {} : { sdkTools: definition.sdkTools }),
    ...(definition.outputFormat === undefined ? {} : { outputFormat: definition.outputFormat.schema }),
    budget: definition.budget,
  };
}

/**
 * Where the session begins: a new one written under `sessionId`, or the
 * one already on disk under it — resumed in place, forked whole into a new
 * id (`fork`), or, with `truncate`, forked into a new id without the turn
 * `dropsTurn` names.
 */
export type SessionStart =
  | { readonly kind: "new"; readonly sessionId: string }
  | {
      readonly kind: "resume";
      readonly sessionId: string;
      readonly truncate?: Truncation;
      /**
       * FORK INSTEAD OF CONTINUING (the SDK's `forkSession`): the child
       * resumes the session whole and writes on under a new id, leaving the
       * session it read untouched — a workflow run's child forked from its
       * parent (ADR-0012). The new id reaches the owning app through `moved`.
       */
      readonly fork?: true;
    };

/**
 * A truncating resume: keep the session through `keptThrough` — the
 * last entry of the last good turn, or of an append after it — and drop the
 * turn whose prompt is `dropsTurn`.
 */
export interface Truncation {
  readonly keptThrough: string;
  readonly dropsTurn: string;
}

/**
 * What the owning app is told as the session moves, so it can keep the
 * id and the cut points where a restart of its own process will find them.
 * Every hook is metadata — ids and instants — and none of them awaits.
 */
export interface SessionHooks {
  /** A turn began; `prompt` is its first user message, what a truncating resume would drop. */
  readonly opened?: (prompt: string) => void;
  /**
   * The session keeps everything through `through`: a turn ended well
   * (`byTurn`), or an append landed.
   */
  readonly kept?: (through: string, at: Date, byTurn: boolean) => void;
  /**
   * The session is now written under `to`: a failed turn was dropped by
   * forking, the session was forked whole as asked (`SessionStart.fork`), or
   * the session `from` was not on disk to resume.
   */
  readonly moved?: (to: string, from: string) => void;
  /** The CLI refused a truncating resume; the session was resumed plainly and keeps the failed turn. */
  readonly refused?: (evidence: string) => void;
}

/**
 * One wake: a user message that begins (or folds into) an execution.
 *
 * THE MESSAGE IS THE DEFINITION'S CONTEXT, rendered (spec #318 decision 10):
 * the instructions were told once, when the child opened, and what a turn
 * adds is its own context parts — the «now», the line, what it points at.
 */
export interface WakeSpec<S, Handled, Tag> {
  readonly trigger: Trigger;
  readonly definition: ExecutionDefinition<S, Handled>;
  readonly chain: ExecutionAuditChain;
  readonly trace?: Trace;
  /** Where the model's text goes as it is written, if anywhere (`WordsPiece`). */
  readonly onWords?: (piece: WordsPiece) => void;
  /**
   * Whatever the owning app needs back to deliver a FOLDED wake's answer —
   * the door it came through, its row. Handed back untouched.
   */
  readonly tag: Tag;
  /**
   * `later` is a wake that waits for a turn of its own after the running one
   * (an event). Omitted, a wake pushed while a turn of such wakes runs folds
   * into it at the next tool boundary (a rep line, D7); behind a `later` wake
   * it waits for a turn of its own as well.
   */
  readonly priority?: "later";
}

/**
 * How a wake settled.
 *
 * `ran` / `failed`: this wake owned the turn — the record, the entry and the
 * delivery are the caller's, with `folded` the tags of every later wake the
 * same turn answered. `folded`: another wake owned the turn that answered
 * this one; nothing of this wake is recorded, and `into` is the owner's tag.
 */
export type WakeSettlement<S, Tag> =
  | {
      readonly kind: "ran";
      readonly outcome: ExecutionOutcome<S>;
      readonly folded: readonly Tag[];
    }
  | {
      readonly kind: "failed";
      readonly error: ExecutionError;
      readonly folded: readonly Tag[];
    }
  | { readonly kind: "folded"; readonly into: Tag; readonly failed: boolean };

/** One live session, across however many children it takes. */
export interface Session<Tag> {
  /** The id the session is written under now. */
  readonly sessionId: string;
  /** What the session was opened with — what every turn it runs must be told. */
  readonly shape: SessionShape;
  /**
   * Whether anything is in flight: a turn running, or a wake or append the
   * child has not answered yet. A session that is busy is never cut.
   */
  readonly busy: boolean;
  /** Pushes a wake; resolves when the turn that answered it has ended. */
  wake<S, Handled>(
    spec: WakeSpec<S, Handled, Tag>,
  ): Promise<WakeSettlement<S, Tag>>;
  /**
   * Appends a user message that wakes nothing (`shouldQuery: false`): an
   * event the session should hold, a carried tail. Opens a child when
   * none is up — the append costs no model call. Resolves once the
   * session holds it.
   */
  append(text: string): Promise<void>;
  /** Resolves once everything pushed so far has been answered. */
  settled(): Promise<void>;
  /**
   * Ends the inbox and lets the child exit, so its file is flushed; a child
   * that does not exit in time is killed. A wake still waiting fails.
   */
  close(): Promise<void>;
}

/**
 * How long a closing child is given to finish and flush before it is killed.
 * A parked child exits on the end of its input within a second; ten is a
 * turn still finishing at shutdown.
 */
const CLOSE_GRACE_MS = 10_000;

/**
 * The prefix of the CLI's refusal of a truncating resume, as the SDK
 * documents it — matched, never retried (`resumeDropsTurn`).
 */
const DROPS_TURN_REFUSAL = "Resume rejected by --resume-drops-turn:";

/** The CLI's word for a resume whose conversation is not on disk. */
const NOT_ON_DISK = "No conversation found with session ID";

/**
 * How many children in a row may end without answering anything before the
 * waiting wakes are failed rather than handed to another: a child that
 * cannot start is a broken harness, and a loop of them would spawn forever.
 */
const DEAD_STARTS_TOLERATED = 2;

/** Opens a session: no child starts until the first wake or append. */
export function openSession<Tag>(opening: {
  readonly harness: Harness;
  readonly shape: SessionShape;
  readonly start: SessionStart;
  readonly hooks?: SessionHooks;
}): Session<Tag> {
  return new ChildSession<Tag>(opening);
}

/** A user message pushed and not yet answered. */
interface Push {
  readonly uuid: string;
  readonly text: string;
  readonly priority?: "later";
  /** Absent for an append. */
  readonly wake?: PendingWake;
  /** An append's own promise, kept once the session holds it. */
  readonly held?: () => void;
  /** ...and broken when no child could be started to hold it. */
  readonly lost?: (error: Error) => void;
  /**
   * An append a failed turn had taken in, handed again to the child that forks
   * without that turn — and held where it is if the CLI refuses the cut, since
   * a plain resume keeps it.
   */
  readonly dropped?: true;
}

/** A wake waiting on its turn. */
interface PendingWake {
  readonly uuid: string;
  readonly book: TurnBook<unknown, unknown>;
  readonly tag: unknown;
  /** The first user message of the turn it owns, once that turn began. */
  prompt?: string;
  /** The last top-level entry of its turn, as the child yielded it. */
  tail?: string;
  readonly settle: (ending: Ending) => void;
}

/** What the pump hands a wake when its turn is over. */
type Ending =
  | {
      readonly kind: "owned";
      readonly settled: Settled<unknown>;
      readonly endedAt: Date;
      readonly cause?: unknown;
      readonly folded: readonly unknown[];
    }
  | { readonly kind: "folded"; readonly into: unknown; readonly failed: boolean };

/** One child process and the inbox that feeds it. */
interface Child {
  readonly query: Query;
  readonly inbox: Inbox;
  /** Closed on purpose: a failed turn, or `close()`. */
  deliberate: boolean;
  /** Whether it answered anything at all. */
  answered: boolean;
  /** The CLI's refusal of this child's truncating resume, when it refused. */
  refused?: string;
  /** The id a fork writes into, until the child confirms it. */
  readonly forkInto?: string;
  readonly done: Promise<void>;
}

/** How the next child opens. */
type Opening =
  | { readonly kind: "new" }
  | { readonly kind: "resume" }
  | { readonly kind: "fork"; readonly truncation?: Truncation };

class ChildSession<Tag> implements Session<Tag> {
  readonly #harness: Harness;
  readonly #shape: SessionShape;
  readonly #hooks: SessionHooks;
  readonly #systemPrompt: string;
  readonly #onTheList: ReadonlySet<string>;
  #sessionId: string;
  #next: Opening;
  #child: Child | undefined;
  /** Every push not yet answered, oldest first. */
  #outstanding: Push[] = [];
  #running: PendingWake | undefined;
  /** The last entry of the session that is kept — where a truncating resume cuts. */
  #keptThrough: string | undefined;
  #deadStarts = 0;
  #closed = false;
  #waiters: (() => void)[] = [];

  constructor(opening: {
    readonly harness: Harness;
    readonly shape: SessionShape;
    readonly start: SessionStart;
    readonly hooks?: SessionHooks;
  }) {
    this.#harness = opening.harness;
    this.#shape = opening.shape;
    this.#hooks = opening.hooks ?? {};
    this.#systemPrompt = renderParts(opening.shape.instructions);
    this.#onTheList = onTheListOf(opening.shape.tools, opening.shape.outputFormat, opening.shape.sdkTools);
    this.#sessionId = opening.start.sessionId;
    this.#next =
      opening.start.kind === "new"
        ? { kind: "new" }
        : opening.start.truncate !== undefined
          ? { kind: "fork", truncation: opening.start.truncate }
          : opening.start.fork === true
            ? { kind: "fork" }
            : { kind: "resume" };
    if (opening.start.kind === "resume" && opening.start.truncate !== undefined) {
      this.#keptThrough = opening.start.truncate.keptThrough;
    }
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get shape(): SessionShape {
    return this.#shape;
  }

  get busy(): boolean {
    return this.#running !== undefined || this.#outstanding.length > 0;
  }

  async wake<S, Handled>(
    spec: WakeSpec<S, Handled, Tag>,
  ): Promise<WakeSettlement<S, Tag>> {
    assertRunnable(spec.trigger, spec.definition);
    this.#assertShape(spec.definition);
    const book = new TurnBook(spec.definition, {
      ...(spec.trace === undefined ? {} : { trace: spec.trace }),
      ...(spec.onWords === undefined ? {} : { onWords: spec.onWords }),
    });
    const ending = await new Promise<Ending>((settle) => {
      const uuid = randomUUID();
      const wake: PendingWake = {
        uuid,
        book: book as TurnBook<unknown, unknown>,
        tag: spec.tag,
        settle,
      };
      // A LINE FOLDS ONLY INTO A TURN OF LINES. While a `later` wake — an
      // event — is waiting or running, a line pushed plainly would be taken
      // into that turn (the child batches what arrives together, and folds
      // what arrives mid-turn), and a turn nobody wrote would answer the rep.
      // So it waits for a turn of its own behind it.
      const priority =
        spec.priority ??
        (this.#outstanding.some((push) => push.wake !== undefined && push.priority === "later")
          ? "later"
          : undefined);
      this.#push({
        uuid,
        text: renderParts(spec.definition.context),
        ...(priority === undefined ? {} : { priority }),
        wake,
      });
    });
    if (ending.kind === "folded") {
      return { kind: "folded", into: ending.into as Tag, failed: ending.failed };
    }
    const folded = ending.folded as readonly Tag[];
    try {
      const outcome = await book.close({
        trigger: spec.trigger,
        chain: spec.chain,
        settled: ending.settled as Settled<S>,
            endedAt: ending.endedAt,
        cause: ending.cause,
      });
      return { kind: "ran", outcome, folded };
    } catch (error) {
      if (!(error instanceof ExecutionError)) throw error;
      return { kind: "failed", error, folded };
    }
  }

  async append(text: string): Promise<void> {
    await new Promise<void>((held, lost) => {
      this.#push({ uuid: randomUUID(), text, held, lost });
    });
  }

  async settled(): Promise<void> {
    if (!this.busy) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    if (child !== undefined) {
      child.deliberate = true;
      child.inbox.end();
      const exited = await Promise.race([
        child.done.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), CLOSE_GRACE_MS).unref(),
        ),
      ]);
      if (!exited) {
        child.query.close();
        await child.done;
      }
    }
    // A WAKE STILL WAITING AT CLOSE FAILS, with its record: the lane task
    // awaiting it must end, and a turn that never ran is a failed one.
    const waiting = this.#outstanding;
    this.#outstanding = [];
    if (this.#running !== undefined && !waiting.some((push) => push.wake === this.#running)) {
      this.#fail(this.#running, "the session closed before this turn ended");
    }
    this.#running = undefined;
    for (const push of waiting) {
      if (push.wake !== undefined) {
        this.#fail(push.wake, "the session closed before this turn ran");
      }
      // An append still waiting at close went to a child that has now exited
      // with its input; nothing more is heard of it.
      push.held?.();
    }
    this.#notifySettled();
  }

  /**
   * The turn's definition must be the shape this child was opened with: the
   * system prompt, the tools it lists, how it ends and the budget.
   */
  #assertShape<S, Handled>(definition: ExecutionDefinition<S, Handled>): void {
    const given = sessionShapeOf(definition);
    const differs = (what: string): never => {
      throw new ExecutionDefinitionError(
        `this turn's ${what} is not the session's: a session is told its instructions, tools and budget once, when its child opens, and a record stamped with another would attest to what the model was not given`,
      );
    };
    if (renderParts(given.instructions) !== this.#systemPrompt) differs("instructions");
    if (JSON.stringify(given.tools) !== JSON.stringify(this.#shape.tools)) differs("tool list");
    // A TURN MAY BE GIVEN FEWER OF THE SDK'S TOOLS THAN THE CHILD LISTS (ticket
    // #326): the child lists them once, and the running turn's own hook denies
    // the ones it was not given (`TurnBook.sdkToolUnnamed`) — never more.
    if ((given.sdkTools ?? []).some((tool) => !(this.#shape.sdkTools ?? []).includes(tool))) differs("SDK tools");
    if (JSON.stringify(given.outputFormat) !== JSON.stringify(this.#shape.outputFormat)) {
      differs("structured output");
    }
    if (JSON.stringify(given.budget) !== JSON.stringify(this.#shape.budget)) differs("budget");
  }

  #push(push: Push): void {
    if (this.#closed) {
      if (push.wake !== undefined) this.#fail(push.wake, "the session is closed");
      return;
    }
    this.#outstanding.push(push);
    // A LINE HANDED TO AN IDLE SESSION BEGINS NOW (ticket #358): nothing runs
    // and no line waits ahead of it, so the child takes it up at once — its
    // record says it began here, before the model is called, never at the
    // first frame the model sends back. A `later` wake is not stamped here:
    // the child runs a line that arrives beside it first, so when a `later`
    // wake began is known only from its first frame (`#begin`).
    if (
      push.wake !== undefined &&
      push.priority === undefined &&
      this.#running === undefined &&
      this.#nextLine() === push.wake
    ) {
      push.wake.book.began(new Date());
    }
    this.#send(push);
  }

  /**
   * The oldest line still waiting on a turn — a wake not pushed `later` — which
   * is what the child runs next once nothing runs: the `later` wakes wait
   * behind every line.
   */
  #nextLine(): PendingWake | undefined {
    return this.#outstanding.find((push) => push.wake !== undefined && push.priority === undefined)
      ?.wake;
  }

  #send(push: Push): void {
    const child = this.#ensureChild();
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: push.text },
      parent_tool_use_id: null,
      uuid: push.uuid as SDKUserMessage["uuid"] & string,
      ...(push.wake === undefined ? { shouldQuery: false } : {}),
      ...(push.priority === undefined ? {} : { priority: push.priority }),
    };
    child.inbox.push(message);
  }

  #ensureChild(): Child {
    if (this.#child !== undefined) return this.#child;
    const opening = this.#next;
    const forkInto = opening.kind === "fork" ? randomUUID() : undefined;
    const placement = placeChild(this.#harness, this.#shape.budget, "session");
    const budget = this.#shape.budget;
    const inbox = new Inbox();
    const run = query({
      prompt: inbox,
      options: {
        model: budget.model,
        // OURS REPLACES THE SDK'S, and it is fixed for the life of the child:
        // what changes inside a day travels in the wake (spec #318 decision 10).
        systemPrompt: this.#systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // THE SDK TOOLS THE SHAPE NAMES AND NOTHING ELSE (ticket #326).
        tools: [...(this.#shape.sdkTools ?? [])],
        mcpServers: {
          [SERVER]: {
            type: "sdk",
            name: SERVER,
            instance: toolServer(this.#shape.tools, (name, input) => this.#call(name, input)),
          },
        },
        allowedTools: [...this.#onTheList],
        disallowedTools: DISALLOWED_SDK_TOOLS,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                denyOffList(this.#onTheList),
                // THE WORKSPACE HOLDS WHETHER OR NOT A TURN RUNS (ticket #326):
                // the denial is the hook's own, and only its trace is the
                // running turn's.
                confineToWorkspace(placement.cwd, (tool, input, reason) =>
                  this.#running?.book.sdkToolDenied(tool, input, reason),
                ),
                (...args: Parameters<HookCallback>) => this.#unnamed(...args),
                // THE RUNNING TURN'S OWN RULE OVER ITS TYPED RESULT (ticket
                // #326), as the single-message runner holds one: a refused
                // output goes back to the model to answer again.
                ...(this.#shape.outputFormat === undefined
                  ? []
                  : [(...args: Parameters<HookCallback>) => this.#structuredCheck(...args)]),
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async (input, toolUseId, options) =>
                  (await this.#running?.book.sdkToolUsed(placement.cwd)(input, toolUseId, options)) ?? {},
                // A TOOL THAT ENDS THE RUNNING TURN ends it here (ticket #401).
                async (input, toolUseId, options) =>
                  (await this.#running?.book.endTurn(input, toolUseId, options)) ?? {},
              ],
            },
          ],
          // THE RUNNING TURN'S OWN RULE OVER ITS WORDS (ticket #363), as every
          // call is the running turn's own handlers' (`#call`).
          Stop: [{ hooks: [(input, toolUseId, options) => this.#stop(input, toolUseId, options)] }],
        },
        ...sdkOutputFormat(this.#shape.outputFormat),
        includePartialMessages: true,
        // PER TURN, measured (ticket #319's live check and the fake): in a
        // streaming session the cap counts the model calls of one turn and
        // starts again with the next, so it is each execution's budget as it
        // is in the single-message shape.
        maxTurns: budget.maxIterations,
        ...(budget.effort === undefined ? {} : { effort: budget.effort }),
        settingSources: [],
        strictMcpConfig: true,
        cwd: placement.cwd,
        env: { ...placement.env },
        ...(this.#harness.executable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: this.#harness.executable }),
        ...(opening.kind === "new"
          ? { sessionId: this.#sessionId }
          : opening.kind === "resume"
            ? { resume: this.#sessionId }
            : {
                resume: this.#sessionId,
                ...(opening.truncation === undefined
                  ? {}
                  : {
                      resumeSessionAt: opening.truncation.keptThrough,
                      resumeDropsTurn: opening.truncation.dropsTurn,
                    }),
                forkSession: true,
                sessionId: forkInto!,
              }),
      },
    });
    // ONCE A CHILD HAS OPENED, THE NEXT ONE RESUMES THIS ID: the session
    // is on disk from its first answered message on. A fork changes the id
    // only once the child confirms it (`#pump`).
    this.#next = { kind: "resume" };
    const child: Child = {
      query: run,
      inbox,
      deliberate: false,
      answered: false,
      ...(forkInto === undefined ? {} : { forkInto }),
      done: Promise.resolve(),
    };
    (child as { done: Promise<void> }).done = this.#pump(child);
    this.#child = child;
    return child;
  }

  /**
   * Every call the child makes, answered by the running turn's own handlers.
   *
   * THE RUNNING TURN, OR THE OLDEST WAKE NOT YET ANSWERED: a turn's first
   * stream event names the wake that began it and arrives a model call before
   * any tool of that turn can be called, so by the time a call arrives the
   * running turn is known — and if it somehow is not, the child begins turns
   * in the order it was handed wakes, so the oldest one waiting is the one.
   */
  async #call(name: string, input: unknown): Promise<ServedAnswer> {
    const wake =
      this.#running ?? this.#outstanding.find((push) => push.wake !== undefined)?.wake;
    if (wake === undefined) {
      return { text: `${name} was called with no turn running`, isError: true };
    }
    return await wake.book.call(name, input);
  }

  /**
   * AN SDK TOOL THE RUNNING TURN WAS NOT GIVEN IS DENIED (ticket #326; Codex
   * r1), and so is any SDK tool when no turn runs to own the call.
   */
  async #unnamed(...args: Parameters<HookCallback>): Promise<HookJSONOutput> {
    const [input] = args;
    if (input.hook_event_name !== "PreToolUse" || !(this.#shape.sdkTools ?? []).some((tool) => tool === input.tool_name)) return {};
    const book = this.#running?.book;
    if (book !== undefined && (book.definition.sdkTools ?? []).some((tool) => tool === input.tool_name)) return {};
    // THE TURN'S OWN TRACE ALREADY SAYS IT: the name is off that turn's list,
    // which the stream's reading records as the rejection (`onStreamEvent`).
    const reason = `${input.tool_name} is not on this turn's tool list.`;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  }

  /** The structured-output check, answered by the running turn's book — and by nobody when none runs. */
  async #structuredCheck(...args: Parameters<HookCallback>): Promise<HookJSONOutput> {
    return (await this.#running?.book.structuredCheck(...args)) ?? {};
  }

  /** The `Stop` hook, answered by the running turn's book — and by nobody when none runs. */
  async #stop(...args: Parameters<HookCallback>): Promise<HookJSONOutput> {
    return (await this.#running?.book.stop(...args)) ?? {};
  }

  async #pump(child: Child): Promise<void> {
    let thrown: unknown;
    try {
      for await (const message of child.query) {
        this.#read(child, message);
      }
    } catch (error) {
      thrown = error;
    }
    this.#ended(child, thrown);
  }

  #read(child: Child, message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (
          message.subtype === "init" &&
          child.forkInto !== undefined &&
          message.session_id === child.forkInto &&
          this.#sessionId !== child.forkInto
        ) {
          // THE FORK TOOK: the session is written under its new id from here
          // on — without the failed turn, or whole for a fork asked for.
          const from = this.#sessionId;
          this.#sessionId = child.forkInto;
          this.#hooks.moved?.(child.forkInto, from);
        }
        return;
      case "stream_event":
        if (message.parent_tool_use_id !== null) return;
        this.#begin(message.user_message_uuids ?? stamped(message.user_message_uuid));
        this.#runningOrOldest()?.book.onStreamEvent(message.event);
        return;
      case "assistant":
      case "user":
        if (message.parent_tool_use_id !== null) return;
        if ("isReplay" in message && message.isReplay === true) return;
        if (message.type === "assistant") {
          this.#begin(message.user_message_uuids ?? stamped(message.user_message_uuid));
        }
        {
          const running = this.#runningOrOldest();
          if (running !== undefined && message.uuid !== undefined) {
            running.tail = message.uuid;
          }
        }
        return;
      case "result":
        this.#result(child, message);
        return;
      default:
        return;
    }
  }

  /**
   * The turn a frame belongs to: the running one, or — when the child did not
   * stamp the turn's first frame — the oldest wake it was handed, which is the
   * one it begins (`#call` argues the order). Taken as running from here on, so
   * the turn's rounds, spend and last entry are its own. `began` here is the
   * grant of a `later` wake and the fallback for any other granted no earlier
   * way (a child that died between turns); a line granted at hand-over or
   * behind a turn that ended keeps its earlier instant.
   */
  #runningOrOldest(): PendingWake | undefined {
    if (this.#running === undefined) {
      this.#running = this.#outstanding.find((push) => push.wake !== undefined)?.wake;
      this.#running?.book.began(new Date());
    }
    return this.#running;
  }

  /** A turn's first stamped frame: the wake it consumed first owns it. */
  #begin(consumed: readonly string[] | undefined): void {
    if (consumed === undefined || consumed.length === 0) return;
    if (this.#running !== undefined && consumed.includes(this.#running.uuid)) return;
    const owner = this.#outstanding.find(
      (push) => push.wake !== undefined && consumed.includes(push.uuid),
    )?.wake;
    if (owner === undefined) return;
    this.#running = owner;
    // A `later` wake is granted here, at its first frame; a line granted
    // earlier keeps its instant (`began` is once).
    owner.book.began(new Date());
    owner.prompt = consumed[0]!;
    this.#hooks.opened?.(owner.prompt);
  }

  #result(child: Child, result: SDKResultMessage): void {
    if (
      result.subtype === "error_during_execution" &&
      result.errors.some((error) => error.startsWith(DROPS_TURN_REFUSAL))
    ) {
      child.refused = result.errors.join("; ");
      return;
    }
    const consumed =
      result.user_message_uuids ?? stamped(result.user_message_uuid) ?? [];
    // A CHILD HAS ANSWERED ONCE A RESULT CONSUMED SOMETHING of what it was
    // handed. A start-up failure — a resume with nothing on disk, a refused
    // cut — is an error result that consumed nothing, and counting it would
    // let a child that can never start be respawned for ever.
    if (consumed.length > 0 || this.#running !== undefined) child.answered = true;
    const covered = this.#outstanding.filter((push) => consumed.includes(push.uuid));
    this.#outstanding = this.#outstanding.filter((push) => !consumed.includes(push.uuid));
    // AN APPEND THE TURN TOOK IN IS HELD — unless the turn failed and is
    // dropped below, in which case it is handed on again (`#drop`).
    const wakes = covered.flatMap((push) => (push.wake === undefined ? [] : [push.wake]));
    const owner =
      this.#running !== undefined && (wakes.includes(this.#running) || wakes.length === 0)
        ? this.#running
        : wakes[0];
    if (owner === undefined) {
      // AN APPEND'S OWN ECHO: the child wrote it and woke nothing. The
      // session now keeps it, so a later truncating resume cuts after it
      // ("fork at or after your own last append").
      const last = covered.at(-1);
      if (last !== undefined) this.#keep(last.uuid, false);
      for (const push of covered) push.held?.();
      this.#notifySettled();
      return;
    }
    const folded = wakes.filter((wake) => wake !== owner);
    this.#running = undefined;
    const wireFailure = wireFailureOf(result);
    owner.book.onResult(result);
    const settled =
      owner.book.failure(wireFailure) ?? owner.book.assign();
    const endedAt = new Date();
    owner.settle({
      kind: "owned",
      settled,
      endedAt,
      ...(wireFailure === undefined ? {} : { cause: wireFailure }),
      folded: folded.map((wake) => wake.tag),
    });
    for (const wake of folded) {
      wake.settle({ kind: "folded", into: owner.tag, failed: settled.failed });
    }
    // THE LINE WAITING BEHIND THIS TURN BEGINS AS IT ENDS (ticket #358): the
    // child takes up the oldest waiting line the moment a result is in, so its
    // record says it began here — at or after `endedAt`, before its own model
    // call — not when it was handed over, which may have been the whole turn
    // ahead of it earlier. A `later` wake waiting here begins at its first
    // frame instead: a line pushed in the meantime would run before it.
    this.#nextLine()?.book.began(new Date());
    if (settled.failed) {
      this.#drop(child, owner, covered.filter((push) => push.wake === undefined));
    } else {
      // A TURN THAT SAID NOTHING YIELDS NO ENTRY OF ITS OWN (ticket #363: a
      // silence is the model stopping without writing), so the session keeps
      // through the last line the turn took in.
      const tail = owner.tail ?? consumed.at(-1);
      if (tail !== undefined) this.#keep(tail, true);
      for (const push of covered) push.held?.();
    }
    this.#notifySettled();
  }

  #keep(through: string, byTurn: boolean): void {
    this.#keptThrough = through;
    this.#hooks.kept?.(through, new Date(), byTurn);
  }

  /**
   * A FAILED TURN IS DROPPED: this child is closed before it can begin another
   * turn on top of it, and the next one forks the conversation without it.
   *
   * WITH NOTHING KEPT BEFORE IT, there is nothing to fork from — the failed
   * turn was the session's first entry — so the next child starts a new
   * session under a new id, and the owning app is told it moved.
   */
  #drop(child: Child, owner: PendingWake, foldedAppends: readonly Push[]): void {
    child.deliberate = true;
    child.query.close();
    this.#child = undefined;
    const prompt = owner.prompt ?? owner.uuid;
    if (this.#keptThrough === undefined) {
      const from = this.#sessionId;
      this.#sessionId = randomUUID();
      this.#next = { kind: "new" };
      this.#hooks.moved?.(this.#sessionId, from);
      this.#resendOutstanding(foldedAppends);
      return;
    }
    this.#next = {
      kind: "fork",
      truncation: { keptThrough: this.#keptThrough, dropsTurn: prompt },
    };
    // AN APPEND THE FAILED TURN HAD TAKEN IN goes with it when the fork takes,
    // so it is handed to the forking child at once — which is also what opens
    // that child when nothing else waits (Codex r3: no append left hanging).
    this.#resendOutstanding(foldedAppends.map((push) => ({ ...push, dropped: true as const })));
  }

  /**
   * Hands every push the closed child never answered to a new one. With
   * nothing waiting, no child is opened: the next wake or append opens it.
   */
  #resendOutstanding(also: readonly Push[]): void {
    const pending = [...also, ...this.#outstanding];
    this.#outstanding = [];
    for (const push of pending) this.#push(push);
  }

  /** The child's stream ended: closed on purpose, refused, or dead. */
  #ended(child: Child, thrown: unknown): void {
    if (this.#child === child) this.#child = undefined;
    if (child.refused !== undefined) {
      // THE CUT WAS REFUSED, deterministically, so it is never asked for
      // again: the session is resumed as it stands, the failed turn in
      // it, and the evidence goes to the owning app.
      this.#next = { kind: "resume" };
      // A plain resume keeps the failed turn — and the appends it had taken
      // in, so those are held where they are rather than handed again.
      for (const push of this.#outstanding) if (push.dropped) push.held?.();
      this.#outstanding = this.#outstanding.filter((push) => !push.dropped);
      this.#hooks.refused?.(child.refused);
      this.#resendOutstanding([]);
      return;
    }
    if (child.deliberate) return;
    const reason = thrown === undefined ? "its input ended" : String(thrown);
    if (!child.answered) {
      if (reason.includes(NOT_ON_DISK)) {
        // NOTHING TO RESUME: the session's file is gone. A new one is
        // started under a new id rather than a resume that can never succeed.
        const from = this.#sessionId;
        this.#sessionId = randomUUID();
        this.#next = { kind: "new" };
        this.#hooks.moved?.(this.#sessionId, from);
      }
      this.#deadStarts += 1;
      if (this.#deadStarts >= DEAD_STARTS_TOLERATED) {
        this.#deadStarts = 0;
        // EVERYTHING WAITING IS SETTLED, NOTHING LEFT HANGING (Codex r1): a
        // wake fails with its record, and an append's promise is broken — a
        // harness that cannot start a child is a broken one, and the caller
        // awaiting the append is told so rather than kept waiting for ever.
        const waiting = this.#outstanding;
        this.#outstanding = [];
        for (const push of waiting) {
          if (push.wake !== undefined) {
            this.#fail(push.wake, `the SDK child could not start: ${reason}`);
          }
          push.lost?.(new Error(`the SDK child could not start: ${reason}`));
        }
        this.#notifySettled();
        return;
      }
    } else {
      this.#deadStarts = 0;
    }
    const running = this.#running;
    this.#running = undefined;
    if (running !== undefined) {
      // THE CHILD DIED INSIDE A TURN: that turn failed, and the next child
      // drops it exactly as it drops any failed turn.
      this.#outstanding = this.#outstanding.filter((push) => push.wake !== running);
      this.#fail(running, `the SDK child ended inside the turn: ${reason}`);
      this.#next =
        this.#keptThrough === undefined
          ? { kind: "new" }
          : {
              kind: "fork",
              truncation: {
                keptThrough: this.#keptThrough,
                dropsTurn: running.prompt ?? running.uuid,
              },
            };
      if (this.#keptThrough === undefined) {
        const from = this.#sessionId;
        this.#sessionId = randomUUID();
        this.#hooks.moved?.(this.#sessionId, from);
      }
    }
    if (!this.#closed) this.#resendOutstanding([]);
    this.#notifySettled();
  }

  #fail(wake: PendingWake, why: string): void {
    wake.settle({
      kind: "owned",
      settled: failed(`the model call failed: ${why}`),
      endedAt: new Date(),
      folded: [],
    });
  }

  #notifySettled(): void {
    if (this.busy) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** One uuid as the list the child's plural field would carry, or nothing. */
function stamped(uuid: string | undefined): readonly string[] | undefined {
  return uuid === undefined ? undefined : [uuid];
}

/**
 * The inbox: the async iterable the child reads its user messages from, fed
 * by `push` and ended by `end`.
 */
class Inbox implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  push(message: SDKUserMessage): void {
    this.#queue.push(message);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}
