/**
 * @dito/copy — every rep-facing string of the dashboard, keyed (ticket #219;
 * spec #214 decision 13; ADR-0037 as amended).
 *
 * One locale, es-MX. No framework, no runtime negotiation, no fallback
 * chain: the product has one language, and an i18n framework was rejected
 * rather than deferred (spec #214, *Rejected, not horizon*).
 *
 * Three families, and the difference between them is who owns the words:
 *
 *   `chrome`     — labels and page copy. UI chrome, which ADR-0037's
 *                  amendments exempt by name: the rule binds what a twin
 *                  SAYS, and a dashboard is legitimately a form.
 *   `documents`  — the legal texts a rep acknowledges, each VERSIONED, a
 *                  published version immutable. An acknowledgment names a
 *                  version, so the version has to be a thing that exists.
 *   `templates`  — notify's messages, each declaring its slots' types. The
 *                  renderer refuses an incomplete or mistyped slot set.
 *
 * THE PACKAGE EXPORTS THE ENTRIES, A RENDERER, AND THE WORDS FOR WHEN A
 * RUTINA RUNS (`rutina-when.ts`, ticket #387: the runtime's proposal card and
 * Rutinas say them alike, so they are rendered here once). It holds
 * no database connection, no key, no clock and no policy: what to send and
 * to whom is @dito/notify's, and what to show is rep-web's. That is what
 * lets the CI check (`scripts/copy-check.mjs`) be a rule about one direction
 * — strings move OUT of the surfaces and into here.
 */

export { BAR_PLAYBACK, CHROME, type ChromeKey } from "./chrome.js";
export {
  DOCUMENTS,
  DOCUMENT_KEYS,
  documentVersion,
  documentVersions,
  latestDocumentVersion,
  type DocumentEntry,
  type DocumentKey,
  type DocumentStatus,
} from "./documents.js";
export {
  checkTemplate,
  CopyError,
  renderTemplate,
  type CopyTemplate,
  type RenderedCopy,
  type RenderOptions,
  type SlotValues,
} from "./template.js";
export {
  FREE_FORM_SLOT_TYPES,
  SLOT_TYPES,
  type SlotType,
  type SlotValue,
} from "./slots.js";
export { TEMPLATES, type TemplateKey } from "./templates.js";
export { whenRutinaRuns, type RutinaWhen } from "./rutina-when.js";
