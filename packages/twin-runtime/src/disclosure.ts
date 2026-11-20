/**
 * The daily disclosure (ticket #51, an automation at #198; spec #48
 * decisions 7, 14, 17 and 19; spec #193 decisions 8, 10, 21–24;
 * FR-38/FR-39/FR-40; ADR-0003 as amended, ADR-0004, ADR-0005/0017,
 * ADR-0016, ADR-0020, ADR-0034, ADR-0037 as amended).
 *
 * Once a day the twin reads the disclosure lines the aperture has filed and
 * nobody has heard about, groups them by counterparty, numbers them, and
 * posts ONE framed message to the rep's own thread. It is the trust surface:
 * the rep is being asked to let software read their work conversations and
 * hand things to their employer, and this post is the whole of what they get
 * back — so it is complete (every line, from any source), grouped the way
 * they think about their work, and every line says where it came from.
 *
 * THE TWIN COMPOSES AROUND CODE-OWNED LINES (spec #193 decision 8). The lines
 * are what the aperture stored at filing and code renders them; what the
 * disclosure run's agent step writes is the opening and the closing, through
 * `post_disclosure`. `disclosure/` holds that automation — its definition,
 * its context, its tool and the structural guard that refuses a call which
 * types a digit or names a customer the record should name.
 *
 * IT POSTS THE DAY AND NOTHING BEFORE IT (ticket #218; spec #214 decision 3).
 * A day's run emits exactly one post: the candidate-question route is
 * retired, so there is no ask to put above the record.
 *
 * THE PLANE STAYS DUMB (ADR-0005/0017). Rendering happens at the twin's one
 * grammar point, and the post leaves through the existing notice →
 * `system_send` path with no new class, no tap and no executor change.
 *
 * SILENCE IS A VALID STATE (spec #48 decision 17, story 11). A day that filed
 * nothing fails the precondition: no run, no post, and no record either
 * — so the day never goes "done" and a crossing landing an hour later is
 * still disclosed rather than swallowed. It is ONE test (ticket #218): a day
 * owes lines, or it owes nothing at all.
 *
 * ONE ATTEMPT PER DAY, AND RESTART-SAFE (spec #193 decision 10). The post,
 * its numbering, the step's record, its chain entry and the
 * `disclosure_attempts` row commit in ONE transaction, so a crash
 * mid-composition leaves nothing behind; the clock fires the day once, and a
 * day whose step posted nothing leaves its lines pending for tomorrow's post.
 * A second post for one day runs into `disclosure_posts_one_per_twin_day`,
 * which is the guarantee — not a run's own bookkeeping.
 *
 * QUEUED IS NOT TOLD. A `disclosure_post_lines` row records that a line went
 * INTO a post; whether the rep read it is a question about delivery, and
 * `readPendingLines` asks it against `send_commands.outcome`. A post whose
 * send definitively failed reached nobody, so its lines are still owed and the
 * next day's post carries them. Nothing is retried (the seam's own rule) and
 * nothing is abandoned.
 *
 * NO MODEL IS IN THE PATH OF A CORRECTION, here or in the reply that answers
 * this post. The registry turns the quoted id into this post's notice and
 * `resolveDisclosureLineOfPost` walks notice → post → index → line in stored
 * rows only (ADR-0003 class 2), against the numbering recorded when the post
 * was rendered — which this ticket does not touch.
 */
import { randomUUID } from "node:crypto";
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type { Harness } from "@dito/execution";
import type pg from "pg";
import type { RuntimeTrace } from "./trace-render.js";
import { takeDailyPassLock } from "./db-tx.js";
import {
  servedCounterparty,
  type DisclosureDeps,
  type ServedGroup,
} from "./disclosure/deps.js";
import type { DayPost, DayToPost, DisclosurePosting } from "./disclosure/post-disclosure.js";
import {
  renderDisclosureProvenance,
  type DisclosurePostGroup,
  type DisclosurePostLine,
} from "./grammar.js";
import { composeDisclosurePost } from "./posts.js";
import type { ModelCallConfig } from "./model-config.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { DEFAULT_REP_LANGUAGE } from "./rep-language.js";
import { civilDate } from "./rep-clock.js";
import { foldSlots } from "./disclosure/slots.js";

