import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app } from "electron";
import { RunManager } from "../src/main/runs/manager";
import { redactRunValue } from "../src/main/runs/redaction";

const filename = "vessel-runs-test.json";
const statePath = path.join(app.getPath("userData"), filename);

async function cleanState(): Promise<void> {
  await fs.rm(statePath, { force: true });
}

test("run manager persists an ordered lifecycle and reloads terminal runs", async () => {
  await cleanState();
  let id = 0;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RunManager({ filename, createId: () => `id-${++id}`, now: () => now });

  const run = manager.startRun({ source: "chat", title: "Compare plans", goal: "Compare plans" });
  now = new Date("2026-01-01T00:00:01.000Z");
  manager.appendEvent(run.id, { kind: "action-started", summary: "Read page" });
  now = new Date("2026-01-01T00:00:02.000Z");
  manager.finishRun(run.id, { status: "completed", outputSummary: "Comparison ready" });
  await manager.flushPersist();

  const reloaded = new RunManager({ filename });
  const detail = reloaded.getRun(run.id);
  assert.ok(detail);
  assert.equal(detail.status, "completed");
  assert.equal(detail.outputSummary, "Comparison ready");
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    ["run-started", "action-started", "run-completed"],
  );
});

test("run manager marks unfinished persisted runs interrupted on reload", async () => {
  await cleanState();
  const manager = new RunManager({ filename });
  const run = manager.startRun({ source: "scheduled", title: "Daily check", goal: "Check page" });
  await manager.flushPersist();

  const reloaded = new RunManager({ filename });
  const recovered = reloaded.getRun(run.id);
  assert.equal(recovered?.status, "interrupted");
  assert.match(recovered?.error ?? "", /previous Vessel session ended/i);
  assert.equal(recovered?.events.at(-1)?.kind, "run-interrupted");
});

test("retention removes expired terminal runs but preserves active runs", async () => {
  await cleanState();
  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RunManager({ filename, now: () => now });
  const completed = manager.startRun({ source: "chat", title: "Old", goal: "Old" });
  manager.finishRun(completed.id, { status: "completed" });
  const active = manager.startRun({ source: "mcp", title: "Active", goal: "Active" });

  now = new Date("2026-05-01T00:00:00.000Z");
  assert.equal(manager.pruneExpired(90), 1);
  assert.equal(manager.getRun(completed.id), null);
  assert.equal(manager.getRun(active.id)?.status, "running");
});

test("run redaction removes secrets recursively and truncates large values", () => {
  const redacted = redactRunValue("type", {
    password: "hunter2",
    nested: { authorization: "Bearer token", safe: "visible" },
    text: "x".repeat(5000),
  }) as Record<string, unknown>;

  assert.equal(redacted.password, "[REDACTED]");
  assert.deepEqual(redacted.nested, { authorization: "[REDACTED]", safe: "visible" });
  assert.match(String(redacted.text), /\[truncated\]$/);
  assert.ok(String(redacted.text).length < 2100);
});

test("run manager drops malformed records and orphan events without losing valid runs", async () => {
  await cleanState();
  const manager = new RunManager({ filename });
  const run = manager.startRun({ source: "chat", title: "Keep me", goal: "Persist safely" });
  manager.finishRun(run.id, { status: "completed" });
  await manager.flushPersist();

  const stored = JSON.parse(await fs.readFile(statePath, "utf-8")) as {
    runs: unknown[];
    events: unknown[];
  };
  stored.runs.push(null, { id: "incomplete" });
  stored.events.push(null, {
    id: "orphan-event",
    runId: "missing-run",
    kind: "run-completed",
    timestamp: new Date().toISOString(),
    summary: "orphaned",
  });
  await fs.writeFile(statePath, JSON.stringify(stored), "utf-8");

  const reloaded = new RunManager({ filename });
  assert.deepEqual(
    reloaded.listRuns().map((item) => item.id),
    [run.id],
  );
  assert.equal(reloaded.getRun(run.id)?.events.length, 2);
});
