/**
 * THE VERSIONED DOCUMENTS, and the proof a published version cannot change
 * (ticket #219 AC 1; spec #214 decision 6 and user story 12; ADR-0011).
 *
 * "I want every acknowledgment to record exactly which version of the text
 * I read, so that nobody can later claim I agreed to different words"
 * (user story 12). An acknowledgment stores a key and a number; that pair
 * is only worth storing if the words behind it are fixed — so the entry
 * carries the digest of its own text and this suite recomputes it.
 *
 * THE DIGEST IS COMPUTED HERE AND NOT IN THE PACKAGE, deliberately. A
 * package that hashed its own texts at import would agree with itself
 * forever; the pinned literal beside the text is what a reviewer sees move
 * in a diff, and this suite is what refuses the edit that did not move it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
import {
  CopyError,
  DOCUMENTS,
  DOCUMENT_KEYS,
  documentVersion,
  documentVersions,
  latestDocumentVersion,
} from "./index.js";

/** sha-256 of a document's text, hex — what a pinned `digest` claims. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("the legal documents are versioned entries (ticket #219 AC 1)", () => {
  it("carries all three documents link day acknowledges", () => {
    expect([...DOCUMENT_KEYS]).toEqual([
      "contract_summary",
      "contract_text",
      "ban_risk_disclosure",
    ]);
    for (const key of DOCUMENT_KEYS) {
      expect(documentVersions(key).length).toBeGreaterThan(0);
    }
  });

  it("pins every published version's text by digest, so an edit is a new version", () => {
    for (const entry of DOCUMENTS) {
      expect(entry.digest, `${entry.key} v${entry.version}`).toBe(
        digestOf(entry.text),
      );
    }
  });

  it("numbers versions from one, contiguously, per key", () => {
    // A monotonically numbered version per key is what an acknowledgment
    // row cites, so a gap or a repeat would make one row's `version`
    // ambiguous about which words were on the page.
    for (const key of DOCUMENT_KEYS) {
      expect(documentVersions(key).map((entry) => entry.version)).toEqual(
        documentVersions(key).map((_entry, at) => at + 1),
      );
    }
  });

  it("hands back the latest version of a document, and a named one", () => {
    for (const key of DOCUMENT_KEYS) {
      const versions = documentVersions(key);
      const latest = versions[versions.length - 1]!;
      expect(latestDocumentVersion(key)).toEqual(latest);
      expect(documentVersion(key, latest.version)).toEqual(latest);
    }
  });

  it("refuses a version that does not exist, rather than falling back", () => {
    // A page asked for words that were never published, or an
    // acknowledgment cites a version nobody wrote: both are a refusal, not
    // the nearest text.
    expect(() => documentVersion("contract_text", 99)).toThrow(CopyError);
  });

  it("holds every published version frozen, so nothing rewrites the words a rep read", () => {
    for (const entry of DOCUMENTS) {
      expect(Object.isFrozen(entry), `${entry.key} v${entry.version}`).toBe(true);
      expect(() => {
        // @ts-expect-error — the point of the test is the runtime refusal.
        entry.text = "otro texto";
      }).toThrow(TypeError);
    }
    expect(Object.isFrozen(DOCUMENTS)).toBe(true);
  });

  it("refuses a version whose words changed, against a baseline (Codex r2)", () => {
    // THE ENFORCEMENT the digest cannot give. `scripts/copy-versions-check.
    // mjs` compares the published (key, version, digest) triples against the
    // branch's merge base, so an author who edits a text AND re-runs its
    // digest is a red build rather than a silent re-publication. Driven
    // through the script with a PLANTED baseline, which is the seam
    // `--against` exists for: a suite cannot conjure a second revision into
    // git.
    const dir = mkdtempSync(path.join(tmpdir(), "dito-copy-versions-"));
    try {
      const source = readFileSync(
        path.join(REPO, "packages/copy/src/documents.ts"),
        "utf8",
      );
      // A baseline that published v1 of the contract with OTHER words: the
      // digest is a real sha-256 of a text nobody in the tree holds.
      const other = createHash("sha256").update("otras palabras", "utf8").digest("hex");
      const rewritten = source.replace(
        /(key: "contract_text",[\s\S]*?digest:\s*\n?\s*")[0-9a-f]{64}/u,
        `$1${other}`,
      );
      expect(rewritten).not.toBe(source);
      const baseline = path.join(dir, "documents.ts");
      writeFileSync(baseline, rewritten, "utf8");

      const run = spawnSync(
        process.execPath,
        [
          path.join(REPO, "scripts/copy-versions-check.mjs"),
          `--against=${baseline}`,
        ],
        { encoding: "utf8" },
      );
      expect(run.status).toBe(1);
      expect(`${run.stdout}${run.stderr}`).toContain("contract_text v1");

      // ...and green against a baseline that published exactly what the tree
      // does, so the refusal above is about the change and not the script.
      writeFileSync(baseline, source, "utf8");
      const clean = spawnSync(
        process.execPath,
        [
          path.join(REPO, "scripts/copy-versions-check.mjs"),
          `--against=${baseline}`,
        ],
        { encoding: "utf8" },
      );
      expect(clean.status, `${clean.stdout}${clean.stderr}`).toBe(0);

      // ...AND A BASE THE CLONE CANNOT SEE IS NOT GREEN. CI clones at depth
      // 1 and hands a sha that is all zeros on a first push, so the failure
      // this guards is the gate passing for ever over history it never
      // read (ADR-0028 doctrine).
      const blind = spawnSync(
        process.execPath,
        [
          path.join(REPO, "scripts/copy-versions-check.mjs"),
          "--base=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ],
        { encoding: "utf8" },
      );
      expect(blind.status).toBe(1);
      expect(`${blind.stdout}${blind.stderr}`).toContain("INCONCLUSIVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still names what the digest alone cannot catch (Codex r1)", () => {
    // AN AUTHOR WHO EDITS BOTH publishes different words under an existing
    // version number and every assertion above still passes: the digest
    // sits beside the text it describes, so the two always agree after an
    // edit. Demonstrated rather than asserted about, so the limit is a
    // thing a reader can see rather than a sentence they have to trust.
    const republished = {
      key: "contract_text" as const,
      version: 1,
      status: "placeholder" as const,
      text: "Otras palabras enteramente.",
      digest: digestOf("Otras palabras enteramente."),
    };
    expect(republished.digest).toBe(digestOf(republished.text));
    expect(republished.version).toBe(documentVersion("contract_text", 1).version);
    // What closes it is a merge-base comparison and an acknowledgment row
    // that stores the digest it was shown (`acknowledgments`, ticket #223).
    // Both exist now, and neither is this package's: one is a script CI runs
    // and the other is a column rep-web writes.
  });

  it("describes Dito in the product's own words in every latest version: a colleague, never «asistente» (ticket #368)", () => {
    // The glossary lists «asistente» under `_Avoid_`. An older
    // version keeps its words — a published version is immutable, and an
    // acknowledgment may cite it — so the rule holds for what a page shows.
    for (const key of DOCUMENT_KEYS) {
      const latest = latestDocumentVersion(key);
      expect(latest.text.toLowerCase(), `${key} v${String(latest.version)}`).not.toContain("asistente");
    }
    expect(latestDocumentVersion("contract_summary").version).toBe(3);
    expect(latestDocumentVersion("contract_summary").text).toMatch(/^Dito es un colega que trabaja dentro de tu WhatsApp/u);
  });

  it("marks every text a placeholder until counsel supplies the words", () => {
    // The legal words come from Diego or counsel before the boundary (spec
    // #214 decision 6; whether a click-wrap acknowledgment suffices is
    // Dito-Core/dito#16). When they arrive they are a NEW version, and this
    // assertion is what makes that a decision somebody takes rather than an
    // edit nobody sees.
    for (const entry of DOCUMENTS) {
      expect(entry.status, `${entry.key} v${entry.version}`).toBe("placeholder");
    }
  });
});