/** What the day's disclosure needs: the seam, the twin's memory, and where to post. */
export interface DailyDisclosureDeps {
  /**
   * The connection the day is read and posted on: inside the disclosure run,
   * the step's own, whose transaction commits the post with the step's
   * record; the clock's precondition reads on the pass's.
   */
  readonly db: pg.ClientBase;
  /** Where a run's steps take their own connections from (ADR-0010 as amended). */
  readonly executionPool: pg.Pool;
  readonly harness: Harness;
  /**
   * The bundle's entity mirror is the ONLY place a counterparty has a name
   * rep-side (ADR-0004: chat↔entity bindings are rep-side only). The
   * Ledger's `display_name` is on the far side of the wall and is not
   * what the twin reads to talk to its own rep.
   */
  readonly bundle: Bundle;
  readonly dek: Dek;
  /** The chain key: the day's post is a step of a run, and a step is audit-chained (ADR-0020). */
  readonly hmacKey: Uint8Array;
  readonly twinId: string;
  readonly selfChatJid: string;
  /**
   * The rung this post's prose is written on (ADR-0015; spec #193 decision
   * 21 — "the same model rung as drafting"). This is rep-facing prose, which
   * is drafting's own class of work, so a rung of its own would be a routing
   * decision nobody asked for.
   */
  readonly drafting: ModelCallConfig;
  /** The rep's own clock — what «hoy», «ayer» and "the day" mean. */
  readonly timeZone?: string;
  /**
   * How this rep talks, as data (spec #171 decision 15). Unset takes the
   * boundary default, which is what the runtime's own deps mean by it.
   */
  readonly repLanguage?: string;
  /**
   * The hour of the rep's own day, 0–23, at which the clock fires the day's
   * extraction and then this post (`shipped-automations.ts`).
   */
  readonly disclosureHour?: number;
  /**
   * Where each step's per-call trace goes, if anywhere (#177 hotfix 1) — the
   * rig's debug view of one run, never a log.
   */
  readonly trace?: RuntimeTrace;
}

/**
 * A rendered line that still knows which stored line it came from — the
 * one array both the render and the recorded numbering read, so the index
 * the rep sees and the index the seam stores cannot diverge.
 */
interface NumberedLine extends DisclosurePostLine {
  readonly disclosureLineId: string;
}

export interface NumberedGroup extends DisclosurePostGroup {
  /**
   * The customer this block belongs to, as the rep side mints them
   * (ADR-0035).
   *
   * CARRIED RATHER THAN RE-FOUND (ticket #198). The disclosure execution is
   * served a REFERENCE per customer and the post renders a NAME, and both
   * have to mean the same customer — so the grouping that decided which
   * lines belong together says which entity that was, once, instead of every
   * later reader walking the lines back to a `disclosure_lines` row.
   */
  readonly entityId: string;
  readonly lines: readonly NumberedLine[];
}

/** One pending disclosure line, as the seam holds it. */
export interface PendingLine {
  readonly id: string;
  readonly subjectKind: "fact" | "entity_create";
  readonly entityId: string | null;
  readonly renderedText: string;
  /** The rep act this line's subject was filed on, when there was one. */
  readonly actAt: Date | null;
}
/**
 * WHETHER THE DAY OWES THE REP A POST — the precondition's half this module
 * owns (spec #48 decision 17): a line filed that no post has told, and no
 * attempt at today yet. Read on the caller's connection; decrypts nothing.
 */
export async function dayOwed(deps: DailyDisclosureDeps, now: Date): Promise<boolean> {
  const day = civilDate(now, deps.timeZone);
  const attempted = await deps.db.query(
    "SELECT 1 FROM disclosure_attempts WHERE twin_id = $1 AND disclosure_day = $2",
    [deps.twinId, day],
  );
  if (attempted.rows.length > 0) return false;
  return (await readPendingLines(deps)).length > 0;
}

/**
 * OPENS THE DAY FOR THE DISCLOSURE RUN'S AGENT STEP (ticket #364): the day's
 * own rows read once and served twice — what the step is shown and what the
 * tool posts are one numbering (spec #193 decision 22) — and the posting bound
 * to the step's connection and execution. Nothing, when the day was already
 * attempted or owes no line, so the tool refuses and the recipes render
 * nothing.
 *
 * THE POSTING IS THE TOOL'S, INSIDE THE STEP'S TRANSACTION: the post, its
 * numbering and the day's attempt row commit with the step's record and chain
 * entry (`disclosure_attempts.execution_id` and `notices.execution_id` are
 * checked at COMMIT, …20261007100020). A posting that throws rolls its own
 * writes back and is refused to the model; a day whose step posted nothing
 * has no attempt row, and the clock fires it once a day all the same.
 */
