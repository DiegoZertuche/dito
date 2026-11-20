/**
 * WHERE A TWIN'S HARNESS LIVES: beside its bundle (spec #318 decision 3;
 * ticket #328).
 *
 * The Claude Agent SDK child every execution spawns needs a directory of its
 * own — its config, its working directory, its home — and that directory is
 * one twin's alone, so it is named after the twin's bundle and sits next to
 * it: `twin-<id>.bundle` has `twin-<id>.harness`. The name is derived, never
 * configured, for the reason the bundle path is: one rule read by the
 * runtime that writes it and by the FR-73 audit that finds it.
 *
 * IT IS THE RECORDED GAP, AND FR-73 SAYS SO. The directory holds the CLI's
 * own files, the conversation files of the twin thread's days and of each
 * workflow run, each run's content sealed under the twin's key
 * (`runs/content.ts`), and the twin's workspace — the working files its file
 * tools write, whose every version is sealed in the bundle (`workspace.ts`) —
 * and it sits in the twin's data dir until the per-twin
 * volume replaces it (spec #318 decision 3). The audit names it in every report with the ruling
 * that admits it, rather than counting it as a violation or passing over it
 * in silence.
 */

const BUNDLE_SUFFIX = ".bundle";
const HARNESS_SUFFIX = ".harness";

/** The harness directory beside one bundle path. */
export function harnessDirectoryBeside(bundlePath: string): string {
  if (!bundlePath.endsWith(BUNDLE_SUFFIX)) {
    throw new Error(
      `a twin's bundle path ends in ${BUNDLE_SUFFIX}, and this one does not: ${bundlePath}`,
    );
  }
  return `${bundlePath.slice(0, -BUNDLE_SUFFIX.length)}${HARNESS_SUFFIX}`;
}

/**
 * The bundle file name a data-dir entry is the harness directory of, or
 * `undefined` when the entry is not named as one.
 */
export function bundleOfHarnessDirectory(entry: string): string | undefined {
  return entry.endsWith(HARNESS_SUFFIX)
    ? `${entry.slice(0, -HARNESS_SUFFIX.length)}${BUNDLE_SUFFIX}`
    : undefined;
}

/** The ruling FR-73 prints beside every harness directory it finds. */
export const HARNESS_DIRECTORY_RULING =
  "the per-twin harness directory: the SDK child's config and the twin's workspace directory (work/, its working files; each version sealed in the bundle), beside the bundle in the clear as the recorded gap until the per-twin volume (spec #318 decisions 3 and 35, #286)";
