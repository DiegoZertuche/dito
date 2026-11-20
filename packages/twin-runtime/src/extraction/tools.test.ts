/**
 * THE SEARCH'S ROW SOURCE (ticket #196 AC 2; spec #193 decision 18; ADR-0033).
 *
 * ONE CLAIM THE POSTGRES SEAM CANNOT MAKE. Everything else about looking is
 * seam-visible — a filed line with its mark, a run row's counters, a question
 * — but "no query, however scripted, returns a self-chat row" is a claim
 * about the QUERY, and the seam can only ever show that the queries a
 * particular script happened to make did not. So this drives the real tool
 * over a real bundle with the rep's own thread deliberately seeded into it,
 * and asks the search for exactly those rows.
 *
 * REAL SQLCIPHER, REAL VECTORS, NO MODEL (ADR-0028: the crypto is never
 * mocked; the model boundaries are scripted). The bundle is the one this
 * repository ships, the embedder is the integration lanes' deterministic fake
 * — a hashed bag-of-words unit vector, so cosine similarity follows word
 * overlap and a ranking is exactly assertable — and the tool's handler is
 * called the way the runner calls it.
 *
 * WHY THE FAKE EMBEDDER IS NOT A CHEAT HERE. The claim under test is about
 * which ROWS the KNN may choose from, not about how near any of them is. The
 * self-chat rows are seeded to be the NEAREST rows in the store by a wide
 * margin — the query is their own words — so a search that could reach them
 * would return them first, and one that cannot returns the customer row
 * instead or nothing at all.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedOne } from "../embedder.js";
import {
  extractionDeps,
  FIXTURE_CHAT,
  FIXTURE_SELF_CHAT,
} from "../testing/extraction-deps.js";
import { fakeEmbedder } from "../testing/fake-embedder.js";
import { removeTmpDir } from "../testing/tmp.js";
import { ServedReads } from "./served.js";
import { listChatsTool, searchChatHistoryTool } from "./tools.js";

/** What the rep told their twin, in their own thread — never a fact. */
const SELF_NOTES = [
  "no le contestes a Torres todavia",
  "recuerdame pedirle a Torres las 500 cajas de mortero",
  "Torres siempre paga tarde, no le des credito",
];

/** ...and what a customer actually said, in a customer chat. */
const CUSTOMER_LINE = "me mandas 40 bultos de cemento";

/** A conversation NOBODY has named: no binding, and no push-name on its rows. */
const UNNAMED_CHAT = "5215559999@s.whatsapp.net";
const UNNAMED_LINE = "necesito 12 tambos de sellador";

let tmp: string;
let bundle: Bundle;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "dito-extraction-tools-"));
  const dek = createDekFromMaterial(randomBytes(32));
  bundle = createBundle(join(tmp, "twin.bundle"), dek);
  const embedder = fakeEmbedder();
  let at = 0;
  const write = async (
    chatJid: string,
    content: string,
    fromMe: boolean,
    pushName: string | undefined,
  ): Promise<void> => {
    at += 1;
    const stored = bundle.ingestMessage({
      chatJid,
      messageId: `WAMID-${String(at)}`,
      senderJid: fromMe ? FIXTURE_SELF_CHAT : chatJid,
      fromMe,
      occurredAt: new Date(Date.UTC(2026, 8, 1, 12, at)).toISOString(),
      content,
      ...(pushName === undefined ? {} : { pushName }),
    });
    // The vector is what makes a row retrievable at all, so the fixture
    // writes it exactly as the ingest path does (`backlog.ts`).
    bundle.writeMessageVector(
      stored.storeId,
      await embedOne(embedder, content),
    );
  };
  const remember = (chatJid: string, content: string, fromMe: boolean) =>
    write(chatJid, content, fromMe, fromMe ? undefined : "Torres");
  const rememberUnnamed = (chatJid: string, content: string) =>
    write(chatJid, content, false, undefined);
  for (const note of SELF_NOTES) {
    // THE REP'S OWN THREAD, and both sides of it: a note the rep typed and
    // the twin's own answer. Either would be a disaster to extract from.
    await remember(FIXTURE_SELF_CHAT, note, true);
    await remember(FIXTURE_SELF_CHAT, `✳️ ${note}`, true);
  }
  await remember(FIXTURE_CHAT, CUSTOMER_LINE, false);
  await rememberUnnamed(UNNAMED_CHAT, UNNAMED_LINE);
});

afterAll(() => {
  bundle.close();
  removeTmpDir(tmp);
});

function search(): ReturnType<typeof searchChatHistoryTool> {
  return searchChatHistoryTool(
    extractionDeps({ bundle, embedder: fakeEmbedder(), served: new ServedReads() }),
  );
}

describe("search_chat_history cannot reach the twin thread (ADR-0033)", () => {
  it("returns nothing from it however exactly a query asks for it", async () => {
    for (const note of SELF_NOTES) {
      const answer = await search().run({ about: note, chat: null });
      expect(String(answer), note).not.toContain(note);
      // ...and it does not merely omit the words: no line of the answer is
      // from that conversation at all.
      expect(String(answer), note).not.toContain("✳️");
    }
  });

  it("still finds what a CUSTOMER said, so the exclusion is not an empty store", async () => {
    // The green above would be worthless if the search returned nothing for
    // any query: this is the same tool, the same bundle and the same
    // embedder, finding the one row it is allowed to.
    const answer = String(
      await search().run({ about: "cemento bultos", chat: null }),
    );
    expect(answer).toContain(CUSTOMER_LINE);
  });

  it("returns the customer's row even when the thread holds nearer ones", async () => {
    // The self-chat notes are ABOUT Torres and name the goods; the customer
    // row shares neither word. A search that could reach the thread would
    // rank three self-chat rows above it and fill the page with them.
    const answer = String(
      await search().run({ about: "Torres cajas de mortero", chat: null }),
    );
    for (const note of SELF_NOTES) expect(answer).not.toContain(note);
  });

  it("labels a chat nobody has named without its address (Codex round 2)", async () => {
    // `counterpartyName` falls back to the NUMBER with neither a binding nor
    // a push-name, which is right on the rep side and wrong on a read whose
    // output can end up in a Ledger payload (ADR-0004). The customer chat
    // here is unbound and its rows carry a push-name; the SELF rows do not,
    // and neither does an unnamed customer.
    const answer = String(
      await search().run({ about: "tambos de sellador", chat: null }),
    );
    expect(answer).toContain(UNNAMED_LINE);
    expect(answer).toContain("a customer the rep has not named");
    expect(answer).not.toContain(UNNAMED_CHAT.split("@")[0]);
    expect(answer).not.toContain("@s.whatsapp.net");
  });

  it("cannot be narrowed TO it either: the thread has no reference to name", async () => {
    // `list_chats` serves the references the search is narrowed by, and it
    // reads the entity mirror — where the rep's own thread can never be,
    // because a binding is the rep saying which CUSTOMER a chat belongs to.
    const deps = extractionDeps({
      bundle,
      embedder: fakeEmbedder(),
      served: new ServedReads(),
    });
    const listed = String(await listChatsTool(deps).run({}));
    expect(listed).toBe("The rep has confirmed no customer conversations yet.");
    // So the only thing the model could send is a number nothing served,
    // and that is refused rather than quietly widened.
    const refused = String(
      await searchChatHistoryTool(deps).run({ about: "cemento", chat: 1 }),
    );
    expect(refused).toContain("rejected: no conversation has been served");
  });
});
