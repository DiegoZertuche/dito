/**
 * The scripted model wire, from `@dito/scripted-model` (ticket #128).
 *
 * It USED to live here, and could not stay: every package's `src/testing`
 * is excluded from its build, so `packages/execution` — which may not
 * depend on this package at all — had no way to reach it. The wire moved
 * to a dev-only workspace package both take as a devDependency, and this
 * file stays as the re-export so none of this package's suites moved. Same
 * shape as `packages/audit/src/testing/db.ts`: one wire, no copy to
 * drift.
 */
export {
  closeScriptedModels,
  disclosureTurns,
  entityKindTurns,
  extractionTurns,
  latestPromptOf,
  promptOf,
  qaSilenceTurns,
  scriptedModel,
  systemOf,
  toolNamesOf,
  toolResultsOf,
  transcriptOf,
  type DisclosureScript,
  type Script,
  type ScriptedModel,
  type ScriptedTurn,
  type ScriptedUsage,
  type TranscriptEntry,
} from "@dito/scripted-model";
