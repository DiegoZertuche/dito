/**
 * FR-73 skeleton (ticket #31, spec #29 decision 13): the enumeration audit
 * proving every rep-side store is bundle-resident under exactly that
 * twin's one KMS key — verified, not asserted. Real Postgres, real KMS,
 * real SQLCipher (ADR-0028); the fixture twin key is reused, never minted.
 *
 * The audit's two halves, both under test here:
 *  - the enumeration: the bundle's stores, read from the live schema
 *    through the bundle API (new stores join by construction);
 *  - the converse sweep: nothing store-shaped may exist OUTSIDE the
 *    bundle in the twin's data dir — a planted out-of-bundle store must
 *    fail the audit (the FR-70 planted-violation doctrine).
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KMSClient } from "@aws-sdk/client-kms";
import { sessionFile } from "@dito/execution";
import { beforeAll, describe, expect, it } from "vitest";
import { auditFr73WithKmsIdentity } from "./fr73.js";
import { harnessDirectoryBeside } from "./harness-directory.js";
import {
  openTwinMemoryWithKmsIdentity,
  provisionTwinWithKmsIdentity,
} from "./provision.js";
import { resetAndMigrate, withClient } from "./testing/db.js";
import { useTmpDirs } from "./testing/tmp.js";

const skip = process.env["DITO_SKIP_KMS_TESTS"] === "1";

/** The one reused fixture twin key: alias/dito-dev/twin-test-fixture. */
const FIXTURE_TWIN_ID = "test-fixture";

const tmpDir = useTmpDirs("dito-fr73-int-");

beforeAll(async () => {
  await resetAndMigrate();
});

/** Provisions a real twin (fixture KMS key) into its own data dir. */
async function provisionedTwin(db: import("pg").Client, kms: KMSClient) {
  const twinId = randomUUID();
  const dataDir = tmpDir();
  const bundlePath = join(dataDir, `twin-${twinId}.bundle`);
  await provisionTwinWithKmsIdentity({
    kms,
    db,
    twinId,
    bundlePath,
    kmsTwinId: FIXTURE_TWIN_ID,
  });
  return { twinId, dataDir, bundlePath };
}

