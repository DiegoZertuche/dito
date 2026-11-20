/**
 * The twin-post registry as a structure (ticket #49 AC 1; CONTRACTED at
 * #174). Resolution itself is behaviour at the Postgres seam and is tested
 * there (matcher.int.test.ts, bindings.int.test.ts); what this file pins is
 * the shape the rest of the slice rests on:
 *
 * 1. The accepted set is a FUNCTION OF THE POST'S KIND, read off the
 *    registry — so the fail-safe direction («si» never sends) is a
 *    property of the table rather than of a branch someone could forget.
 * 2. TWO KINDS SPEAK AND TWO ARE SILENT (#174). The aperture question's
 *    «si» and the daily disclosure's «N no» were verbs here; both are prose
 *    now, so their entries carry no keyword and the matcher cannot reach
 *    them. Their kinds stay, because a quoted post still has to be NAMED.
 * 3. Quoted-target resolution lives in ONE place. A source sweep, in the
 *    spirit of the plane's sole-sender AST scan and the binding wall: no
 *    module outside twin-posts.ts resolves a quoted WhatsApp message id to
 *    the payload it carries, so adding a post kind is a registry entry and
 *    never a new branch in the tap minter. Like those scans, it proves it
 *    can catch its violation before certifying the tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptsAffirmation } from "./affirmation.js";
import { TWIN_POST_KINDS, type TwinPostKind } from "./twin-posts.js";

/**
 * THE TWO KINDS WHOSE POSTS TAKE A KEYWORD, and the two whose acts are
 * prose (ticket #174; spec #171 decision 18).
 *
 * HAND-KEPT, AND HELD TOTAL by the test below: the two halves must
 * partition `TWIN_POST_KINDS`, so a fourth kind fails here until somebody
 * classifies it rather than quietly dropping out of both sweeps. Written
 * out rather than derived from `entry.keyword` on purpose — deriving it
 * would make the lists agree with the table by construction and assert
 * nothing about WHICH kinds the ticket decided keep a keyword.
 */
const KEYWORD_KINDS = [
  "draft",
  "binding_question",
] as const satisfies readonly TwinPostKind[];

/**
 * ...and the prose side: the day's notes, and a run's question card (ticket
 * #324), both answered in the rep's own words.
 */
const PROSE_KINDS = [
  "daily_disclosure",
  "ask",
  "proposal",
] as const satisfies readonly TwinPostKind[];

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("the accepted set is a function of the quoted post's kind", () => {
  it("every kind is classified — a new kind cannot slip out of both sweeps", () => {
    // The totality claim that makes the two hand-kept lists safe. It is the
    // registry's own `Record<TwinPostKind, …>` guarantee, restated over the
    // one decision the table cannot argue for itself.
    expect([...KEYWORD_KINDS, ...PROSE_KINDS].sort()).toEqual(
      (Object.keys(TWIN_POST_KINDS) as TwinPostKind[]).sort(),
    );
  });

  it("exactly the two keyword kinds carry a keyword, and the prose kinds carry none", () => {
    // THE CONTRACTION, AS A PROPERTY OF THE TABLE (ticket #174). An entry
    // with no keyword is one the matcher cannot reach: `resolveQuotedTarget`
    // skips it, so a quoted reply to the daily disclosure resolves
    // `actionable: false` and becomes prose whatever words it carries.
    for (const kind of KEYWORD_KINDS) {
      const keyword = TWIN_POST_KINDS[kind].keyword;
      expect(keyword, kind).toBeDefined();
      expect(["proposal", "question"]).toContain(keyword!.grammar);
      expect(typeof keyword!.recognize).toBe("function");
    }
    for (const kind of PROSE_KINDS) {
      expect(TWIN_POST_KINDS[kind].keyword, kind).toBeUndefined();
    }
  });

  it("a kind's verb comes from its own registry entry — the matcher holds no per-kind branch", () => {
    // The AC's structural claim, checked on the table itself: a draft
    // recognized from the executor's record hands back the verb bound to
    // THAT draft, and nothing outside the registry chose it.
    const draft = TWIN_POST_KINDS.draft.keyword!.recognize(
      { payloadRef: "draft:abc", draftId: "abc", noticeId: null },
      undefined,
    );
    expect(typeof draft).toBe("function");
    // And a row whose payload_ref does not name its own draft is refused —
    // the mint is bound to the content the rep saw.
    expect(
      TWIN_POST_KINDS.draft.keyword!.recognize(
        { payloadRef: "draft:other", draftId: "abc", noticeId: null },
        undefined,
      ),
    ).toBeUndefined();
    // A notice post is not a draft, whatever else it is.
    expect(
      TWIN_POST_KINDS.draft.keyword!.recognize(
        { payloadRef: "notice:n1", draftId: null, noticeId: "n1" },
        { kind: "binding_question", aboutEventId: "7", text: "✳️ ¿…?" },
      ),
    ).toBeUndefined();
    // And a binding question is recognized only by its notice kind.
    expect(
      TWIN_POST_KINDS.binding_question.keyword!.recognize(
        { payloadRef: "notice:n1", draftId: null, noticeId: "n1" },
        { kind: "answer", aboutEventId: "7", text: "✳️ …" },
      ),
    ).toBeUndefined();
    expect(
      TWIN_POST_KINDS.binding_question.keyword!.recognize(
        { payloadRef: "notice:n1", draftId: null, noticeId: "n1" },
        { kind: "binding_question", aboutEventId: "7", text: "✳️ ¿…?" },
      ),
    ).toBeDefined();
  });

  it("a draft speaks the proposal grammar: «va» affirms it, the question's yes-words do not", () => {
    const { grammar } = TWIN_POST_KINDS.draft.keyword!;
    expect(acceptsAffirmation(grammar, "va")).toBe(true);
    for (const yes of ["si", "s\u00ed", "si\u0301"]) {
      expect(acceptsAffirmation(grammar, yes)).toBe(false);
    }
  });

  it("a binding question speaks the question grammar: «si», «sí» and «va» all affirm it", () => {
    const { grammar } = TWIN_POST_KINDS.binding_question.keyword!;
    for (const yes of ["si", "s\u00ed", "si\u0301", "va"]) {
      expect(acceptsAffirmation(grammar, yes)).toBe(true);
    }
  });

  it("no keyword kind accepts a word that means no — the decline is prose (ticket #174)", () => {
    for (const kind of KEYWORD_KINDS) {
      const { grammar } = TWIN_POST_KINDS[kind].keyword!;
      for (const no of ["no", "no va", "así no", "ya no"]) {
        expect(acceptsAffirmation(grammar, no), `${kind}/${no}`).toBe(false);
      }
    }
  });

  /**
   * THE DAILY DISCLOSURE HAS NO KEYWORD (ticket #174; spec #171 decision
   * 18).
   *
   * Its «N no» was the registry's only INDEXED verb, and it is prose now:
   * the entry is present so a quoted post can still be NAMED — the
   * execution has to be told it is looking at a disclosure to retract one of
   * its lines — and empty of anything the matcher can reach. The aperture
   * question's «si» was the third keyword and shared this ending, and ticket
   * #218 retires the post itself.
   */
  it("the prose kind cannot be reached by any word at all", () => {
    for (const kind of PROSE_KINDS) {
      expect(TWIN_POST_KINDS[kind].keyword, kind).toBeUndefined();
    }
  });

  it("but it is still in the table, so a quoted post of it can be named", () => {
    // `readPostedPost` names a quoted post from these keys
    // (`isTwinPostKind`), and the `quoted_post` recipe renders the kind it
    // gets — so a table missing this one would show the model a
    // disclosure post as "something you said earlier" and leave
    // `retract_disclosure_line` with no target it could recognize.
    expect(Object.keys(TWIN_POST_KINDS)).toContain("daily_disclosure");
  });
});

