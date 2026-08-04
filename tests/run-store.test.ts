import test from "node:test";
import assert from "node:assert/strict";
import type { RunDetail, RunRecord } from "../src/shared/run-types";

function createRun(status: RunRecord["status"] = "running"): RunDetail {
  const finishedAt = status === "running" ? null : "2026-08-03T12:01:00.000Z";
  return {
    id: "run-1",
    source: "chat",
    title: "Reliability check",
    goal: "Keep selected run details current",
    status,
    createdAt: "2026-08-03T12:00:00.000Z",
    startedAt: "2026-08-03T12:00:00.000Z",
    updatedAt: finishedAt ?? "2026-08-03T12:00:00.000Z",
    finishedAt,
    initialTab: null,
    finalTab: null,
    outputSummary: status === "completed" ? "Done" : "",
    error: null,
    lastCompletedAction: null,
    events: [
      {
        id: "event-1",
        runId: "run-1",
        kind: "run-started",
        timestamp: "2026-08-03T12:00:00.000Z",
        summary: "Run started",
      },
      ...(status === "completed"
        ? [
            {
              id: "event-2",
              runId: "run-1",
              kind: "run-completed" as const,
              timestamp: "2026-08-03T12:01:00.000Z",
              summary: "Run completed",
            },
          ]
        : []),
    ],
  };
}

function createMockRuns() {
  const updateListeners = new Set<(runs: RunRecord[]) => void>();
  let detail = createRun();

  return {
    setDetail(next: RunDetail) {
      detail = next;
    },
    emitUpdate() {
      for (const listener of updateListeners) listener([detail]);
    },
    api: {
      list: async () => [detail],
      get: async () => detail,
      delete: async () => true,
      export: async () => null,
      onUpdate: (listener: (runs: RunRecord[]) => void) => {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

test("selected run details refresh when the run list updates", async () => {
  const mockRuns = createMockRuns();
  (globalThis as { window?: unknown }).window = {
    vessel: {
      runs: mockRuns.api,
    },
  };

  const module = await import("../src/renderer/src/stores/runs");
  module.resetRunStoreForTests();
  const store = module.useRuns();
  await flushAsyncWork();

  await store.selectRun("run-1");
  assert.equal(store.selectedRun()?.status, "running");
  assert.equal(store.selectedRun()?.events.length, 1);

  mockRuns.setDetail(createRun("completed"));
  mockRuns.emitUpdate();
  await flushAsyncWork();

  assert.equal(store.selectedRun()?.status, "completed");
  assert.equal(store.selectedRun()?.events.length, 2);
  assert.equal(store.selectedRun()?.outputSummary, "Done");

  module.resetRunStoreForTests();
});
