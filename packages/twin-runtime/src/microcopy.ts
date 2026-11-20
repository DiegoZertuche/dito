/**
 * Twin-thread microcopy (ticket #25): the plain es-MX strings the twin
 * posts about the loop itself. Hardcoded this slice by adjudication (#6 —
 * the copy catalog is deferred; it must exist before Rep dashboard & link
 * day ships real product copy). Refusal REASONS travel the seam and the
 * audit chain; copy is rendered only here, in the twin (ADR-0017: the
 * plane stays dumb — it posts what the notice row says).
 */
import type { RetractionRefusal } from "@dito/aperture";
import type { MatcherRefusalReason } from "./matcher.js";

/**
 * Why the rep's correction retracted nothing (ticket #54; MOVED HERE at
 * #174). Total, and the rep is told which one it was — a correction that
 * silently did nothing reads exactly like one that worked, on the one
 * surface the slice's trust claim rests on.
 *
 * The APERTURE's own refusals ride in unchanged rather than being restated
 * (`not_a_fact`, `window_closed`): they are decided on the far side of the
 * wall and merely rendered on this one, so a reason added there reaches the
 * rep through the record below's typecheck rather than through somebody
 * remembering. What this type adds is the one refusal the aperture never
 * sees:
 *
 * `unknown_line` — the number names no line in that post. Resolved
 *   rep-side, in code, so the walk stops before the aperture. Still a
 *   REFUSED REP ACT, so it is audit-chained like the others (spec #48
 *   decision 18) — with `retract_disclosure_line` as its caller, because
 *   the tool is what refused it.
 *
 * IT LIVES BESIDE THE COPY NOW, AND THAT IS WHY IT MOVED. It was the
 * matcher's type while the matcher was what refused a correction; #174
 * deletes that path — the rep names the line in prose and
 * `retract_disclosure_line` resolves it — so the type's one remaining
 * anchor is the total record it keys, which is here.
 */
export type CorrectionRefusalReason = RetractionRefusal | "unknown_line";

/**
 * What the rep reads when an affirmation cannot mint. Total over the
 * writer's refusal reasons plus the matcher's own: a new reason fails
 * the typecheck here rather than falling back to silence.
 */
export const REFUSAL_MICROCOPY: Readonly<Record<MatcherRefusalReason, string>> = {
  /** ADR-0006: late losers get «ya se envió». */
  already_tapped: "ya se envió",
  no_valid_tap: "no se pudo enviar este borrador",
  off_allowlist: "no se puede enviar a este chat",
  pacing: "no se envió: el ritmo de envíos está al límite, intenta en un momento",
  pacing_unconfigured: "no se envió: el envío no está configurado para este número",
  send_in_flight: "no se envió: hay un envío en camino, espera la confirmación",
  unresolved_draft: "no se pudo enviar: no encontré el borrador de ese mensaje",
  /** Ticket #30: a «va» on a terminally dismissed draft (grilling decision 1). */
  dismissed: "no se envió: este borrador ya fue descartado",
  /**
   * Ticket #342: a «va» on a draft with a blank still open — a fact only the
   * rep has, which the twin asked for on the dashboard.
   */
  blank_open: "este borrador tiene un dato pendiente: dáselo a Dito y queda listo para mandar",
};

/**
 * What the rep reads when a correction retracts nothing (ticket #54; spec
 * #48 grilling decision 14). Total over the correction's own refusal reasons,
 * for the same reason the record above is total over the writer's: a new
 * reason fails the typecheck here rather than falling back to silence.
 *
 * A SEPARATE RECORD, not three more rows in `REFUSAL_MICROCOPY`. That one
 * answers "why couldn't the twin send this?" and every line of it is about
 * a send; a correction is not a send, and folding the two would leave the
 * next reader unable to tell which surface a reason belongs to. Both are
 * total; neither is general.
 *
 * The voice is «Descartado»'s — one line, no ceremony, no apology, and no
 * promise about when the thing it refused might become possible.
 */
export const CORRECTION_REFUSAL_MICROCOPY: Readonly<
  Record<CorrectionRefusalReason, string>
> = {
  /** The rep named a line the post the rep quoted never showed. */
  unknown_line: "no encontré ese dato en este mensaje",
  /**
   * The line disclosed an entity create, and no rep act undoes one yet. It
   * says «todavía» because that is true — the verb is deferred, not
   * refused — and it promises no date, because none is decided.
   */
  not_a_fact: "eso todavía no se puede corregir",
  /** The 24h correction window closed (ADR-0004) and the fact is final. */
  window_closed: "ese dato ya quedó firme y ya no se puede corregir",
};

// The confirmation copy moved to the grammar module with ticket #30
// (renderSendConfirmation): every twin post renders through the one
// grammar point, and the confirmation now names the counterparty from the
// drafted inbound's push-name (falling back to the number).
