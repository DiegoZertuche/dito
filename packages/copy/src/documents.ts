/**
 * THE LEGAL DOCUMENTS, VERSIONED (ticket #219 AC 1; spec #214 decision 6 and
 * user story 12; ADR-0011's immutable versions).
 *
 * A rep acknowledges the contract and the ban-risk disclosure on link day,
 * and the acknowledgment row names a seat, a document, a VERSION and an
 * instant. So a version has to be a thing that exists and cannot move: "I
 * want every acknowledgment to record exactly which version of the text I
 * read, so that nobody can later claim I agreed to different words".
 *
 * A PUBLISHED VERSION IS IMMUTABLE, AND THE DIGEST IS HALF THE MECHANISM.
 * Every entry pins the sha-256 of its own text and `documents.test.ts`
 * recomputes it, so editing a text and leaving its digest behind is a red
 * build. The runtime half is a freeze: an entry a page renders cannot be
 * rewritten in place, so the text a rep read and the version their
 * acknowledgment cites are the same words within one deployment.
 *
 * WHAT THE DIGEST DOES NOT CATCH, said plainly rather than left implied
 * (Codex r1): an author who edits the text AND re-runs the digest publishes
 * different words under an existing version number, and every assertion here
 * still passes. Nothing local can refuse that — the digest sits beside the
 * text it describes, so the two always agree after an edit. Two things close
 * it and BOTH NOW EXIST: `scripts/copy-versions-check.mjs` compares every
 * published (key, version, digest) triple against the merge base, and
 * `acknowledgments.digest` stores the sha-256 the rep was actually shown
 * (ticket #223), so a changed text is detectable from the record a rep's
 * consent lives in and not only from history.
 *
 * EVERY TEXT BELOW IS A MARKED PLACEHOLDER, and that is the state of the
 * slice rather than a shortcut: the legal words come from Diego or counsel
 * before the slice-6a boundary (spec #214 decision 6), and whether a
 * click-wrap acknowledgment is a sufficient e-signature for the contract is
 * counsel's own question (Dito-Core/dito#16). #219's three placeholders said
 * "words pending"; #223 published version 2 of the summary and the ban-risk
 * disclosure as real drafts — still `placeholder`, because Diego has not
 * approved them — so link day's pages can be read as a rep will read them.
 * `contract_text` stays at version 1, because a legal text is counsel's alone.
 */
import { CopyError } from "./template.js";

/** The three documents link day shows, in the order it shows them. */
export const DOCUMENT_KEYS = [
  "contract_summary",
  "contract_text",
  "ban_risk_disclosure",
] as const;

export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

/**
 * Whether the words are the ones that will stand.
 *
 * `placeholder` IS A PUBLISHED VERSION ALL THE SAME. It is frozen, digested
 * and citable — the status says whose words they are, not whether the
 * version is real. A page may want to say so; nothing may pretend the
 * version is absent.
 */
export type DocumentStatus = "placeholder" | "final";

/** One published version of one document. */
export interface DocumentEntry {
  readonly key: DocumentKey;
  /** 1-based and contiguous per key: version N is the Nth text published. */
  readonly version: number;
  readonly status: DocumentStatus;
  readonly text: string;
  /** sha-256 of `text`, hex — what makes the version immutable (see the header). */
  readonly digest: string;
}

