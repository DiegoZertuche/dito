/**
 * FR-73's shared-Postgres half (ticket #50): the registry of rep-side
 * stores that are NOT bundle-resident, checked against the live catalog in
 * both directions — and the recorded exception that admits the aperture's
 * plaintext disclosure lines without opening a hole for anything else.
 *
 * No KMS here on purpose: this half needs only a database, so it runs in
 * every lane rather than only where AWS credentials exist. The planted
 * violations are the FR-70 doctrine — an invariant nobody has seen fail is
 * a comment.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditSharedPostgresStores,
  SHARED_POSTGRES_STORES,
} from "./fr73-shared-stores.js";
import { resetAndMigrate, withClient } from "./testing/db.js";

beforeAll(async () => {
  await resetAndMigrate();
});

describe("FR-73's shared-Postgres store registry", () => {
  it("is green over the migrated schema, and every live store is declared with its custody", async () => {
    await withClient(async (db) => {
      const report = await auditSharedPostgresStores(db);
      expect(report.violations).toEqual([]);
      expect(report.declared.length).toBe(SHARED_POSTGRES_STORES.length);
    });
  });

  it("admits the disclosure lines as the one recorded exception, and makes it argue for itself", async () => {
    await withClient(async (db) => {
      const report = await auditSharedPostgresStores(db);
      // Exactly one store holds rep-facing content in the clear, and it is
      // the one ADR-0003 opened deliberately.
      expect(report.exceptions).toEqual(["public.disclosure_lines"]);
      const exception = SHARED_POSTGRES_STORES.find(
        (s) => s.table === "disclosure_lines",
      );
      expect(exception?.justification).toMatch(/lease/i);
      expect(exception?.justification).toMatch(/ADR-0009/);
    });
  });

  it("fails on a NEW rep-side store nobody declared — being off the exception list is not a way past the audit", async () => {
    await withClient(async (db) => {
      await db.query(
        "CREATE TABLE rep_scratchpad (id uuid PRIMARY KEY, note text NOT NULL)",
      );
      try {
        const red = await auditSharedPostgresStores(db);
        expect(red.violations).toContainEqual({
          subject: "store:public.rep_scratchpad",
          reason:
            "a shared-Postgres store nobody declared — every rep-side store outside the bundle enters FR-73's enumeration with its custody, and an undeclared one is exactly the store this audit exists to catch (FR-73)",
        });
      } finally {
        await db.query("DROP TABLE rep_scratchpad");
      }
      expect((await auditSharedPostgresStores(db)).violations).toEqual([]);
    });
  });

  it("fails on a store hidden in a schema of its own — a new schema is not a way past it either", async () => {
    await withClient(async (db) => {
      await db.query("CREATE SCHEMA rep_side_cache");
      await db.query(
        "CREATE TABLE rep_side_cache.summaries (id uuid PRIMARY KEY, text text NOT NULL)",
      );
      try {
        const red = await auditSharedPostgresStores(db);
        expect(
          red.violations.map((v) => v.subject),
        ).toContain("store:rep_side_cache.summaries");
      } finally {
        await db.query("DROP SCHEMA rep_side_cache CASCADE");
      }
      expect((await auditSharedPostgresStores(db)).violations).toEqual([]);
    });
  });

  it("fails when the registry drifts ahead of the schema", async () => {
    await withClient(async (db) => {
      // A RENAME RATHER THAN A DROP AND A HAND-WRITTEN RESTORE (ticket
      // #218). The audit is indifferent to HOW a declared store leaves the
      // catalog, and every survivor here has constraints, defaults and a
      // comment a test would have to retype — which is the hazard: a
      // hand-written copy of a growing table's DDL lies about the schema
      // sooner or later. A rename carries all of it out and puts all of it
      // back, so this leaves the corpus exactly as it found it. The store
      // that carried this case was `question_posts`, a leaf simple enough to
      // retype, and it is retired with the candidate-question route.
      const away = "disclosure_attempts_gone_for_this_test";
      await db.query(`ALTER TABLE disclosure_attempts RENAME TO ${away}`);
      try {
        const red = await auditSharedPostgresStores(db);
        expect(red.violations).toContainEqual({
          subject: "store:public.disclosure_attempts",
          reason:
            "declared in the registry but absent from the database — a registry that has drifted from the schema proves nothing about the schema",
        });
      } finally {
        await db.query(
          `ALTER TABLE ${away} RENAME TO disclosure_attempts`,
        );
      }
      expect((await auditSharedPostgresStores(db)).violations).toEqual([]);
    });
  });

  it("leaves the Ledger out of frame — it is company-owned, not a rep-side store", async () => {
    await withClient(async (db) => {
      const report = await auditSharedPostgresStores(db);
      expect(report.declared.some((s) => s.startsWith("ledger."))).toBe(false);
      expect(report.violations).toEqual([]);
    });
  });
});
