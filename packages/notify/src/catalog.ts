/**
 * THE CLOSED CATALOG (ticket #219 AC 3; spec #214 *Notify, in detail* and
 * decision 4; ADR-0022, ADR-0013 class 4).
 *
 * ADR-0022's sentence is the whole of this module: "a closed catalog of
 * named message types, each bound to a fixed template with schema-validated
 * parameters — no free-text parameter exists (CI-checked)". Two messages
 * exist in 6a — the invitation that starts link day and the six-digit login
 * code — and nothing else can be sent, because nothing else can be
 * CONSTRUCTED.
 *
 * IT FAILS AT CONSTRUCTION, NOT AT SEND: a refusal at send would be a
 * refusal in front of a rep who is waiting to log in, and a refusal at
 * import is a red build. `defineCatalog` below lists the six things it
 * refuses and why each one matters.
 *
 * THE NAME IS THE SEAT'S, NEVER THE CALLER'S. Both templates greet the rep,
 * and an entry declares which slots notify fills from the seat it resolved
 * (`seatSlots`). The argument is the address's, one step further: a caller
 * that could type the name could put words into a message it does not
 * otherwise control, and the point of a closed catalog is that a caller
 * chooses the OCCASION and never the text.
 */
import {
  FREE_FORM_SLOT_TYPES,
  TEMPLATES,
  type CopyTemplate,
  type TemplateKey,
} from "@dito/copy";

/** Every refusal this package makes. */
export class NotifyError extends Error {
  override readonly name = "NotifyError";
}

/**
 * The message types Dito can send. The closed set of ADR-0022 as amended.
 *
 * SEVEN, AND THE VOCABULARY IS CUT ONCE (ticket #262; spec #258 decision 7).
 * Two leave by email alone — the invitation that starts link day and the
 * six-digit login code. Three are PUSH ALONE and carry a sentence the twin
 * composed into a post: a draft is ready, a question was asked, and a
 * reminder near an expiry — the knock the twin thread added when a card's
 * reminder fired (ticket #364). Two are GRAVE EVENTS and go both ways, email and push, in
 * code and in the character-silent register: the rail dropped, the rail
 * logged out.
 *
 * A WORD HERE IS A DECISION ON ADR-0022 AND A DROP-and-re-CREATE of
 * `notify_sends_message_type_check` — the one migration shape this repo
 * watches, because a narrowing re-cut refuses the settle of a message that has
 * already gone out.
 *
 * THERE IS NO DIGEST, and its absence is a decision rather than a gap (spec
 * #258 decision 7): a seat with no push subscription receives nothing for a
 * routine wait, and the dashboard is then a pull surface like the twin thread.
 */
export const NOTIFY_MESSAGE_TYPES = [
  "invitation",
  "login_code",
  "draft_ready",
  "question_asked",
  "reminder",
  "rail_dropped",
  "rail_logged_out",
] as const;

export type NotifyMessageType = (typeof NOTIFY_MESSAGE_TYPES)[number];

/**
 * The seat columns a slot may be filled from.
 *
 * ONE, and it is a list because the shape is the point: the day a seat's
 * company name is greeted with, the entry says which column it came from
 * rather than a service reaching for whatever it likes.
 */
export const SEAT_SLOT_SOURCES = ["rep_display_name"] as const;

export type SeatSlotSource = (typeof SEAT_SLOT_SOURCES)[number];

/**
 * WHERE A NOTIFICATION LANDS, AND THEREFORE WHAT ITS SLOTS MAY BE (ticket
 * #262; ADR-0022 as amended).
 *
 * `push` is where the deep link is decided too: a push payload carries a link
 * code appends from the deployment's own dashboard origin, and this word says
 * which page it opens. `card` lands the rep on the post the notification was
 * about; `connections` lands them where they re-link. Neither is a value a
 * caller or a template holds.
 */
export interface PushDelivery {
  readonly template: TemplateKey;
  readonly link: "card" | "connections";
}

/**
 * One message type, bound to the template each transport renders.
 *
 * AT LEAST ONE OF THE TWO, AND OFTEN EXACTLY ONE — `defineCatalog` refuses an
 * entry with neither, because a named message no transport can carry is a
 * caller waiting for a send that can never happen. A grave event declares
 * both: it is the one occasion the product says must reach a rep whether or
 * not they ever allowed notifications (spec #258 decision 7).
 */
export interface CatalogEntry {
  readonly type: NotifyMessageType;
  /** What SES renders, for a type that leaves by email. */
  readonly template?: TemplateKey;
  /** What a browser shows, for a type that leaves by push. */
  readonly push?: PushDelivery;
  /** Slot name → the seat column notify fills it from. A caller may not pass one. */
  readonly seatSlots: Readonly<Record<string, SeatSlotSource>>;
}