export async function openDayToPost(
  deps: DailyDisclosureDeps,
  now: Date,
  executionId: string,
): Promise<DayToPost | undefined> {
  const day = civilDate(now, deps.timeZone);
  const attempted = await deps.db.query(
    "SELECT 1 FROM disclosure_attempts WHERE twin_id = $1 AND disclosure_day = $2",
    [deps.twinId, day],
  );
  if (attempted.rows.length > 0) return undefined;
  const served = await readTheDay(deps, now, day);
  if (served === undefined) return undefined;
  return {
    deps: served.deps,
    post: (dayPost) =>
      savepointedPosting(deps.db, async () => {
        const posting = await postTheDay(deps.db, deps, now, served, dayPost, executionId);
        await recordAttempt(deps.db, deps, served.day, executionId);
        return posting;
      }),
  };
}

/** The savepoint the posting sits inside (`tool-savepoints.ts`'s rule). */
const DISCLOSURE_POSTING_SAVEPOINT = "disclosure_posting";

/**
 * The posting, wrapped so a Postgres error inside it leaves the step's
 * transaction usable: the tool's refusal goes back to the model, and the
 * step's own record is written on a clean transaction after the turn. IT
 * RETHROWS — rolling back is about the database, and the refusal is the
 * tool's.
 */
async function savepointedPosting(
  client: pg.ClientBase,
  post: () => Promise<DisclosurePosting>,
): Promise<DisclosurePosting> {
  await client.query(`SAVEPOINT ${DISCLOSURE_POSTING_SAVEPOINT}`);
  try {
    const posted = await post();
    await client.query(`RELEASE SAVEPOINT ${DISCLOSURE_POSTING_SAVEPOINT}`);
    return posted;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${DISCLOSURE_POSTING_SAVEPOINT}`);
    throw error;
  }
}

/** One attempt at one day, recorded beside the execution that made it. */
async function recordAttempt(
  client: pg.ClientBase,
  deps: DailyDisclosureDeps,
  day: string,
  executionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO disclosure_attempts (twin_id, disclosure_day, execution_id)
     VALUES ($1, $2, $3)`,
    [deps.twinId, day, executionId],
  );
}

/**
 * THE POSTING: what one `post_disclosure` call becomes, in the rep's thread.
 *
 * ONE POST, AND NOTHING BEFORE IT (ticket #218). A day's execution writes the
 * day's post and nothing else: the candidate-question route that put an ask
 * above the record is retired. Emission order is still thread order here —
 * `insertSystemSendCommand` stamps `clock_timestamp()` and the executor
 * dispatches `ORDER BY created_at` — and with one post there is no order to
 * get wrong.
 *
 * EVERY LINE THE MODEL WAS SHOWN GOES IN, in the order it was shown them and
 * with the text the aperture stored (spec #193 decision 8). A call
 * cannot reach the lines at all — it carries an opening and a closing, and
 * nothing else — so "code renders the post with every line present" is true
 * by construction rather than by a check.
 *
 * THE ALREADY-POSTED CHECK IS STILL HERE, under the lock, and it is the
 * structural guarantee rather than this pass's bookkeeping: `disclosure_posts`
 * makes a second post for one day unrepresentable, and a build that reached
 * here with the day already posted throws — which the tool refuses back to
 * the model, posting nothing.
 */
