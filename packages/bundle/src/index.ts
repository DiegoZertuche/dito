/**
 * @dito/bundle — the per-twin encrypted bundle (ADR-0007, ADR-0029).
 *
 * A real SQLCipher file (4.x on-disk format) that opens only under the
 * twin's DEK, stamped with a schema version, forward-only-migrated at open,
 * holding conversation rows this slice. The crypto path is never mocked in
 * tests (ADR-0028).
 */

export {
  createBundle,
  openBundle,
  type AutomationContent,
  type Bundle,
  type ChatBinding,
  type ConversationRow,
  type CustomerReference,
  type IngestResult,
  type NotepadVersion,
  type NotepadWrite,
  type PushNameRow,
  type OpenMatter,
  type OpenMatterSubject,
  type ScoredMessage,
  type SearchOptions,
  type ThreadItem,
  type ThreadItemQuery,
  type ThreadItemRole,
  type UnembeddedMessage,
  type VectorWriteResult,
  type WorkingMemoryVersion,
  type WorkingMemoryWrite,
  type WorkspaceDocument,
  type WorkspaceVersion,
} from "./bundle.js";
export { inDeliveryOrder, type DeliveryBeat } from "./delivery-order.js";
export {
  foldOpaqueDeliveries,
  type OpaqueFoldBeat,
} from "./opaque-fold.js";
export {
  BundleAlreadyExistsError,
  BundleKeyUnavailableError,
  BundleSchemaTooNewError,
  BundleUninitializedError,
  ChatAlreadyBoundError,
  MessageNotInStoreError,
  VectorDimensionMismatchError,
  WrongBundleKeyError,
} from "./errors.js";
export { createTwinBundle, openTwinBundle } from "./twin-bundle.js";
export {
  generateFixtureBundle,
  readSeedTranscript,
  type SeedTranscript,
} from "./fixtures/generate.js";
export {
  AUTOMATION_SENTENCE_CAP,
  BUNDLE_MIGRATIONS,
  BUNDLE_SCHEMA_VERSION,
  MESSAGE_VECTOR_DIMS,
  NOTEPAD_CAP,
  notepadLength,
  OPEN_MATTER_LABEL_CAP,
  WORKING_MEMORY_CAP,
  WORKING_MEMORY_MATTERS_CAP,
  type BundleMigration,
} from "./migrations.js";
