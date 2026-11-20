/**
 * A BUNDLE THAT ANSWERS THE ONE READ EVERY REP-SIDE TURN MAKES (ticket #260).
 *
 * TWIN MEMORY STOPPED BEING OPTIONAL when the notepad became a context recipe:
 * a drafting turn and a thread turn both render what the rep has taught, so a
 * unit fixture that refused every bundle call would refuse the prompt itself.
 *
 * ONE HOME FOR BOTH AUTOMATIONS, because the version literal below is the same
 * value whichever turn is being rendered and two copies of it are two things
 * to keep in step. The exception it opens is exactly one method wide: a suite
 * that searches, reads a binding or names a customer still has to say so by
 * handing in a bundle of its own.
 */
import type { Bundle, NotepadVersion, WorkingMemoryVersion } from "@dito/bundle";

/** The provenance every fixture version carries — opaque ids, never content. */
const FIXTURE_VERSION: Omit<NotepadVersion, "text"> = {
  version: 1,
  writtenAt: "2026-09-04T17:30:00.000Z",
  executionId: "33333333-3333-4333-8333-333333333333",
  evidenceRef: "22222222-2222-4222-8222-222222222222",
};

/**
 * One bundle whose `readNotepad` answers `notepad` — or `undefined`, for a rep
 * who has taught nothing — whose `readWorkingMemory` answers `workingMemory`
 * (ticket #322: every rep-facing turn renders it beside the notepad), and
 * whose every other method throws.
 */
export function notepadBundle(
  notepad?: string,
  workingMemory?: Pick<WorkingMemoryVersion, "text" | "matters">,
): Bundle {
  const refusing = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("this suite does not use twin memory");
      },
    },
  ) as Bundle;
  return new Proxy(refusing, {
    get: (target, property, receiver: unknown) =>
      property === "readNotepad"
        ? () =>
            notepad === undefined ? undefined : { ...FIXTURE_VERSION, text: notepad }
        : property === "readWorkingMemory"
          ? (): WorkingMemoryVersion | undefined =>
              workingMemory === undefined
                ? undefined
                : {
                    version: FIXTURE_VERSION.version,
                    writtenAt: FIXTURE_VERSION.writtenAt,
                    executionId: FIXTURE_VERSION.executionId,
                    ...workingMemory,
                  }
          : Reflect.get(target, property, receiver),
  }) as Bundle;
}