describe.skipIf(skip)("FR-73 store-enumeration audit (real KMS + real SQLCipher)", () => {
  const kms = new KMSClient({});

  it("a provisioned twin audits green: every enumerated store is bundle-resident under the twin's one key", async () => {
    await withClient(async (client) => {
      const twin = await provisionedTwin(client, kms);
      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });

      expect(report.violations).toEqual([]);
      // The enumeration comes from the live bundle schema — the slice-2
      // interior is all there, and a store added by a later migration
      // (#32's) joins with no audit change.
      expect(report.stores).toContain("conversation_messages");
      expect(report.stores).toContain("entity_mirror");
      expect(report.stores).toContain("message_vectors");
      // THE REP'S NOTEBOOK (ticket #260; spec #258; ADR-0033 as amended) is a
      // bundle TABLE, so it is under the twin's one key by construction:
      // `report.violations` being empty is precisely the claim that each
      // enumerated store is bundle-resident under that one key. THE NOTEPAD
      // IS THE ONE THE REP WROTE THEMSELVES, which is why the sweep has to
      // see it by name: it never crosses the wall, never migrates to a new
      // seat and is never exported (ADR-0033).
      expect(report.stores).toContain("notepad_versions");
      // THE FOCUS RETIRED (ticket #321; spec #318 decision 16) and the
      // customers' stable references took its place in the count: one store
      // out, one in.
      expect(report.stores).not.toContain("focus");
      expect(report.stores).toContain("customer_references");
      // THE TENTH (ticket #320): the twin thread's own items, which its
      // search reads — a bundle table like the rest, under the one key.
      expect(report.stores).toContain("thread_items");
      // THE ELEVENTH (ticket #322): the twin's working memory — its own notes
      // and open matters, a bundle table under the one key like the notepad
      // beside it, never crossing the wall.
      expect(report.stores).toContain("working_memory_versions");
      // THE TWELFTH (ticket #325): the rutinas' content — each automation the
      // twin authored, its workflow definition and its sentence — a bundle
      // table under the one key; the seam holds only its metadata row.
      expect(report.stores).toContain("automation_definitions");
      // THE THIRTEENTH (ticket #326): the workspace's versions — each
      // snapshot of a document the twin wrote, immutable, under the one key;
      // the working files themselves are the harness directory's gap.
      expect(report.stores).toContain("workspace_versions");
      // The stamped version, pinned as a literal rather than read from the
      // constant this build ships: the claim is that a bundle provisioned
      // NOW carries the schema this build says it does, and comparing the
      // constant to itself would assert nothing. It moves when the schema
      // does — v9 carries the rep notepad (ticket #260), the third version to
      // add a STORE rather than a column, which is why that ticket moves the
      // count; v10 the thread's own items (ticket #320); v11 drops the focus
      // and adds the customers' references (ticket #321); v12 the twin's
      // working memory (ticket #322); v13 the rutinas' content (ticket #325);
      // v14 the workspace's versions (ticket #326).
      expect(report.schemaVersion).toBe(14);
    });
  });

  it("a planted out-of-bundle store fails the audit — a plaintext SQLite file beside the bundle is a violation", async () => {
    await withClient(async (client) => {
      const twin = await provisionedTwin(client, kms);
      // The planted violation: rep content in a plaintext store OUTSIDE
      // the bundle (what FR-73 exists to catch).
      const planted = join(twin.dataDir, "notes-cache.db");
      const rogue = new DatabaseSync(planted);
      rogue.exec(
        "CREATE TABLE cached_messages (chat TEXT, content TEXT); INSERT INTO cached_messages VALUES ('x', 'plaintext rep content')",
      );
      rogue.close();

      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      expect(
        report.violations.some((v) => v.subject === `file:${planted}`),
      ).toBe(true);
    });
  });

  it("ANY unrecognized file in the twin's data dir is a violation — the sweep is an allowlist, not a plaintext sniffer", async () => {
    await withClient(async (client) => {
      const twin = await provisionedTwin(client, kms);
      // Not even SQLite-shaped: a store nobody declared is still a store
      // nobody audited. Only the bundle and its own sidecars may exist.
      const stray = join(twin.dataDir, "timeline.json");
      writeFileSync(stray, JSON.stringify({ chat: "x", said: "y" }));
      mkdirSync(join(twin.dataDir, "workspace-cache"));

      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      const subjects = report.violations.map((v) => v.subject);
      expect(subjects).toContain(`file:${stray}`);
      expect(subjects).toContain(`file:${join(twin.dataDir, "workspace-cache")}`);
    });
  });

  it("the harness directory beside the bundle is reported as the recorded gap, not a violation — and a stray file still is (#328)", async () => {
    await withClient(async (client) => {
      const twin = await provisionedTwin(client, kms);
      // The layout the runtime leaves: the SDK child's directory, named
      // after the bundle, holding the CLI's own config.
      const harness = harnessDirectoryBeside(twin.bundlePath);
      mkdirSync(join(harness, "config"), { recursive: true });
      writeFileSync(join(harness, "config", ".claude.json"), "{}");
      // ...and a document in the twin's workspace (ticket #326).
      mkdirSync(join(harness, "work"), { recursive: true });
      writeFileSync(join(harness, "work", "hoteles.md"), "# Hoteles en Madrid\n");
      // ...and the twin thread's conversation file inside it (ticket #319).
      const conversation = sessionFile(harness, randomUUID());
      mkdirSync(dirname(conversation), { recursive: true });
      writeFileSync(conversation, `${JSON.stringify({ type: "queue-operation" })}\n`);
      // A harness-shaped name with no bundle beside it vouches for nothing.
      const orphan = join(twin.dataDir, `twin-${randomUUID()}.harness`);
      mkdirSync(orphan);
      const stray = join(twin.dataDir, "notes.json");
      writeFileSync(stray, "{}");
      // A harness NAME linked to another twin's directory is not this twin's
      // place (Codex r2): its bundle is present, and it still fails.
      const sibling = await provisionedTwin(client, kms);
      const linkedBundle = join(twin.dataDir, basename(sibling.bundlePath));
      copyFileSync(sibling.bundlePath, linkedBundle);
      const linked = harnessDirectoryBeside(linkedBundle);
      symlinkSync(harness, linked);

      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });

      expect(report.recordedGaps).toEqual([
        { path: harness, ruling: expect.stringContaining("recorded gap") as unknown },
      ]);
      expect(report.recordedGaps[0]?.ruling).toContain("#286");
      // THE WORKSPACE DIRECTORY IS NAMED INSIDE THE GAP (ticket #326): its
      // working files sit in the clear beside the versions the bundle seals.
      expect(report.recordedGaps[0]?.ruling).toContain("workspace directory (work/");
      const subjects = report.violations.map((v) => v.subject);
      expect(subjects).not.toContain(`file:${harness}`);
      expect(subjects).toContain(`file:${orphan}`);
      expect(subjects).toContain(`file:${stray}`);
      expect(subjects).toContain(`file:${linked}`);
    });
  });

  it("a plaintext file at the bundle path is a violation — encrypted at rest is checked, not believed", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const dataDir = tmpDir();
      const bundlePath = join(dataDir, `twin-${twinId}.bundle`);
      // A twin whose "bundle" is plaintext SQLite: custody looks fine
      // (wrapped DEK present) but the file itself betrays the promise.
      const rogue = new DatabaseSync(bundlePath);
      rogue.exec("CREATE TABLE conversation_messages (content TEXT)");
      rogue.close();
      // No provisioning: the twin also has no wrapped DEK — both custody
      // violations must surface.
      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      const subjects = report.violations.map((v) => v.subject);
      expect(subjects).toContain(`bundle:${bundlePath}`);
      expect(subjects).toContain(`twin:${twinId}`);
      expect(report.stores).toEqual([]);
    });
  });

  it("a sibling twin's bundle in a shared data dir is no violation — but a plaintext file wearing a twin-bundle name is", async () => {
    await withClient(async (client) => {
      // The rig's layout: every twin's bundle lives in one rig-data/ dir
      // (rig-run.ts) — another twin's encrypted bundle beside the audited
      // one is legitimate rig state, not an out-of-bundle store.
      const twin = await provisionedTwin(client, kms);
      const sibling = await provisionedTwin(client, kms);
      const siblingBundle = join(twin.dataDir, basename(sibling.bundlePath));
      copyFileSync(sibling.bundlePath, siblingBundle);

      const clean = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      expect(clean.violations).toEqual([]);

      // But the name buys nothing: a plaintext store dressed as a twin
      // bundle still fails — the allowance is for ciphertext only.
      const imposter = join(
        twin.dataDir,
        `twin-${randomUUID()}.bundle`,
      );
      const rogue = new DatabaseSync(imposter);
      rogue.exec("CREATE TABLE cached (content TEXT)");
      rogue.close();
      const caught = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      expect(
        caught.violations.some((v) => v.subject === `file:${imposter}`),
      ).toBe(true);
    });
  });

  it("a companion NAME buys nothing (Codex r1): plaintext rep data in a .dek file, a custody-less sibling bundle, and an orphan sidecar all fail", async () => {
    await withClient(async (client) => {
      const twin = await provisionedTwin(client, kms);

      // Finding 1: rep data dressed as a wrapped-DEK sidecar. A real
      // wrapped DEK is ~200 bytes of KMS ciphertext; this is neither.
      const fakeDek = join(twin.dataDir, `${basename(twin.bundlePath)}.dek`);
      writeFileSync(
        fakeDek,
        JSON.stringify({ chat: "x", history: "plaintext rep content ".repeat(64) }),
      );

      // Finding 2: a sibling "bundle" that is plaintext JSON — no SQLite
      // magic, so a header sniff alone calls it ciphertext. Its uuid has
      // no twin_keys row: no custody chain, no pass.
      const rogueSibling = join(twin.dataDir, `twin-${randomUUID()}.bundle`);
      writeFileSync(rogueSibling, JSON.stringify({ said: "also rep content" }));

      // Association: a sidecar whose parent bundle does not exist.
      const orphanSidecar = join(
        twin.dataDir,
        `twin-${randomUUID()}.bundle-journal`,
      );
      writeFileSync(orphanSidecar, "leftover");

      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: twin.twinId,
        bundlePath: twin.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      const subjects = report.violations.map((v) => v.subject);
      expect(subjects).toContain(`file:${fakeDek}`);
      expect(subjects).toContain(`file:${rogueSibling}`);
      expect(subjects).toContain(`file:${orphanSidecar}`);
    });
  });

  it("a real twin's uuid on a plaintext file buys nothing either (Codex r2): custody rows vouch for twins, not for file contents", async () => {
    await withClient(async (client) => {
      // Twin A is audited; twin B is genuinely provisioned — its real
      // bundle lives in its own dir, its twin_keys row exists.
      const audited = await provisionedTwin(client, kms);
      const other = await provisionedTwin(client, kms);

      // The r2 scenario: plaintext JSON planted in A's dir wearing B's
      // uuid. B's custody row is real, the content is not a bundle — a
      // custody row must never launder a file it does not open.
      const disguised = join(
        audited.dataDir,
        `twin-${other.twinId}.bundle`,
      );
      writeFileSync(
        disguised,
        JSON.stringify({ history: "plaintext rep content ".repeat(40) }),
      );

      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId: audited.twinId,
        bundlePath: audited.bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      expect(
        report.violations.some((v) => v.subject === `file:${disguised}`),
      ).toBe(true);
    });
  });

  it("a twin with no stored wrapped DEK fails the audit — one key per twin means exactly one, not at most one", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath: join(tmpDir(), `twin-${twinId}.bundle`),
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      expect(
        report.violations.some((v) => v.subject === `twin:${twinId}`),
      ).toBe(true);
    });
  });

  it("mints the CI invariant corpus: a provisioned twin left at .tools/fr73-corpus for scripts/fr73-check.mjs", async () => {
    // The FR-70 pattern: the suite mints the corpus, the CI step audits
    // it through the script — so the invariant runs against a real
    // provisioned twin, not a belief. The manifest sits OUTSIDE the swept
    // data dir (it is not twin state).
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    const corpusDir = join(repoRoot, ".tools", "fr73-corpus");
    rmSync(corpusDir, { recursive: true, force: true });
    mkdirSync(corpusDir, { recursive: true });

    await withClient(async (client) => {
      const twinId = randomUUID();
      const bundlePath = join(corpusDir, `twin-${twinId}.bundle`);
      await provisionTwinWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      writeFileSync(
        join(repoRoot, ".tools", "fr73-corpus.json"),
        JSON.stringify({ twinId, kmsTwinId: FIXTURE_TWIN_ID, bundlePath }),
      );
      // THE HARNESS DIRECTORY IN THE CORPUS (ticket #328), so the CI step
      // prints it as the recorded gap — the rig's data dir has one beside
      // every bundle a runtime has run against — WITH A DAY'S SESSION
      // FILE UNDER IT (ticket #319), where the twin thread's session child
      // writes one: the gap is the directory, whatever it holds.
      const harness = harnessDirectoryBeside(bundlePath);
      mkdirSync(join(harness, "config"), { recursive: true });
      const conversation = sessionFile(harness, randomUUID());
      mkdirSync(dirname(conversation), { recursive: true });
      writeFileSync(conversation, `${JSON.stringify({ type: "queue-operation" })}\n`);

      // A REFERENCE ROW IN THE CORPUS (ticket #321). The audit enumerates
      // stores from the live schema, so an EMPTY table would already be
      // counted — but a table nothing ever wrote to is a weaker witness than
      // one that holds a row. Written through the public API under the
      // twin's own DEK, which is the only way in (ADR-0007, ADR-0009).
      const { bundle } = await openTwinMemoryWithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      try {
        bundle.referenceForChat("5215550001@s.whatsapp.net");
      } finally {
        bundle.close();
      }

      const report = await auditFr73WithKmsIdentity({
        kms,
        db: client,
        twinId,
        bundlePath,
        kmsTwinId: FIXTURE_TWIN_ID,
      });
      expect(report.violations).toEqual([]);
    });
  });
});