/** The texts as written, before the freeze `DOCUMENTS` hands out. */
const PUBLISHED: readonly DocumentEntry[] = [
  {
    key: "contract_summary",
    version: 1,
    status: "placeholder",
    text:
      "Resumen del contrato — texto pendiente. Estas palabras son un " +
      "marcador: el resumen en lenguaje claro del contrato entre tú y " +
      "Dito lo escribe Diego o el equipo legal antes del cierre de esta " +
      "rebanada. Existe como versión 1 para que la página y tu registro " +
      "de aceptación citen una versión que de verdad existe; cuando " +
      "lleguen las palabras definitivas serán la versión 2.",
    digest:
      "59b9e8466c1e17535623008a53d2e619def6fc4c40c12b033d82e3036c2a4b80",
  },
  {
    key: "contract_text",
    version: 1,
    status: "placeholder",
    text:
      "Contrato — texto pendiente. Estas palabras son un marcador: el " +
      "texto legal del contrato entre tú y Dito lo redacta el equipo " +
      "legal antes del cierre de esta rebanada, y el empleador no es " +
      "parte de él. Existe como versión 1 para que la página y tu " +
      "registro de aceptación citen una versión que de verdad existe; " +
      "cuando lleguen las palabras definitivas serán la versión 2.",
    digest:
      "c6f9cea3399aaefe1bb4fe5884162a49c152a654e61778a2e0ff25b9eb352f4b",
  },
  {
    key: "ban_risk_disclosure",
    version: 1,
    status: "placeholder",
    text:
      "Aviso de riesgo — texto pendiente. Estas palabras son un marcador: " +
      "el aviso que explica el riesgo de que WhatsApp suspenda tu número " +
      "lo redacta Diego con el equipo legal antes del cierre de esta " +
      "rebanada. Existe como versión 1 para que la página y tu registro " +
      "de aceptación citen una versión que de verdad existe; cuando " +
      "lleguen las palabras definitivas serán la versión 2.",
    digest:
      "a7c9449024176193c3253c798522d535fc3ef82bfe632006e2d3e7f712f36d2c",
  },
  // ─────────────────────────────────────────────────────────────────────
  // VERSION 2 OF TWO OF THE THREE (ticket #223).
  //
  // APPENDED, NEVER EDITED IN PLACE, which is what "a new text is a new
  // version" means in a file: version 1 of all three is byte-identical to
  // what #219 published, so `copy-versions-check.mjs` compares the tree
  // against the merge base and finds nothing moved. A version 1 row a rep
  // acknowledged on a rig still names words that exist.
  //
  // STILL `placeholder`, AND THAT IS THE POINT rather than an oversight.
  // These are the ORCHESTRATOR's drafts — real words in place of a marker
  // that said "words pending", so link day's pages can be read and reviewed
  // as a rep will read them — and Diego has not approved them. Counsel's are
  // a later version, and `documents.test.ts` asserts every shipped text
  // carries this status precisely so that promoting one to `final` is a
  // decision somebody takes rather than an edit nobody sees.
  //
  // `contract_text` STAYS AT VERSION 1, deliberately: the legal text is
  // counsel's alone, and a placeholder written by anybody else in its place
  // would read as a contract on the page a rep accepts a contract on. The
  // contract page therefore renders a real summary above a marked
  // placeholder, which is the honest state of the ticket.
  //
  // THE TEXTS ARE PLAIN TEXT AND NOT MARKDOWN. The drafts were written with
  // `#` titles, `**bold**` and `-` bullets; a page that rendered those would
  // need a markdown parser inside the wall, and a digest over marked-up
  // source would pin the markup rather than the words. So each heading became
  // the paragraph's own lead line, the bold markers are gone, blocks are
  // separated by a blank line, and the page splits on that (`DocumentText`).
  //
  // ONE CLAUSE READS DIFFERENTLY FROM THE TICKET'S DRAFT, and the deviation is
  // recorded there: «sin tu «Enviar» en el panel o tu «va» en tu propio chat»
  // names the thread's KEYWORD, which ADR-0037 as amended rules an artifact of
  // a medium that gives the twin no buttons — it retires on the dashboard, and
  // `rep-web.int.test.ts` sweeps every served byte for it. A legal text that
  // named it would pin consent to a grammar the product is retiring, so the
  // clause states the substance instead («nothing reaches a customer without
  // your approval»).
  {
    key: "contract_summary",
    version: 2,
    status: "placeholder",
    text:
      "Dito es un asistente que trabaja dentro de tu WhatsApp " +
      "Business como un dispositivo vinculado, igual que WhatsApp " +
      "Web.\n" +
      "\n" +
      "Qué hace Dito\n" +
      "- Lee únicamente los chats que tú marques en «Conexiones». Los " +
      "demás chats no se leen ni se guardan.\n" +
      "- De los chats marcados, guarda los últimos noventa días y lo " +
      "que llegue después, para redactar con contexto.\n" +
      "- Redacta borradores de respuesta y te los muestra a ti. Nunca " +
      "envía un mensaje a un cliente sin que tú lo apruebes, ni desde " +
      "el panel ni desde tu propio chat.\n" +
      "- Al final del día te muestra un resumen de los datos que " +
      "anotó; puedes retirar cualquier línea durante veinticuatro " +
      "horas.\n" +
      "\n" +
      "Qué no hace Dito\n" +
      "- No lee chats que no marcaste. No escribe a nadie por su " +
      "cuenta. No comparte tus conversaciones con otras empresas ni " +
      "las usa para entrenar modelos.\n" +
      "\n" +
      "Tus datos\n" +
      "- Los mensajes se guardan cifrados con una llave propia de tu " +
      "cuenta. Si la empresa da de baja tu asiento, la llave se " +
      "destruye y lo guardado queda ilegible.\n" +
      "- Puedes desmarcar un chat cuando quieras; a partir de ese " +
      "momento Dito deja de leerlo.\n" +
      "\n" +
      "Tu parte\n" +
      "- La cuenta de WhatsApp Business que vinculas es la de tu " +
      "trabajo y tienes permiso de tu empresa para usarla con Dito.\n" +
      "- Cada mensaje que apruebas lo envías tú: Dito solo lo " +
      "redacta.\n",
    digest:
      "1291b634eee2b0c13c37384aaca478e2a216c5c300ef4836545bb434a3b4af82",
  },
  // VERSION 3 DESCRIBES DITO IN THE PRODUCT'S OWN WORDS (ticket #368; the
  // glossary, whose `_Avoid_` list names «asistente»): a
  // colleague who works inside the rep's WhatsApp. The rest of the text is
  // version 2's; still a placeholder, pending counsel (Dito-Core/dito#16).
  {
    key: "contract_summary",
    version: 3,
    status: "placeholder",
    text:
      "Dito es un colega que trabaja dentro de tu WhatsApp " +
      "Business como un dispositivo vinculado, igual que WhatsApp " +
      "Web.\n" +
      "\n" +
      "Qué hace Dito\n" +
      "- Lee únicamente los chats que tú marques en «Conexiones». Los " +
      "demás chats no se leen ni se guardan.\n" +
      "- De los chats marcados, guarda los últimos noventa días y lo " +
      "que llegue después, para redactar con contexto.\n" +
      "- Redacta borradores de respuesta y te los muestra a ti. Nunca " +
      "envía un mensaje a un cliente sin que tú lo apruebes, ni desde " +
      "el panel ni desde tu propio chat.\n" +
      "- Al final del día te muestra un resumen de los datos que " +
      "anotó; puedes retirar cualquier línea durante veinticuatro " +
      "horas.\n" +
      "\n" +
      "Qué no hace Dito\n" +
      "- No lee chats que no marcaste. No escribe a nadie por su " +
      "cuenta. No comparte tus conversaciones con otras empresas ni " +
      "las usa para entrenar modelos.\n" +
      "\n" +
      "Tus datos\n" +
      "- Los mensajes se guardan cifrados con una llave propia de tu " +
      "cuenta. Si la empresa da de baja tu asiento, la llave se " +
      "destruye y lo guardado queda ilegible.\n" +
      "- Puedes desmarcar un chat cuando quieras; a partir de ese " +
      "momento Dito deja de leerlo.\n" +
      "\n" +
      "Tu parte\n" +
      "- La cuenta de WhatsApp Business que vinculas es la de tu " +
      "trabajo y tienes permiso de tu empresa para usarla con Dito.\n" +
      "- Cada mensaje que apruebas lo envías tú: Dito solo lo " +
      "redacta.\n",
    digest:
      "112481e5ff35753bcedcf23710bdd022cbc7d12a885fa7ff9fb0837fdafdb1f6",
  },
  {
    key: "ban_risk_disclosure",
    version: 2,
    status: "placeholder",
    text:
      "WhatsApp puede bloquear el número.\n" +
      "\n" +
      "Dito se conecta a tu WhatsApp Business como un dispositivo " +
      "vinculado, no a través de la API oficial de Meta. Las " +
      "condiciones de WhatsApp no permiten automatizar una cuenta de " +
      "esta manera, y Meta puede suspender o bloquear el número que " +
      "vincules, con o sin aviso. Si eso pasa, el número puede perder " +
      "el acceso a WhatsApp Business por días o de forma permanente. " +
      "Si Meta bloquea el número, Dito no puede recuperarlo y no " +
      "promete hacerlo: la decisión es de Meta y nadie la puede " +
      "forzar.\n" +
      "\n" +
      "Cómo reduce Dito ese riesgo\n" +
      "- Nunca envía un mensaje que tú no aprobaste, uno por uno.\n" +
      "- Envía con pausa entre mensajes y con un máximo por hora.\n" +
      "- Solo escribe a clientes con los que ya hay una conversación " +
      "abierta; no manda mensajes masivos ni a números nuevos.\n" +
      "- No usa tu cuenta para nada más que redactar y enviar lo que " +
      "tú aprobaste.\n" +
      "\n" +
      "Lo que te pedimos\n" +
      "- Vincula un número de trabajo cuya pérdida temporal la " +
      "empresa pueda absorber; no vincules tu número personal.\n" +
      "- Si WhatsApp te muestra una advertencia sobre la cuenta, " +
      "avísanos antes de seguir enviando.\n",
    digest:
      "a7e154859fa03d7aa3f7377943f33c8853148b7f21343b701ca1b3b32c2fa55a",
  },
];