/** The catalog: every message type, by name. */
export type NotifyCatalog = Readonly<Record<NotifyMessageType, CatalogEntry>>;

/**
 * The entries, checked — or a refusal.
 *
 * SEVEN REFUSALS, and each one is a way a message could reach a person that
 * nobody decided to send:
 *
 *  1. a type outside the closed set;
 *  2. two entries for one type, where the second would silently win;
 *  3. a template key `@dito/copy` does not hold — on either transport, and
 *     an entry naming no transport at all, which is a message that can never
 *     be carried;
 *  4. a template declaring a FREE-FORM slot — this is where ADR-0022's "no
 *     free-text parameter exists" is enforced, and it is enforced on the
 *     TYPE rather than on the value, so a paragraph has nowhere to arrive;
 *  5. a seat-filled slot the template never declares, which would be a
 *     value nobody renders;
 *  6. a type in the closed set with no entry, so the catalog is complete as
 *     well as closed — a named message with no template is a caller waiting
 *     for a send that can never happen;
 *  7. a `composed` slot on anything but a push type's own push template —
 *     ADR-0022's amendment, and the sentence it keeps true is the first one:
 *     the twin's voice reaches a lock screen and never an inbox.
 *
 * THE SEVENTH IS THE FOURTH'S TWIN AND NOT ITS EXCEPTION. A FREE-FORM slot is
 * a hole a CALLER puts its own words in and is refused everywhere; a COMPOSED
 * slot is a sentence the twin wrote that code read back out of a sealed post
 * row, and it is admitted on exactly one transport of exactly the types that
 * use it. Both are decided on the TYPE, so neither has to be re-decided at a
 * send.
 */
export function defineCatalog(
  entries: readonly CatalogEntry[],
  templates: Readonly<Record<string, CopyTemplate>> = TEMPLATES,
): NotifyCatalog {
  const byType = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    if (!(NOTIFY_MESSAGE_TYPES as readonly string[]).includes(entry.type)) {
      throw new NotifyError(
        `\`${entry.type}\` is not one of the message types Dito sends (${NOTIFY_MESSAGE_TYPES.join(", ")})`,
      );
    }
    if (byType.has(entry.type)) {
      throw new NotifyError(`two catalog entries for \`${entry.type}\``);
    }
    if (entry.template === undefined && entry.push === undefined) {
      throw new NotifyError(
        `\`${entry.type}\` names no template on either transport — a message type nothing can carry is a caller waiting for a send that can never happen`,
      );
    }
    for (const bound of boundTemplates(entry)) {
      const template = templates[bound.key];
      if (template === undefined) {
        throw new NotifyError(
          `\`${entry.type}\` names the template \`${bound.key}\`, which @dito/copy does not hold`,
        );
      }
      for (const [slot, type] of Object.entries(template.slots)) {
        if (FREE_FORM_SLOT_TYPES.includes(type)) {
          throw new NotifyError(
            `\`${entry.type}\` is bound to a template whose slot \`${slot}\` is \`${type}\` — no message type may carry a free-text parameter (ADR-0022)`,
          );
        }
        if (type === COMPOSED_SLOT_TYPE && !bound.pushes) {
          throw new NotifyError(
            `\`${entry.type}\` is bound to an email template whose slot \`${slot}\` is \`${type}\` — a composed sentence reaches a lock screen and never an inbox (ADR-0022 as amended)`,
          );
        }
      }
    }
    // ...AND THE SEAT'S OWN SLOTS ARE THE EMAIL TEMPLATE'S, because a push
    // carries no name at all: a lock screen is already the rep's own, and a
    // notification that greeted them would be the form the knock replaces.
    // So a seat slot on a type that leaves only by push is a value nobody
    // renders, exactly as one no email template declares is.
    const emailSlots =
      entry.template === undefined
        ? {}
        : (templates[entry.template]?.slots ?? {});
    for (const slot of Object.keys(entry.seatSlots)) {
      if (!(slot in emailSlots)) {
        throw new NotifyError(
          `\`${entry.type}\` fills the slot \`${slot}\` from seat state, and its template declares no such slot`,
        );
      }
    }
    // FROZEN ENTRY BY ENTRY, seat slots included (Codex r2). Freezing the
    // outer record alone left `NOTIFY_CATALOG.invitation.seatSlots` writable,
    // and emptying it makes `renderNotification` take a caller's `name` —
    // the seat-owned slot restriction gone, for every send afterwards,
    // because the catalog is shared. A copy is frozen rather than the
    // caller's object, so the array a caller still holds is not a handle on
    // what was published.
    byType.set(
      entry.type,
      Object.freeze({
        type: entry.type,
        ...(entry.template === undefined ? {} : { template: entry.template }),
        ...(entry.push === undefined
          ? {}
          : { push: Object.freeze({ ...entry.push }) }),
        seatSlots: Object.freeze({ ...entry.seatSlots }),
      }),
    );
  }
  for (const type of NOTIFY_MESSAGE_TYPES) {
    if (!byType.has(type)) {
      throw new NotifyError(`the catalog holds no entry for \`${type}\``);
    }
  }
  return Object.freeze(Object.fromEntries(byType)) as NotifyCatalog;
}

