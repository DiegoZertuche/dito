/**
 * THE REGISTRIES: tools and context recipes by name (ticket #178; spec #171
 * decisions 9, 30 and 31; ADR-0014 as amended).
 *
 * A definition names its parts; a registry is what the names mean — tools by
 * name with their gate and a factory that binds the execution's dependencies,
 * context recipes by name with their parameter shape and a renderer. Every
 * part a written definition can reference is a STRING resolved against code
 * this repository wrote, so the worst a confused one can do is name something
 * that does not exist, which is a refusal: it cannot author a tool, change a
 * gate or widen a projection.
 *
 * A REGISTRY IS A VALUE, NEVER A MODULE-LEVEL GLOBAL. The two apps hold
 * different registries — the owner web's three reads, the rep runtime's tools
 * over the bundle — and a module-level registry in this shared package would
 * put every rep-side tool within reach of the owner twin, on the wrong side of
 * the wall.
 */
import type { ParameterShape } from "./automation.js";
import type { NamedPart } from "./definition.js";
import type { Gate, ToolDeclaration } from "./tool.js";

/**
 * One registered tool: its gate, and the factory that builds it for one
 * execution. The gate is written beside the factory so the registry reads as
 * the list of what each tool Dito authored may do.
 */
export interface ToolRegistration<Deps> {
  readonly gate: Gate;
  /** Binds this execution's dependencies and occasion at creation. */
  readonly create: (deps: Deps) => ToolDeclaration;
}

/** Tool name → registration. A plain value, held by the owning app. */
export type ToolRegistry<Deps> = Readonly<Record<string, ToolRegistration<Deps>>>;

/**
 * What an occasion may bind into a recipe.
 *
 * THREE KINDS, MATCHING `PARAMETER_TYPES`, and no object among them: a
 * context recipe renders text from values the occasion knows, and a
 * parameter rich enough to be an object would be content travelling under
 * the name of a parameter.
 */
export type ParameterValue = Date | string | number;

/** One recipe's bound values, by parameter name. */
export type RecipeParameters = Readonly<Record<string, ParameterValue>>;

/** Renders one named part from the values its occasion bound. */
export type RecipeRenderer = (values: RecipeParameters) => NamedPart;

/**
 * A recipe's scalar parameter shape and dependency-bound renderer (#172).
 * Content such as transcripts and retrieved memories comes from deps, not
 * the scalar `ParameterValue` channel; a dependency-free recipe ignores its
 * argument.
 *
 * `instructionsDigest` covers the recipe name and parameter shape, never
 * bound values or deps: different transcripts must not change one
 * definition's stamp.
 */
export interface RecipeRegistration<Deps> {
  readonly parameters: ParameterShape;
  /** Binds this execution's dependencies and occasion at creation. */
  readonly create: (deps: Deps) => RecipeRenderer;
}

/**
 * Recipe name → registration.
 *
 * GENERIC IN `Deps`, and `STANDARD_RECIPES` is typed over `unknown` — which
 * is assignable into any app's registry, because a factory that ignores its
 * argument accepts every argument. That is what keeps the runtime's `now`
 * shippable as one frozen value both apps spread.
 */
export type RecipeRegistry<Deps> = Readonly<
  Record<string, RecipeRegistration<Deps>>
>;