/**
 * The record: every published version of every document, key by key, in
 * version order.
 *
 * FROZEN AT IMPORT, entries and array both. See the header: the freeze is
 * the runtime half of "a published version is immutable", and it is done
 * here rather than trusted to `readonly`, which erases at compile time.
 */
export const DOCUMENTS: readonly DocumentEntry[] = Object.freeze(
  PUBLISHED.map((entry) => Object.freeze(entry)),
);

/** Every published version of one document, in version order. */
export function documentVersions(key: DocumentKey): readonly DocumentEntry[] {
  return DOCUMENTS.filter((entry) => entry.key === key);
}

/**
 * One named version, or a refusal.
 *
 * NEVER THE NEAREST TEXT. A page asking for words nobody published, or an
 * acknowledgment citing a version that does not exist, is a bug that has to
 * surface where it happens: falling back to the latest would show a rep one
 * text while their row named another.
 */
export function documentVersion(
  key: DocumentKey,
  version: number,
): DocumentEntry {
  const found = DOCUMENTS.find(
    (entry) => entry.key === key && entry.version === version,
  );
  if (found === undefined) {
    throw new CopyError(`no version ${version} of the document \`${key}\``);
  }
  return found;
}

/** The newest published version of one document — what a page shows today. */
export function latestDocumentVersion(key: DocumentKey): DocumentEntry {
  const versions = documentVersions(key);
  const latest = versions[versions.length - 1];
  if (latest === undefined) {
    throw new CopyError(`no published version of the document \`${key}\``);
  }
  return latest;
}
