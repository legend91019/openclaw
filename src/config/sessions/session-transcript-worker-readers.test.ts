import { expect, it } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import {
  createSessionHistoryWorkerReaders,
  type SessionHistoryWorkerRequestRunner,
} from "./session-transcript-worker-readers.js";

/**
 * `captureSessionTranscriptStorageEnvironment` is unit-tested against the
 * environment it produces. These tests cover the layer above it: what the
 * `readExactEntries` reader actually hands to the worker boundary. The worker
 * receives its request through `Worker.postMessage`, which structured-clones the
 * payload, so any value that cannot be cloned (notably the case-insensitive
 * `Proxy` returned by `cloneEnvWithPlatformSemantics` on win32) must be
 * materialized before it reaches `prepare()`.
 *
 * The reader's input and result types are derived from its own signature so these
 * tests keep tracking the shipped reader rather than a hand-copied shape.
 */

type Readers = ReturnType<typeof createSessionHistoryWorkerReaders>;
type ExactEntriesInput = Parameters<Readers["readExactEntries"]>[0];
type ExactEntriesResult = Awaited<ReturnType<Readers["readExactEntries"]>>;
/** The value `prepare()` returns, i.e. exactly what `worker.postMessage` receives. */
type PreparedInput = ReturnType<Parameters<SessionHistoryWorkerRequestRunner>[0]>;

/** Capture what the reader hands to `worker.postMessage`, then clone it the way the worker does. */
function captureBoundary(): {
  prepared: PreparedInput[];
  runRequest: SessionHistoryWorkerRequestRunner;
} {
  const prepared: PreparedInput[] = [];
  const runRequest: SessionHistoryWorkerRequestRunner = async (prepare, _bytes, receive) => {
    const input = prepare();
    prepared.push(input);
    // `Worker.postMessage` structured-clones the prepared input; mirror that here.
    structuredClone(input);
    return receive({
      kind: "session-exact-entries",
      entries: [],
      lifecycleTimestamps: {},
    } as ExactEntriesResult);
  };
  return { prepared, runRequest };
}

const request = (env: NodeJS.ProcessEnv): ExactEntriesInput => ({
  env: cloneEnvWithPlatformSemantics(env),
  sessionKeys: ["agent:main:main"],
});

it.each(["linux", "win32"] as const)(
  "readExactEntries yields a structured-cloneable request on %s",
  async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const { prepared, runRequest } = captureBoundary();
      const readers = createSessionHistoryWorkerReaders(runRequest);

      await expect(
        readers.readExactEntries(
          request({
            OPENCLAW_STATE_DIR: "synthetic-state",
            Path: "synthetic-bin",
          }),
        ),
      ).resolves.toEqual({ kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} });

      // The boundary capture above already cloned the payload; assert it again so
      // the intent is explicit at the assertion site.
      expect(prepared).toHaveLength(1);
      expect(() => structuredClone(prepared[0])).not.toThrow();
      expect(prepared[0].kind).toBe("session-exact-entries");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  },
);

it("readExactEntries transports the resolved storage environment, not the caller environment", async () => {
  const { prepared, runRequest } = captureBoundary();
  const readers = createSessionHistoryWorkerReaders(runRequest);

  await readers.readExactEntries(
    request({
      OPENCLAW_STATE_DIR: "synthetic-state",
      Path: "synthetic-bin",
      // A caller credential must not survive the storage capture.
      GITHUB_TOKEN: "must-not-cross-the-boundary",
    }),
  );

  expect(prepared).toHaveLength(1);
  const captured = prepared[0];
  if (captured?.kind !== "session-exact-entries") {
    throw new Error("Expected an exact-entry request");
  }
  const env = captured.env;
  // The reader forwards the captured storage environment, not the caller's env.
  expect(env).toMatchObject({ OPENCLAW_STATE_DIR: expect.any(String) });
  expect(env).not.toHaveProperty("GITHUB_TOKEN");
  expect(() => structuredClone(env)).not.toThrow();
});