async function postTheDay(
  client: pg.ClientBase,
  deps: DailyDisclosureDeps,
  now: Date,
  served: TheDay,
  dayPost: DayPost,
  executionId: string,
): Promise<DisclosurePosting> {
  // THE POST NAMES A RECORD THAT DOES NOT EXIST YET, and this is what makes
  // that legal (…2026090610003·): the tool runs inside the step's turn, so
  // the step's record is written after these posts. The reference is
  // deferrable for exactly this transaction's sake and is still checked at
  // COMMIT, so a post naming an execution that never got a record cannot
  // commit either way.
  await client.query(
    "SET CONSTRAINTS notices_execution_id_fkey DEFERRED",
  );
  // THE DAILY PASS'S ONE LOCK, shared with extraction's filing: a line
  // cannot commit between reading the day and posting it, so the still-owed
  // re-read below is a statement about the rows this post carries rather
  // than a hope.
  await takeDailyPassLock(client, deps.twinId);
  const already = await client.query(
    "SELECT 1 FROM disclosure_posts WHERE twin_id = $1 AND disclosure_day = $2",
    [deps.twinId, served.day],
  );
  if (already.rows.length > 0) {
    throw new Error(
      `twin ${deps.twinId} already has a disclosure post for ${served.day} — the day is posted once (disclosure_posts_one_per_twin_day), so this execution has nothing to post and may not record that it did`,
    );
  }
  // ...AND EVERY LINE THIS POST CARRIES IS STILL OWED, re-read under the lock
  // (Codex r3 on #51, kept through the automation). The composition read the
  // day BEFORE the model call, because that is what the model composes about,
  // and `disclosure_posts_one_per_twin_day` only stops two posts that AGREE
  // about the day. Near midnight two passes DISAGREE: one keys the rep's
  // today and the other tomorrow, both were shown the same pending set, and
  // both would commit — so the rep would read their own account of what
  // crossed twice, in two posts numbering the same lines differently, which
  // is precisely what a correction cannot survive.
  //
  // IT IS THE `failed` ENDING RATHER THAN A QUIET ONE, because nothing
  // posted: `posted` means posted (the ruling on #194), and there is no
  // honest word for "somebody else told the rep while I was composing". The
  // lines are not lost — they are claimed by the post that did go out — and
  // the runtime stays up. Reachable only with two runtimes on one twin, which
  // this build assumes away everywhere else (spec #171 decision 3), so the
  // record is the whole of what it costs.
  //
  // ONE WALK, ASKED ABOUT AND THEN POSTED. `numbered` is what the check
  // below reads and what the post carries, so there is no second traversal
  // that could number differently. It is never empty: `readTheDay` returns
  // `undefined` for a day with no pending line, so the precondition refuses
  // one (ticket #218 — a day could owe questions alone while the
  // candidate-question route stood, and posted no `disclosure_posts` row).
  const numbered = numberedLines(served);
  const owed = new Set(
    (await readPendingLines({ ...deps, db: client })).map((line) => line.id),
  );
  const told = numbered.filter((line) => !owed.has(line.disclosureLineId));
  if (told.length > 0) {
    throw new Error(
      `${String(told.length)} of this post's lines were disclosed by another post while this execution was composing — a second account of one line, numbered differently, is what a correction cannot survive (spec #48 decision 14)`,
    );
  }

  // THE DISCLOSURE POST'S ID IS MINTED HERE (ticket #220), because the
  // post's `record-lines` part NAMES it: the part is a REFERENCE to the
  // numbering ADR-0034's trigger seals with this row, never a copy of it, so
  // it cannot wait for the INSERT's own default. The three writes below are
  // one transaction, which is what keeps the reference honest — the store
  // cannot check a reference that lives inside sealed bytes.
  const postId = randomUUID();
  const post = composeDisclosurePost({
    disclosurePostId: postId,
    groups: served.groups,
    opening: withNames(dayPost.opening, served),
    closing: withNames(dayPost.closing, served),
    now,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
  });

  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    dek: deps.dek,
    kind: "daily_disclosure",
    post,
    executionId,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
  });
  await client.query(
    `INSERT INTO disclosure_posts (id, twin_id, disclosure_day, notice_id)
     VALUES ($1, $2, $3, $4)`,
    [postId, deps.twinId, served.day, noticeId],
  );
  for (const line of numbered) {
    await client.query(
      `INSERT INTO disclosure_post_lines
         (twin_id, post_id, line_index, disclosure_line_id)
       VALUES ($1, $2, $3, $4)`,
      [deps.twinId, postId, line.index, line.disclosureLineId],
    );
  }
  return { noticeId, lines: numbered.length };
}

/**
 * The numbering the rep will read, in the order it was rendered.
 *
 * ONE ARRAY FOR THE RENDER AND THE RECORD. The grouping walked the lines
 * once, so the index a line got in the post is the index recorded against it;
 * there is no second traversal that could number differently, and the
 * still-owed check above asks about the same array the post will carry.
 */
function numberedLines(served: TheDay): readonly NumberedLine[] {
  return served.groups.flatMap((group) => group.lines);
}

