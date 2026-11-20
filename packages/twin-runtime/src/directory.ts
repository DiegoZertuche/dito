/**
 * THE CHAT DIRECTORY, WITH ITS NAMES OPENED (ticket #223; spec #214 decision
 * 7 and user story 16; ADR-0008, ADR-0010, ADR-0023 as #222 amends it).
 *
 * "As a rep, I want to see my chat list with everything switched off, so that
 * I choose what the twin reads and my family chats stay visibly untouched."
 * The list is `chat_directory` — one row per chat the plane has seen, in scope
 * or not — and this is the read the scoping page gets it through.
 *
 * ═══ WHY IT IS THE LEASE HOLDER'S READ AND NOT A PAGE'S
 *
 * One column: `name_enc`. What a rep's phone calls a person is rep content by
 * any reading, so the plane seals it under the twin DEK exactly as it seals a
 * message payload (ADR-0008), and rep-web holds no key at all — its grant on
 * this table is nine plaintext columns and `name_enc` is not one of them. So
 * the names reach a page OPENED, through here, which is ADR-0010's sentence
 * («dashboards are clients of that service's authenticated API») applied to
 * the one table where it bites hardest.
 *
 * ═══ THE CHAT'S ADDRESS NEVER LEAVES
 *
 * The row's own id is what crosses, and it is the handle every switch names
 * (`TwinDirectoryChat`). A JID on the wire would be a customer's phone number
 * in the page's HTML, in a form's hidden field, in the browser's history and
 * in every log between the two — and ADR-0004's whole point is that chat
 * identity does not travel. The scope acts resolve the row back to its chat on
 * this side.
 *
 * ═══ WHAT IS LISTED, AND THE TWO KINDS THAT ARE NOT
 *
 * `dm` and `group`, which is what the page groups by (people and customer
 * groups, in that order — Diego's reaction).
 *
 * `self` IS NEVER LISTED, and it is not a filter for tidiness: the rep's own
 * thread is in scope STRUCTURALLY rather than by an allowlist row — the
 * plane's guard answers `chat == self` before it reads the allowlist at all
 * (`inScopeOn` in `plane/ingest`) — so a switch on it would be a control that
 * cannot change anything. A row rendered with a switch that does nothing is
 * worse than an absent row, and the twin thread is not a chat the rep chose.
 *
 * `other` IS NOT LISTED EITHER, and that is a decision this ticket takes.
 * `CHAT_KINDS`' fourth word covers "anything else the rail addresses: a
 * broadcast or status list today" — not a conversation with a counterparty, so
 * there is no ninety-day history worth filling and no customer the record could
 * be about. It belongs in the directory (the plane must be able to record every
 * address it sees without failing) and it does not belong on a page that asks
 * «which of your customers may Dito read». If a fifth address server ever turns
 * out to be a real conversation, listing it is one word here — which is the
 * point of the kind being a closed set.
 *
 * ═══ SCOPE IS ASKED THE WAY THE GUARD ASKS IT
 *
 * A modern DM has two identities and the allowlist row may carry either
 * (#222's `pairedIdentity`, whose failure is a chat the rep scoped in whose
 * every message is then dropped at the socket). So a row is in scope when the
 * allowlist holds ITS OWN address or the LID paired with it — the guard's rule,
 * over the same two columns, so the page and the socket cannot disagree about
 * whether a chat is being read.
 */
import type { Dek } from "@dito/crypto";
import type { ChatKind, TwinDirectory, TwinDirectoryChat } from "@dito/seam";
import type pg from "pg";

/** What the directory read needs: a connection, the twin, and the key. */
export interface DirectoryReadDeps {
  readonly db: pg.ClientBase;
  /** The one twin this runtime holds the lease for (ADR-0010). */
  readonly twinId: string;
  /** The key `name_enc` opens under. Held in memory, never on the wire. */
  readonly dek: Dek;
}

/** The kinds a rep can be asked about — see the header for the two that are not. */
const LISTED_KINDS: readonly ChatKind[] = ["dm", "group"];