/**
 * The join that turns a quoted WhatsApp message id into the payload the
 * twin posted. Only the registry may perform it.
 */
const QUOTED_RESOLUTION = /send_executions[\s\S]{0,200}?JOIN\s+send_commands/i;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `.next` and `.scratch` joined the two with the first app (#129):
    // build output holds inlined copies of the packages this scan reads,
    // and scratch holds ticket text nobody committed.
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".next" ||
      entry.name === ".scratch"
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("quoted-target resolution lives in one registry (ticket #49 AC 1)", () => {
  it("no module outside twin-posts.ts resolves a quoted message id to its payload", () => {
    const owner = path.join(
      REPO_ROOT,
      "packages/twin-runtime/src/twin-posts.ts",
    );
    const offenders: string[] = [];
    // `apps/` JOINED `packages/` WITH THE FIRST APP (#129). The claim is
    // "no module outside twin-posts.ts", and a scan that walks only
    // `packages` stops being that claim the moment a module lives
    // somewhere else. The owner web resolves no quoted post and never
    // will — it holds no twin credential — which is exactly the kind of
    // thing that stays true only while something checks it.
    const roots = [
      path.join(REPO_ROOT, "packages"),
      path.join(REPO_ROOT, "apps"),
    ];
    for (const file of roots.flatMap((root) => [...walk(root)])) {
      if (!/\.(ts|mts|cts|tsx)$/.test(file)) continue;
      // Tests read the seam directly to assert what the executor recorded;
      // the rule is about the modules that DECIDE.
      if (/\.test\.ts$/.test(file)) continue;
      if (file === owner) continue;
      if (QUOTED_RESOLUTION.test(readFileSync(file, "utf8"))) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(
      offenders,
      "these modules resolve a quoted twin post themselves — a post kind is a registry entry in twin-posts.ts, never a new branch beside the tap minter (ticket #49)",
    ).toEqual([]);
  });

  it("the sweep can catch its violation", () => {
    expect(
      QUOTED_RESOLUTION.test(
        `SELECT sc.draft_id FROM send_executions se
           JOIN send_commands sc ON sc.id = se.command_id
          WHERE se.wa_message_id = $1`,
      ),
    ).toBe(true);
    // The echo check reads send_executions ALONE — that is origin tagging,
    // not target resolution, and it stays in the matcher.
    expect(
      QUOTED_RESOLUTION.test(
        "SELECT 1 FROM send_executions WHERE twin_id = $1 AND wa_message_id = $2",
      ),
    ).toBe(false);
  });
});