/**
 * THE SLOT TYPE THAT MAY ONLY REACH A LOCK SCREEN (ticket #262).
 *
 * NAMED HERE RATHER THAN IMPORTED AS A UNION MEMBER, so the seventh check
 * reads as the rule it is: `@dito/copy` decides what the value may be, and
 * this package decides which message types may declare one at all.
 */
const COMPOSED_SLOT_TYPE = "composed";

/**
 * Every template one entry binds, and whether that binding is the push one.
 *
 * ONE WALK FOR BOTH TRANSPORTS, because every refusal above is about a
 * TEMPLATE and a type may bind two — the grave events do. Without it the
 * free-form rule would have been written twice, and a push template gaining a
 * `text` slot would have slipped past the copy nobody re-checked.
 */
function boundTemplates(
  entry: CatalogEntry,
): readonly { readonly key: TemplateKey; readonly pushes: boolean }[] {
  return [
    ...(entry.template === undefined
      ? []
      : [{ key: entry.template, pushes: false }]),
    ...(entry.push === undefined
      ? []
      : [{ key: entry.push.template, pushes: true }]),
  ];
}

/**
 * The catalog Dito ships.
 *
 * BUILT AT IMPORT, which is what makes every refusal above a build failure
 * rather than a send failure.
 *
 * THE THREE ANNOUNCEMENTS LAND ON THE CARD and the two grave events land in
 * Conexiones, which is the only place a dropped rail can be answered. That is
 * where each type's deep link is decided, once, in the catalog — never by a
 * caller and never by a template.
 */
export const NOTIFY_CATALOG: NotifyCatalog = defineCatalog([
  {
    type: "invitation",
    template: "notify.invitation",
    seatSlots: { name: "rep_display_name" },
  },
  {
    type: "login_code",
    template: "notify.loginCode",
    seatSlots: { name: "rep_display_name" },
  },
  {
    type: "draft_ready",
    push: { template: "notify.push.draftReady", link: "card" },
    seatSlots: {},
  },
  {
    type: "question_asked",
    push: { template: "notify.push.questionAsked", link: "card" },
    seatSlots: {},
  },
  {
    type: "reminder",
    push: { template: "notify.push.reminder", link: "card" },
    seatSlots: {},
  },
  {
    type: "rail_dropped",
    template: "notify.railDropped",
    push: { template: "notify.push.railDropped", link: "connections" },
    seatSlots: { name: "rep_display_name" },
  },
  {
    type: "rail_logged_out",
    template: "notify.railLoggedOut",
    push: { template: "notify.push.railLoggedOut", link: "connections" },
    seatSlots: { name: "rep_display_name" },
  },
]);

/**
 * The slots a CALLER binds: everything the type's templates declare, less the
 * seat's.
 *
 * BOTH TRANSPORTS, because a caller asking «what do I pass» is asking about
 * the TYPE and a type may bind two templates. A slot named on both is one
 * slot, and a `url` on a type that pushes is on neither list: the occasion's
 * destination is the catalog's (`fixedLinkSlots` in `notify.ts`).
 *
 * IT TAKES THE TEMPLATES `defineCatalog` TOOK (the two-axis review's
 * Standards axis). Reading `TEMPLATES` unconditionally made half a seam: a
 * catalog built over fixture templates would have had its caller slots read
 * off the shipped record instead, which is the wrong answer given quietly.
 */
export function callerSlots(
  entry: CatalogEntry,
  templates: Readonly<Record<string, CopyTemplate>> = TEMPLATES,
): readonly string[] {
  const slots = new Set<string>();
  for (const bound of boundTemplates(entry)) {
    const template = templates[bound.key];
    if (template === undefined) {
      throw new NotifyError(
        `\`${entry.type}\` names the template \`${bound.key}\`, which is not in the record it was built from`,
      );
    }
    for (const [slot, type] of Object.entries(template.slots)) {
      // A LINK ON A TYPE THAT ALSO PUSHES IS NOTIFY'S OWN (`fixedLinkSlots`):
      // the occasion has one destination and both transports take it from the
      // catalog, so it is not a slot a caller binds.
      if (type === "url" && entry.push !== undefined) continue;
      slots.add(slot);
    }
  }
  return [...slots].filter((slot) => !(slot in entry.seatSlots));
}
