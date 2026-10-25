import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  describeOpenClawStateLeaseLossReason,
  renewOpenClawStateLease,
  verifyOpenClawStateLeaseOwnership,
} from "./openclaw-state-lease-storage.js";
import { acquireOpenClawStateLeaseInTransaction } from "./openclaw-state-lease-store.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";

type LeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

const tempTracker = createTempDirTracker();
let database: OpenClawStateDatabase;
let env: Record<string, string>;

const identity = {
  scope: "synthetic",
  key: "diagnostics",
  owner: "original-owner-token",
  leaseLabel: "state lease",
};
const baseTime = 1_000_000;

function resetFixture() {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<LeaseDatabase>(db)
          .deleteFrom("state_leases")
          .where("scope", "=", identity.scope)
          .where("lease_key", "=", identity.key),
      );
      acquireOpenClawStateLeaseInTransaction(db, identity, 10_000, null, baseTime);
    },
    { database, env },
  );
}

beforeAll(() => {
  env = { OPENCLAW_STATE_DIR: tempTracker.make("lease-loss-reason-") };
  database = openOpenClawStateDatabase({ env });
});

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  try {
    tempTracker.cleanup();
  } catch {
    // Bun on Windows releases SQLite file handles upon process termination.
  }
});

beforeEach(() => {
  resetFixture();
});

describe("openclaw state lease loss reason diagnostics (#183154)", () => {
  describe("describeOpenClawStateLeaseLossReason unit tests", () => {
    it("returns missing reason when row is null or undefined", () => {
      expect(describeOpenClawStateLeaseLossReason(null, identity)).toBe("lease record is missing");
      expect(describeOpenClawStateLeaseLossReason(undefined, identity)).toBe("lease record is missing");
    });

    it("returns replaced reason when owner differs", () => {
      const reason = describeOpenClawStateLeaseLossReason(
        { owner: "different-owner", expiresAt: 2_000_000 },
        identity,
      );
      expect(reason).toBe("lease owner was replaced");
      expect(reason).not.toContain("different-owner");
    });

    it("returns expired reason with elapsed time and last heartbeat", () => {
      const reason = describeOpenClawStateLeaseLossReason(
        { owner: identity.owner, expiresAt: 1_000_000, heartbeatAt: 999_000 },
        identity,
        1_001_000,
      );
      expect(reason).toBe("lease expired 1000 ms ago; last heartbeat 2000 ms ago");
    });

    it("returns expired reason without heartbeat if heartbeatAt is absent", () => {
      const reason = describeOpenClawStateLeaseLossReason(
        { owner: identity.owner, expiresAt: 1_000_000, heartbeatAt: null },
        identity,
        1_001_000,
      );
      expect(reason).toBe("lease expired 1000 ms ago");
    });

    it("returns undefined when row cannot safely indicate loss reason", () => {
      const reason = describeOpenClawStateLeaseLossReason(
        { owner: identity.owner, expiresAt: 2_000_000 },
        identity,
        1_000_000,
      );
      expect(reason).toBeUndefined();
    });
  });

  describe("renewOpenClawStateLease", () => {
    it("reports missing lease record when row was deleted", () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .deleteFrom("state_leases")
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      expect(() =>
        renewOpenClawStateLease({
          ...identity,
          database: { scope: "shared", options: { env, database } },
          operationLabel: "state.lease",
          leaseMs: 5_000,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `"state lease synthetic/diagnostics was lost (lease record is missing)"`,
      );
    });

    it("reports owner replacement without exposing the replacement token", () => {
      const replacementToken = "super-secret-replacement-token-98765";
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ owner: replacementToken })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      let caughtError: unknown;
      try {
        renewOpenClawStateLease({
          ...identity,
          database: { scope: "shared", options: { env, database } },
          operationLabel: "state.lease",
          leaseMs: 5_000,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(OpenClawStateLeaseError);
      const leaseError = caughtError as OpenClawStateLeaseError;
      expect(leaseError.code).toBe("OPENCLAW_STATE_LEASE_LOST");
      expect(leaseError.message).toBe("state lease synthetic/diagnostics was lost (lease owner was replaced)");
      expect(leaseError.message).not.toContain(replacementToken);
    });

    it("reports expiry duration and last heartbeat elapsed time", () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ expires_at: 1_000_000, heartbeat_at: 999_000 })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      expect(() =>
        renewOpenClawStateLease({
          ...identity,
          database: { scope: "shared", options: { env, database } },
          operationLabel: "state.lease",
          leaseMs: 5_000,
          nowMs: 1_001_000,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `"state lease synthetic/diagnostics was lost (lease expired 1000 ms ago; last heartbeat 2000 ms ago)"`,
      );
    });

    it("reports expiry duration when last heartbeat is omitted", () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ expires_at: 1_000_000, heartbeat_at: null })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      expect(() =>
        renewOpenClawStateLease({
          ...identity,
          database: { scope: "shared", options: { env, database } },
          operationLabel: "state.lease",
          leaseMs: 5_000,
          nowMs: 1_001_000,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `"state lease synthetic/diagnostics was lost (lease expired 1000 ms ago)"`,
      );
    });
  });

  describe("verifyOpenClawStateLeaseOwnership", () => {
    it("reports missing lease record when row was deleted", () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .deleteFrom("state_leases")
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      expect(() =>
        verifyOpenClawStateLeaseOwnership({
          ...identity,
          database: { scope: "shared", options: { env, database } },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `"state lease synthetic/diagnostics was lost (lease record is missing)"`,
      );
    });

    it("reports owner replacement without exposing the replacement token", () => {
      const replacementToken = "super-secret-replacement-token-112233";
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ owner: replacementToken })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      let caughtError: unknown;
      try {
        verifyOpenClawStateLeaseOwnership({
          ...identity,
          database: { scope: "shared", options: { env, database } },
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(OpenClawStateLeaseError);
      const leaseError = caughtError as OpenClawStateLeaseError;
      expect(leaseError.code).toBe("OPENCLAW_STATE_LEASE_LOST");
      expect(leaseError.message).toBe("state lease synthetic/diagnostics was lost (lease owner was replaced)");
      expect(leaseError.message).not.toContain(replacementToken);
    });

    it("reports expiry duration and last heartbeat elapsed time", () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ expires_at: 1_000_000, heartbeat_at: 999_000 })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      expect(() =>
        verifyOpenClawStateLeaseOwnership({
          ...identity,
          database: { scope: "shared", options: { env, database } },
          nowMs: 1_001_000,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `"state lease synthetic/diagnostics was lost (lease expired 1000 ms ago; last heartbeat 2000 ms ago)"`,
      );
    });

    it("reports expiry duration when last heartbeat is omitted", () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<LeaseDatabase>(db)
              .updateTable("state_leases")
              .set({ expires_at: 1_000_000, heartbeat_at: null })
              .where("scope", "=", identity.scope)
              .where("lease_key", "=", identity.key),
          );
        },
        { database, env },
      );

      expect(() =>
        verifyOpenClawStateLeaseOwnership({
          ...identity,
          database: { scope: "shared", options: { env, database } },
          nowMs: 1_001_000,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `"state lease synthetic/diagnostics was lost (lease expired 1000 ms ago)"`,
      );
    });
  });
});