/**
 * One twin's directory, names opened, newest activity first.
 *
 * ORDERED HERE AND NOT ON THE PAGE, by last activity descending, because the
 * store has the index for it (`chat_directory_twin_activity_idx`) and a rep
 * finds a chat by when they last spoke in it. A chat the plane has seen and
 * never dated sorts last rather than first: `NULLS LAST` is what stops a row
 * with no activity displacing this morning's conversation.
 *
 * THE WHOLE DIRECTORY IN ONE ANSWER, and that is a judgement about size rather
 * than an oversight. A rep's phone holds tens to a few hundred chats, each row
 * here is a name and eight scalars, and the page needs the WHOLE list to group
 * it and to search it server-side. Paging it would mean a cursor on a list the
 * rep is choosing from — recorded on #117 if a directory ever arrives that is
 * large enough to matter.
 */
export async function readChatDirectory(
  deps: DirectoryReadDeps,
): Promise<TwinDirectory> {
  const rows = await deps.db.query<{
    id: string;
    kind: ChatKind;
    name_enc: Buffer | null;
    last_activity_at: Date | null;
    in_scope: boolean;
    fill_pages: number;
    fill_oldest_at: Date | null;
    fill_end_of_transfer: string | null;
    fill_last_at: Date | null;
    fill_stopped_by: string | null;
  }>(
    `SELECT d.id, d.kind, d.name_enc, d.last_activity_at,
            d.fill_pages, d.fill_oldest_at, d.fill_end_of_transfer,
            d.fill_last_at, d.fill_stopped_by,
            EXISTS (
              SELECT 1 FROM scope_allowlist a
               WHERE a.twin_id = d.twin_id
                 AND (a.chat_jid = d.chat_jid OR a.chat_jid = d.lid_jid)
            ) AS in_scope
       FROM chat_directory d
      WHERE d.twin_id = $1
        AND d.kind = ANY($2::text[])
      ORDER BY d.last_activity_at DESC NULLS LAST, d.id`,
    [deps.twinId, LISTED_KINDS],
  );
  return {
    chats: rows.rows.map((row): TwinDirectoryChat => ({
      id: row.id,
      kind: row.kind,
      // OPENED HERE, WHICH IS THE WHOLE REASON THIS FUNCTION EXISTS. `null` is
      // an absence the plane recorded and not an empty name, and the page has
      // chrome for it — so a chat nobody has a name for is still switchable
      // without a phone number ever standing in for one.
      name:
        row.name_enc === null
          ? null
          : Buffer.from(deps.dek.decrypt(row.name_enc)).toString("utf8"),
      lastActivityAt:
        row.last_activity_at === null
          ? null
          : row.last_activity_at.toISOString(),
      inScope: row.in_scope,
      fill: {
        pages: row.fill_pages,
        oldestAt:
          row.fill_oldest_at === null ? null : row.fill_oldest_at.toISOString(),
        endOfTransfer: row.fill_end_of_transfer,
        lastAt: row.fill_last_at === null ? null : row.fill_last_at.toISOString(),
        // HOW THE LAST ATTEMPT ENDED, so Inicio's card can NAME the chats it
        // is talking about (ticket #255, F39): the names are sealed and rep-web
        // holds no key, so the only read that can pair a stop word with a name
        // is this one.
        stoppedBy: row.fill_stopped_by,
      },
    })),
  };
}

/** One directory row of THIS twin, as a scope act resolves it. */
export interface DirectoryChatOfTwin {
  readonly id: string;
  readonly chatJid: string;
  /**
   * The chat's OTHER identity, when the plane has learned one.
   *
   * A MODERN DM HAS TWO SPELLINGS and the guard resolves the pair, so an act
   * that named only one of them could leave the other allowed
   * (`scopeChatOut` argues the consequence). It is answered here rather than
   * looked up there because the row is the one place both live.
   */
  readonly lidJid: string | null;
}

/**
 * The chat a directory row names, under this twin — or nothing.
 *
 * THE TWIN IS THE FENCE AND IT IS IN THE PREDICATE. A row id naming another
 * twin's chat answers no row, so the act is refused before the allowlist, the
 * request row or the chain entry is touched — the same shape `resolveAct`
 * has for a card one module over.
 */
export async function chatOfDirectoryRow(
  deps: { readonly db: pg.ClientBase; readonly twinId: string },
  directoryId: string,
): Promise<DirectoryChatOfTwin | undefined> {
  const rows = await deps.db.query<{
    id: string;
    chat_jid: string;
    lid_jid: string | null;
  }>(
    `SELECT id, chat_jid, lid_jid FROM chat_directory
      WHERE id = $1 AND twin_id = $2`,
    [directoryId, deps.twinId],
  );
  const row = rows.rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, chatJid: row.chat_jid, lidJid: row.lid_jid };
}