/**
 * The prose with every slot filled by the name its reference names.
 *
 * WHAT «CODE RENDERS THE VALUE» MEANS HERE (ADR-0037 as amended; the thread's
 * own `foldSlots`): the twin wrote the sentence and said where a name goes,
 * and this is the step that puts the name there — resolved from what this
 * execution was served, never a string model text produced. The guard has
 * already refused a slot naming a reference nothing served, so `foldSlots`'
 * own throw is a disagreement between the two halves rather than a path.
 *
 * IT IS THE NAME THE GROUP HEADING CARRIES, and that is the whole rule: both
 * come from the bundle's entity mirror, which is the rep's own confirmed word
 * for that customer (ADR-0004) and therefore what `counterpartyName` yields
 * for a confirmed binding, unmarked. One post naming a customer two ways
 * would be worse than either way.
 */
function withNames(prose: string, served: TheDay): string {
  return foldSlots(
    prose,
    (ref) => servedCounterparty(served.deps, ref)?.name,
  );
}

/** The day, as the pass read it: what the execution is served, and what posts. */
interface TheDay {
  readonly day: string;
  readonly groups: readonly NumberedGroup[];
  readonly deps: DisclosureDeps;
}

/**
 * THE DAY'S OWN ROWS, read once and served twice (spec #193 decision 22).
 *
 * ONE WALK BUILDS BOTH, which is the invariant that matters: the lines the
 * model is SHOWN and the lines code POSTS are the same array, numbered once,
 * and the references the model composes against are minted here. Two walks
 * would be two numberings, and the rep's correction resolves through one of
 * them.
 *
 * Returns `undefined` for a day that owes nothing — no pending line — which
 * is the precondition's second half and the reason an empty day creates no
 * execution at all. One test, because a day has one kind of debt (ticket
 * #218).
 *
 * THE COUNTERPARTIES ARE NUMBERED IN READING ORDER, and the day's groups are
 * the only source of one: a question about a customer with no lines was the
 * other, and the route that raised one is retired (ticket #218).
 */
