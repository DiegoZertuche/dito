/**
 * Security configuration of every keyed bundle connection. Asserted at the
 * keying seam (the one place pragmas live) because the property has no
 * other observable surface: SQLite3MultipleCiphers leaves temporary and
 * transient databases UNENCRYPTED, so only temp_store=MEMORY keeps a big
 * sort or index build from spilling twin memory to plaintext temp files
 * outside the bundle (ADR-0007/0008 — plaintext never rests on disk).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDekFromMaterial } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import { openKeyed } from "./keyed-db.js";
import { useTmpDirs } from "./testing/tmp.js";

const tmpDir = useTmpDirs("dito-keyed-db-");

describe("keyed bundle connections (ADR-0007/0008)", () => {
  it("keeps all temporary state in memory — temp files are the one unencrypted surface", () => {
    const db = openKeyed(
      join(tmpDir(), "twin.bundle"),
      createDekFromMaterial(randomBytes(32)),
      { fileMustExist: false },
    );
    try {
      // 2 = MEMORY in SQLite's temp_store enumeration.
      expect(db.pragma("temp_store", { simple: true })).toBe(2);
    } finally {
      db.close();
    }
  });
});
