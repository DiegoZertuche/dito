/**
 * THE HELPER'S OWN SUITE — the live failure of 2026-09-04, replayed (#133).
 *
 * WHAT HAPPENED. `./rig-owner.sh` died at startup with `28P01 password
 * authentication failed for user "dito_owner"`, and `pg_authid` showed the
 * role held no password at all. Roles are CLUSTER-GLOBAL while databases are
 * not, so a ticket lane running its integration suites against its own
 * database in the shared server reaches straight into the live rig's login.
 * Eight owner-side suites set a test password on `dito_owner` and put the
 * role's own credential back afterwards; every one of them carried its own
 * copy of that beforeAll/afterAll pair, and a copy that restores `PASSWORD
 * NULL` logs the rig's owner web out until `rig-seed-owner.ts` is run again.
 *
 * WHAT THIS FILE PINS, and it is the whole of the helper's contract: the
 * verifier the role had when a suite arrived is the verifier it has when the
 * suite leaves — byte for byte, because `ALTER ROLE … PASSWORD` stores an
 * already-hashed `SCRAM-SHA-256$…` string verbatim — and a role that had NO
 * password gets none back. Read as a specification: a suite borrows the
 * owner's credential and gives it back exactly as found.
 *
 * THE SEAM IS POSTGRES ITSELF. There is no observing this from inside the
 * process: the claim is about a row in `pg_authid` and about whether a
 * connection authenticates, so both are read over real connections as the
 * schema owner (ADR-0028: real Postgres, migrations by the pinned Atlas).
 *
 * AND THIS FILE IS ITSELF A GOOD CITIZEN OF THE SHARED CLUSTER. It moves the
 * role's password around on purpose, so it reads the credential it found
 * before the first case and puts that back after the last one — in raw SQL
 * rather than through the helper, because a suite that used the thing under
 * test to protect the rig would prove nothing when the thing under test was
 * broken.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAndMigrate, withClient, withRoleClient } from "./db.js";
import { borrowOwnerPassword, OWNER_TEST_PASSWORD } from "./owner-password.js";

/**
 * Named here rather than imported from `@dito/aperture`'s `grants.ts`: the
 * seam package sits BELOW the aperture, and the one string is what the
 * helper takes as an argument precisely so this package never learns the
 * owner side's vocabulary.
 */
const OWNER_ROLE = "dito_owner";

/** A stand-in for the rig's own credential — what `.env.rig` carries. */
const A_RIGS_PASSWORD = "not-the-suite-password";

/** The role's stored verifier, or null when it has no password at all. */
async function storedVerifier(): Promise<string | null> {
  return withClient(async (client) => {
    const found = await client.query<{ rolpassword: string | null }>(
      "SELECT rolpassword FROM pg_authid WHERE rolname = $1",
      [OWNER_ROLE],
    );
    return found.rows[0]?.rolpassword ?? null;
  });
}

/**
 * Sets the role's password. A plaintext argument is hashed by the server; an
 * already-hashed verifier is stored as-is, which is the property the whole
 * fix rests on and the reason one function serves both callers here.
 */
async function alterOwnerPassword(value: string | null): Promise<void> {
  await withClient((client) =>
    client.query(
      value === null
        ? `ALTER ROLE ${OWNER_ROLE} PASSWORD NULL`
        : `ALTER ROLE ${OWNER_ROLE} PASSWORD '${value.replaceAll("'", "''")}'`,
    ),
  );
}

/**
 * Whatever this cluster's `dito_owner` held before the file ran — WRAPPED,
 * so that "not read yet" and "read, and there was no password" stay two
 * different facts. A bare `string | null` here would be the very sentinel
 * this file exists to condemn: `resetAndMigrate()` can throw with the server
 * up (a migration that fails), vitest runs `afterAll` anyway, and the
 * teardown would then null a role it had never read.
 */
let found: { readonly verifier: string | null } | null = null;

beforeAll(async () => {
  await resetAndMigrate();
  found = { verifier: await storedVerifier() };
});

afterAll(async () => {
  if (found !== null) {
    await alterOwnerPassword(found.verifier);
  }
});

describe("borrowOwnerPassword (the owner role's credential survives a suite, #133)", () => {
  it("gives the suite a working login and puts the role's own verifier back, byte for byte", async () => {
    await alterOwnerPassword(A_RIGS_PASSWORD);
    const theRigs = await storedVerifier();
    expect(theRigs).toMatch(/^SCRAM-SHA-256\$/);

    const borrowed = await borrowOwnerPassword(OWNER_ROLE);
    // The suite's own credential authenticates while it holds it — which is
    // what the eight suites take the password for in the first place.
    const reached = await withRoleClient(
      OWNER_ROLE,
      OWNER_TEST_PASSWORD,
      async (client) => (await client.query("SELECT 1 AS ok")).rows[0]!.ok,
    );
    expect(reached).toBe(1);

    await borrowed.restore();
    expect(await storedVerifier()).toBe(theRigs);
  });

  it("gives NO password back when it found none — the role as the migration creates it", async () => {
    await alterOwnerPassword(null);

    const borrowed = await borrowOwnerPassword(OWNER_ROLE);
    expect(await storedVerifier()).not.toBeNull();

    await borrowed.restore();
    expect(await storedVerifier()).toBeNull();
  });

  it("refuses a role that is not there, rather than reading it as passwordless", async () => {
    // THE CONFLATION THAT MADE THE LIVE FAILURE POSSIBLE. "No row in
    // `pg_authid`" and "a row with no password" are different facts, and a
    // helper that answered null to both would set a password on nothing and
    // then null a role it never read. It refuses before it writes anything.
    await alterOwnerPassword(A_RIGS_PASSWORD);
    const theRigs = await storedVerifier();

    await expect(borrowOwnerPassword("dito_owner_absent")).rejects.toThrow(
      /dito_owner_absent/,
    );
    expect(await storedVerifier()).toBe(theRigs);
  });
});