async function readTheDay(
  deps: DailyDisclosureDeps,
  now: Date,
  day: string,
): Promise<TheDay | undefined> {
  const pending = await readPendingLines(deps);
  // NOTHING OWED, NO EXECUTION AND NO RECORD (spec #48 decision 17) — the
  // precondition's second half, asked before anything is minted.
  if (pending.length === 0) return undefined;

  const names = new Map(
    deps.bundle
      .listChatBindings()
      .map((binding) => [binding.entityId, binding.displayName]),
  );
  const groups = assembleDisclosureGroups(pending, names);

  /** The next reference to mint — one counter over everything served. */
  let next = 0;
  const minted: { ref: number; entityId: string; name: string }[] = [];
  /**
   * The reference for one customer, minting it the first time.
   *
   * LOUD ON A CUSTOMER THE MIRROR CANNOT NAME, exactly as the grouping is:
   * every entity that crossed came from a rep-confirmed binding, so a
   * nameless one is a broken mirror rather than a customer to leave unnamed
   * (ADR-0004).
   */
  const refOf = (entityId: string): number => {
    const known = minted.find((candidate) => candidate.entityId === entityId);
    if (known !== undefined) return known.ref;
    const name = names.get(entityId);
    if (name === undefined) {
      throw new Error(
        `this post names entity ${entityId}, which the bundle's entity mirror does not know — every entity that crossed came from a rep-confirmed binding, so a nameless one is a broken mirror (ADR-0004)`,
      );
    }
    next += 1;
    minted.push({ ref: next, entityId, name });
    return next;
  };

  // THE CUSTOMERS ARE MINTED IN READING ORDER: the day's groups, as the post
  // will print them.
  const served: ServedGroup[] = groups.map((group) => ({
    counterparty: refOf(group.entityId),
    lines: group.lines.map((line) => ({
      index: line.index,
      text: line.text,
      // THE SAME CLAUSE THE POST WILL CARRY, off the grammar's own renderer
      // rather than a second formatter (spec #193 decision 22: "exactly as
      // code will render them").
      provenance: renderDisclosureProvenance(
        line.provenance,
        now,
        deps.timeZone,
      ),
    })),
  }));

  return {
    day,
    groups,
    deps: {
      // THE ENTITY ID STAYS ON THIS SIDE. What the execution is served is a
      // reference and a name; an id it could neither read nor use would be a
      // value in a prompt for nobody's benefit.
      counterparties: minted.map(({ ref, name }) => ({ ref, name })),
      groups: served,
      repLanguage: deps.repLanguage ?? DEFAULT_REP_LANGUAGE,
      timeZone:
        deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}

/**
 * Every line this twin still owes the rep, oldest first.
 *
 * DISCLOSED IS A QUESTION ABOUT DELIVERY, not about bookkeeping (Codex
 * r1/r2). A `disclosure_post_lines` row records that the twin QUEUED a
 * line in a post; a post whose `system_send` the executor resolves
 * `failed` reached nobody. Treating the mapping alone as "told" made a
 * failed send into permanent silence — the line claimed by a post the rep
 * never saw, and every audit green.
 *
 * So a line is owed unless some post carrying it either reached the rep
 * (`sent`) or is still in flight (unresolved — wait for it, do not post it
 * twice). Everything else comes back, in the next day's post under its own
 * numbering — which resolves correctly because «N no» is always read
 * against the post the rep quoted.
 *
 * `held` COUNTS AS NOT ARRIVED (Codex r3). It is the plane's "I cannot say
 * whether this landed" — the executor claims a command, dies before the
 * socket, and the stale-claim sweep finalizes it `held` with no
 * `send_executions` row, which is indistinguishable from a send that
 * really went. Suppressing on that unknown chooses SILENCE: a crossing the
 * rep is never told about, with every audit green. Re-posting chooses a
 * possible DUPLICATE: the rep may read the same lines under two posts, a
 * day apart. On this surface the duplicate is the safe direction — FR-38's
 * claim is that the account is complete, not that it is terse — so the
 * unknown is owed. (The plane's own «never re-send an unknown» rule is
 * about the MESSAGE and still holds: nothing re-sends that command. This
 * is the next day's post, a new message, saying a thing the twin cannot
 * confirm the rep has read.)
 *
 * Nothing is retried and nothing is abandoned: the seam's own rule holds
 * («never auto-retried», `send_commands`), and a rail that is down simply
 * means the day's post lands on the day the rail comes back.
 *
 * The selection is deliberately NOT "lines filed today", and carries no
 * upper time bound at all. FR-38's claim is about everything that crossed,
 * so a line whose day the pass missed — the laptop was shut, the run
 * crashed before its commit — is carried into the next post rather than
 * lost forever. A day whose EXECUTION failed is the same case: the attempt
 * row stops it being composed again today, and the lines it never posted are
 * still owed tomorrow (spec #193 decision 10).
 *
 * No `filed_at <= now` either, deliberately: `filed_at` is the DATABASE's
 * clock and `now` is the caller's, and comparing them would make the
 * completeness claim depend on two clocks agreeing. A line that exists is
 * a line that crossed, and a line that crossed is owed.
 *
 * THE ORDER IS THE ORDER THE DAY HAPPENED (ticket #52; ruled on #200,
 * 2026-09-06). `act.occurred_at` is when the message this line rests on was
 * sent, so a line's place in the post is the moment the thing happened in the
 * customer's chat — which is how the rep reads their own day, and the only
 * ordering that is a fact about the day rather than about the machine.
 *
 * FILING ORDER IS THE TIEBREAKER AND NOT THE KEY, and that is the whole of
 * the decision. `filed_at` is the statement's clock (…20260906100040), so it
 * distinguishes every line one execution filed — and as the leading key it
 * would hand the rep's numbering to the sequence the MODEL happened to list
 * its facts in. Two lines resting on the same message keep filing order
 * between them, and `id` settles what a single statement wrote.
 *
 * Every line has this instant, and it comes off ONE OF TWO ACT ROWS (#224). `disclosure_lines_one_evidence_check` refuses a line naming neither
 * surface and refuses one naming both, so the COALESCE below is total: the
 * seam event for a fact and for a binding the rep confirmed with «va», the
 * `dashboard_acts` row for one they confirmed by pressing the card's button.
 * Two surfaces, one instant, and `provenanceOf` below is what tells the rep
 * whether they are reading a customer's message or their own act.
 */
async function readPendingLines(
  deps: DailyDisclosureDeps,
): Promise<PendingLine[]> {
  const res = await deps.db.query<{
    id: string;
    subject_kind: "fact" | "entity_create";
    entity_id: string | null;
    rendered_text: string;
    act_at: Date | null;
  }>(
    `SELECT dl.id, dl.subject_kind, dl.entity_id, dl.rendered_text,
            COALESCE(act.occurred_at, dact.acted_at) AS act_at
       FROM disclosure_lines dl
       LEFT JOIN wa_events act ON act.id = dl.source_event_id
       LEFT JOIN dashboard_acts dact ON dact.id = dl.dashboard_act_id
      WHERE dl.twin_id = $1
        AND NOT EXISTS (
              SELECT 1
                FROM disclosure_post_lines pl
                JOIN disclosure_posts p ON p.id = pl.post_id
                JOIN send_commands sc
                  ON sc.payload_ref = 'notice:' || p.notice_id
                 AND sc.twin_id = dl.twin_id
               WHERE pl.disclosure_line_id = dl.id
                 AND (sc.outcome = 'sent' OR sc.outcome IS NULL))
      ORDER BY COALESCE(act.occurred_at, dact.acted_at), dl.filed_at, dl.id`,
    [deps.twinId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    subjectKind: row.subject_kind,
    entityId: row.entity_id,
    renderedText: row.rendered_text,
    actAt: row.act_at,
  }));
}

/**
 * The lines grouped under the counterparty they belong to (story 5), numbered
 * CONTINUOUSLY across the whole post so that «N no» names exactly one line
 * (spec #48 decision 14).
 *
 * GROUP FIRST, NUMBER SECOND — in that order, and it matters. The number
 * is what the rep reads down the page, so it has to follow the RENDERED
 * order, not the order the lines were filed in. Numbering as the lines
 * come off the seam would interleave: two counterparties whose crossings
 * alternate through the day would render as «1, 3» under one heading and
 * «2» under the other, and the rep would be looking at a page whose
 * numbers do not count.
 *
 * Group order, and order within a group, are both filing order — oldest
 * first, the way the day happened.
 *
 * The name comes from the bundle's entity mirror and nowhere else. A line
 * whose entity the mirror does not know is a broken invariant, not a line
 * to render namelessly: every entity that crossed this slice crossed from
 * a binding, and the mirror is where bindings live. Loud, like every other
 * failure in this runtime.
 */
export function assembleDisclosureGroups(
  pending: readonly PendingLine[],
  /** entity id → the counterparty's rep-confirmed name, from the bundle's mirror. */
  names: ReadonlyMap<string, string>,
): NumberedGroup[] {
  const order: string[] = [];
  const byEntity = new Map<string, PendingLine[]>();
  for (const line of pending) {
    // Every line names its entity since ticket #52: a fact's does because
    // the pass cannot read the Ledger to find one (…100012 gives the twin
    // runtime no privilege on a Ledger table), an entity create's always
    // did. The null branch is unrepresentable through the seam — the
    // subject CHECK requires it for both kinds — and is refused rather than
    // grouped under a placeholder.
    const entityId = line.entityId ?? lineWithNoEntity(line);
    const bucket = byEntity.get(entityId);
    if (bucket === undefined) {
      order.push(entityId);
      byEntity.set(entityId, [line]);
    } else {
      bucket.push(line);
    }
  }
  let index = 0;
  return order.map((entityId) => {
    const counterparty = names.get(entityId);
    if (counterparty === undefined) {
      throw new Error(
        `disclosure line names entity ${entityId}, which the bundle's entity mirror does not know — every entity that crossed came from a rep-confirmed binding, so a nameless one is a broken mirror, never a line to render without naming its counterparty (ADR-0004)`,
      );
    }
    const lines = byEntity.get(entityId)!.map((line): NumberedLine => {
      index += 1;
      return {
        index,
        text: line.renderedText,
        provenance: provenanceOf(line),
        disclosureLineId: line.id,
      };
    });
    return { entityId, counterparty, lines };
  });
}

/**
 * A line with no entity at all. Unrepresentable through the seam — the
 * subject CHECK (…100026) requires one for both subject kinds — and loud
 * rather than skipped: a crossing the twin cannot attribute is not one to
 * leave out of the rep's account of what crossed (FR-38).
 */
function lineWithNoEntity(line: PendingLine): never {
  throw new Error(
    `disclosure line ${line.id} names no entity — every line carries the customer its subject was filed against (migration …100026), so a nameless one is a broken seam and never a line to render unattributed (FR-32)`,
  );
}

/**
 * Where the line came from, in the rep's own vocabulary — decided by WHO
 * DID IT, which is exactly the subject kind.
 *
 * An entity create is the rep's own act, so it reads «tú lo confirmaste»
 * and its instant is when THEY confirmed: the plane's stamp on the yes,
 * never this pass's clock. An extracted fact is something the twin READ in
 * a customer chat, so it reads «su chat» and its instant is when the
 * message was sent, which is what lets the rep go and check it.
 *
 * Both instants are the same column (`wa_events.occurred_at`, joined
 * through the line's `source_event_id`), because both are the moment the
 * message this line rests on was sent. What differs is what the rep is
 * being told about that moment.
 *
 * The null branch is unreachable through the seam (…100026 makes
 * `source_event_id` NOT NULL and the join is a foreign key). It stays
 * because a line the twin cannot date is a line it cannot honestly place,
 * and guessing an instant would put a claim in the rep's account that the
 * twin cannot support.
 */
function provenanceOf(line: PendingLine): DisclosurePostLine["provenance"] {
  if (line.actAt === null) {
    throw new Error(
      `disclosure line ${line.id} names a seam row with no instant — every line carries the event its subject was read in (migration …100026), so a dateless one is a broken seam, never a line to date by guessing`,
    );
  }
  return {
    kind: line.subjectKind === "fact" ? "chat" : "rep_act",
    at: line.actAt,
  };
}

/**
 * What the lookup needs: the seam and the twin, no key. Nothing on this
 * path decrypts — the number the rep typed is matched against stored rows,
 * never against a rendered post.
 */
export interface DisclosureLookupDeps {
  /** A connection to ask on — see `QuotedLookupDeps`, widened at #173. */
  readonly db: pg.ClientBase;
  readonly twinId: string;
}

/** One disclosure line, found by the number the rep actually read. */
export interface ResolvedDisclosureLine {
  readonly postId: string;
  readonly lineIndex: number;
  readonly disclosureLineId: string;
  readonly subjectKind: "fact" | "entity_create";
  readonly factId: string | null;
  readonly entityId: string | null;
  readonly renderedText: string;
}

/**
 * The notice that carried a disclosure post + N → the disclosure line the
 * rep meant (spec #48 decision 14; ADR-0003 class 2).
 *
 * The whole chain is stored rows: the executor's record of which posted
 * message carries which `system_send`, that command's `notice:` ref, the
 * post minted against that notice, and the numbering recorded when it was
 * rendered. No model, no re-derivation, no ordering that could have
 * drifted since the rep read the post — the number they typed is the
 * number they saw. That stays exactly true now that an execution composes
 * the sentences AROUND the lines: the numbering is code's, recorded in the
 * same transaction as the post, and no call of the model's can reach it.
 *
 * THE QUOTED-ID HALF IS NOT HERE, and that is the point (ticket #49's rule,
 * held to at ticket #54). Turning a quoted WhatsApp message id into the
 * post the twin sent is the registry's one join; this function starts from
 * the notice that join returned. So the disclosure post is an ordinary
 * registry entry — its verb is «N no» rather than a bare word, which is a
 * property of the entry, not a reason to resolve quoted ids twice.
 *
 * Undefined whenever the number names no line in that post. That is the
 * fail-safe direction: a correction that cannot be resolved must annotate
 * nothing, and the rep is told.
 */
export async function resolveDisclosureLineOfPost(
  deps: DisclosureLookupDeps,
  target: { readonly noticeId: string; readonly lineIndex: number },
): Promise<ResolvedDisclosureLine | undefined> {
  if (!Number.isInteger(target.lineIndex) || target.lineIndex < 1) {
    return undefined;
  }
  const res = await deps.db.query<{
    post_id: string;
    line_index: number;
    disclosure_line_id: string;
    subject_kind: "fact" | "entity_create";
    fact_id: string | null;
    entity_id: string | null;
    rendered_text: string;
  }>(
    `SELECT p.id AS post_id, pl.line_index, pl.disclosure_line_id,
            dl.subject_kind, dl.fact_id, dl.entity_id, dl.rendered_text
       FROM disclosure_posts p
       JOIN disclosure_post_lines pl ON pl.post_id = p.id
       JOIN disclosure_lines dl ON dl.id = pl.disclosure_line_id
      WHERE p.notice_id = $1
        AND p.twin_id = $2
        AND pl.line_index = $3`,
    [target.noticeId, deps.twinId, target.lineIndex],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  return {
    postId: row.post_id,
    lineIndex: row.line_index,
    disclosureLineId: row.disclosure_line_id,
    subjectKind: row.subject_kind,
    factId: row.fact_id,
    entityId: row.entity_id,
    renderedText: row.rendered_text,
  };
}
