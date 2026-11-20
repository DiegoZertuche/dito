/**
 * WHICH MODEL EACH MODEL-ROUTED RUNG RUNS ON (tickets #148 and #154).
 *
 * Two rungs of ADR-0015's ladder are routed by configuration today —
 * extraction, and the entity-kind classification — and they live in one
 * file BESIDE each other rather than in one config: what #148 learned the
 * hard way is that deriving the second from the first moves it silently.
 * Adjacent constants make the reader see two rungs; a shared config would
 * make them one.
 *
 * Three call sites read `DITO_EXTRACTION_MODEL` — the eval lane and two
 * rig scripts — and before #148 each of them carried its own
 * `?? "claude-haiku-4-5"`. Moving the rung meant editing literals that
 * have to agree, which is the shape of change that eventually leaves one
 * behind; and the effort knob would have been a second such literal beside
 * every one of them, with its own validation or none. (It was FOUR sites
 * until `rig-entity-kind.ts` left the set — #148 took it off a variable
 * named for a rung it does not run on.)
 *
 * So the default and the parsing live here, once, and the callers pass in
 * what their environment said.
 *
 * IT TAKES THE STRINGS RATHER THAN READING THEM. This package's `src`
 * reads no environment variable anywhere — a runtime the rig runs should
 * not change behaviour because of a variable set in somebody's shell — and
 * the callers that DO read the environment are the scripts, where every
 * other such read already is. Pure function, two strings in, one config
 * out, and it is unit-testable without touching `process.env`.
 *
 * A BAD EFFORT THROWS RATHER THAN FALLING BACK. `DITO_EXTRACTION_EFFORT=lo`
 * that quietly ran the default arm would report one arm's number under
 * another arm's name, which is the only way a three-arm measurement can
 * lie about which arm it measured. Unset is not bad input: it means no
 * `output_config` is sent at all and the model applies its own default,
 * which on Sonnet 5 is adaptive thinking and is a real arm.
 */
import { EFFORTS } from "@dito/execution";
import type { ModelCallConfig, ModelEffort } from "./model-config.js";

/**
 * The stop reasons that mean the provider CUT THE RUN rather than the model
 * choosing to stop: the output ceiling, and the context window. Both
 * harnesses check `stop_reason === "tool_use"` positively (a run that
 * submitted ended by calling the tool, nothing else is reachable on the
 * success path); this list only decides the WORDING of the refusal — ran
 * out of room, versus did not answer — because #148 is the record of what
 * conflating the two costs (a budget failure read as a model failure).
 * Found on the entity-kind rung by Codex (#154 r1) and applied to
 * extraction in the same PR: the guard there was `=== "max_tokens"` alone,
 * so a response carrying a complete-looking `submit_extracted_facts`
 * under `model_context_window_exceeded` would have filed a day the
 * provider had marked truncated.
 */
export const TRUNCATION_STOP_REASONS: readonly string[] = [
  "max_tokens",
  "model_context_window_exceeded",
];

/**
 * THE EXTRACTION RUNG (ADR-0015 as amended by #148).
 *
 * Haiku 4.5 until 2026-09-02. The weekday dates three live sessions filed
 * wrong (#57, #69, #102) were reproduced as Haiku 4.5's own arithmetic on
 * a calendar the harness had rendered correctly — #139 captured the turn
 * verbatim to establish that — and prose could not fix arithmetic. The
 * ladder's routine/high-stakes axis had asked about volume, where
 * extraction is plainly routine, rather than about difficulty, where a
 * date is the one field no downstream gate can catch.
 */
export const DEFAULT_EXTRACTION_MODEL = "claude-sonnet-5";

/**
 * THE ENTITY-KIND RUNG (ADR-0015 as amended by #148 and #154).
 *
 * Haiku 4.5 until 2026-09-02, and it stayed there for one ticket longer
 * than extraction did — not because anything measured it worse on Sonnet
 * 5, but because the kind harness (deleted at #176, when the
 * classification became an automation) still carried the three limits
 * #148 removed from extraction: `max_tokens` 256, three runner iterations,
 * and a second submission refused by counting the model's calls. Sonnet 5
 * thinks adaptively by default and would have spent 256 tokens before
 * saying anything, so a first-time binding would have got no kind at all
 * — through the live consumer path, where a failed determination
 * fail-stops the consumer and leaves the rep's confirmed entity unfiled.
 *
 * #154 gave that harness those three fixes, so the reason to hold the rung
 * back is gone. There is no measurement behind the move and none was
 * asked for: it is one two-valued question, and the owner's ruling was to
 * move it rather than to price it.
 *
 * IT IS STILL ITS OWN RUNG, and that is the part #148 got right and this
 * ticket keeps. It does not read `DITO_EXTRACTION_MODEL` and it is not
 * derived from the extraction config — a variable named for one call site
 * must not silently re-point another, and the two rungs now happening to
 * name the same model is not the same thing as them being one setting.
 */
export const DEFAULT_ENTITY_KIND_MODEL = "claude-sonnet-5";

/**
 * The entity-kind call's config, from what the caller's environment said.
 *
 * THE OVERRIDE IS BACK (ticket #154). #148 removed it — «a knob whose
 * documented safe range is one value is not a knob» — because setting
 * `DITO_ENTITY_KIND_MODEL` to Sonnet 5 would then have routed adaptive
 * thinking into a 256-token harness and fail-stopped the consumer on a
 * rep's next binding. That was a statement about the harness, not about
 * the knob, and the harness can take it now: 16,000 tokens of room and a
 * runner that stops after the first determination.
 *
 * NO EFFORT KNOB BESIDE IT, unlike extraction's. `output_config.effort` is
 * honoured at the extraction call site and only there (see
 * `ModelCallConfig`), and #154 measures nothing — an unread parameter
 * accepted here would report a knob this rung does not have.
 */
export function entityKindModelConfig(input: {
  readonly model?: string | undefined;
}): ModelCallConfig {
  return { model: input.model ?? DEFAULT_ENTITY_KIND_MODEL };
}

/** Thrown for an effort string that is not a level — never for an unset one. */
export class ExtractionConfigError extends Error {
  override readonly name = "ExtractionConfigError";
}

/**
 * The extraction call's config, from what the caller's environment said.
 *
 * `model` unset is the rung's default; `effort` unset is the model's own.
 */
export function extractionModelConfig(input: {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): ModelCallConfig {
  const model = input.model ?? DEFAULT_EXTRACTION_MODEL;
  if (input.effort === undefined) return { model };
  if (!EFFORTS.includes(input.effort as ModelEffort)) {
    throw new ExtractionConfigError(
      `extraction effort must be one of ${EFFORTS.join(", ")}, or unset for the model's own default — got "${input.effort}"`,
    );
  }
  return { model, effort: input.effort as ModelEffort };
}
