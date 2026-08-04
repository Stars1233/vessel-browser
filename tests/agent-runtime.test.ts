import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app } from "electron";
import { AgentRuntime, type AgentRuntimeActionLifecycleEvent } from "../src/main/agent/runtime";
import { executeAction } from "../src/main/ai/page-actions/orchestrator";
import { setSetting } from "../src/main/config/settings";
import { PolicyManager } from "../src/main/policy/manager";
import type { TabGroupColor } from "../src/shared/types";
import type { SessionSnapshot } from "../src/shared/types";

function makeRuntime(policyManager?: PolicyManager): AgentRuntime {
  const tabManager = {
    snapshotSession: (): SessionSnapshot => ({ tabs: [], activeTabId: null }),
    restoreSession: () => {},
    getAllStates: () => [],
  };
  return new AgentRuntime(tabManager as never, { policyManager });
}

test("updateCheckpointNote updates the matching checkpoint by id", async () => {
  const statePath = path.join(app.getPath("userData"), "vessel-agent-runtime.json");
  await fs.rm(statePath, { force: true });

  const runtime = makeRuntime();
  const checkpoint = runtime.createCheckpoint("Before risky flow", "old note");

  const updated = runtime.updateCheckpointNote(checkpoint.id, "new note");

  assert.ok(updated);
  assert.equal(updated.id, checkpoint.id);
  assert.equal(updated.note, "new note");
  assert.equal(runtime.getState().checkpoints[0]?.note, "new note");
});

test("auto approval mode bypasses explicitly approval-gated actions", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("auto");

  const result = await runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    dangerous: true,
    requiresApproval: true,
    executor: async () => "navigated",
  });

  assert.equal(result, "navigated");
  assert.equal(runtime.getState().supervisor.pendingApprovals.length, 0);
  assert.equal(runtime.getState().actions[0]?.status, "completed");
});

test("confirm-dangerous still pauses explicitly approval-gated actions", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("confirm-dangerous");

  const resultPromise = runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    dangerous: true,
    requiresApproval: true,
    executor: async () => "navigated",
  });

  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  assert.equal(runtime.getState().actions[0]?.status, "waiting-approval");

  runtime.resolveApproval(approval.id, { decision: "approve-once" });
  assert.equal(await resultPromise, "navigated");
});

test("paused supervisor still requires approval even in auto mode", async () => {
  const runtime = makeRuntime();
  runtime.setApprovalMode("auto");
  runtime.pause();

  const resultPromise = runtime.runControlledAction({
    source: "ai",
    name: "read_page",
    executor: async () => "read",
  });

  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  assert.match(approval.reason, /paused/i);

  runtime.resolveApproval(approval.id, { decision: "reject" });
  assert.equal(await resultPromise, "Action rejected: read_page");
});

test("runControlledAction emits lifecycle events for agent tools", async () => {
  const runtime = makeRuntime();
  const events: AgentRuntimeActionLifecycleEvent[] = [];
  runtime.setActionLifecycleListener((event) => events.push(event));

  const result = await runtime.runControlledAction({
    source: "ai",
    name: "read_page",
    args: { mode: "results_only" },
    tabId: "tab-1",
    runId: "run-1",
    executor: async () => "page text",
  });

  assert.equal(result, "page text");
  assert.equal(events.length, 2);
  assert.equal(events[0].phase, "started");
  assert.equal(events[0].name, "read_page");
  assert.equal(events[0].source, "ai");
  assert.equal(events[0].detail, "mode=results_only");
  assert.equal(events[0].runId, "run-1");
  assert.equal(events[1].phase, "completed");
  assert.equal(events[1].detail, "page text");
  assert.equal(events[1].actionId, events[0].actionId);
  assert.equal(typeof events[1].durationMs, "number");
});

test("reject and steer returns human guidance to the action caller", async () => {
  const runtime = makeRuntime();
  const events: AgentRuntimeActionLifecycleEvent[] = [];
  runtime.setActionLifecycleListener((event) => events.push(event));
  runtime.setApprovalMode("manual");
  const resultPromise = runtime.runControlledAction({
    source: "mcp",
    name: "submit_form",
    runId: "run-steer",
    dangerous: true,
    executor: async () => "submitted",
  });
  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);

  runtime.resolveApproval(approval.id, {
    decision: "reject-steer",
    steering: "Use the work account instead",
  });

  assert.equal(
    await resultPromise,
    "Action rejected: submit_form. Human guidance: Use the work account instead",
  );
  assert.deepEqual(
    events.map((event) => event.phase),
    ["started", "waiting-approval", "approval-resolved", "rejected"],
  );
  assert.match(events[2].detail ?? "", /Use the work account instead/);
});

test("approve for run creates a scoped allow used by the next matching action", async () => {
  const policyManager = new PolicyManager({
    filename: `vessel-policy-runtime-${Date.now()}.json`,
  });
  const runtime = makeRuntime(policyManager);
  const events: AgentRuntimeActionLifecycleEvent[] = [];
  runtime.setActionLifecycleListener((event) => events.push(event));
  runtime.setApprovalMode("manual");
  const first = runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    runId: "run-allow",
    dangerous: true,
    executor: async () => "first",
  });
  const approval = runtime.getState().supervisor.pendingApprovals[0];
  assert.ok(approval);
  runtime.resolveApproval(approval.id, { decision: "approve-run" });
  assert.equal(await first, "first");
  assert.deepEqual(
    events.slice(0, 4).map((event) => event.phase),
    ["started", "waiting-approval", "approval-resolved", "completed"],
  );

  const second = await runtime.runControlledAction({
    source: "ai",
    name: "navigate",
    runId: "run-allow",
    dangerous: true,
    executor: async () => "second",
  });
  assert.equal(second, "second");
  assert.equal(runtime.getState().supervisor.pendingApprovals.length, 0);
});

test("advertised API group tools dispatch to tab group operations", async () => {
  setSetting("telemetryEnabled", false);
  const runtime = makeRuntime();
  const groups = [
    { id: "group-1", name: "Research", color: "blue" as TabGroupColor, collapsed: false },
  ];
  const tabs = [{ id: "tab-1", title: "Docs", url: "https://example.test", groupId: "group-1" }];
  const colorChanges: Array<{ groupId: string; color: TabGroupColor }> = [];
  const createdGroups: Array<{ tabId: string; color?: TabGroupColor }> = [];
  const tabManager = {
    getActiveTab: () => null,
    getActiveTabId: () => null,
    getGroups: () => groups,
    getAllStates: () => tabs,
    createGroupFromTab: (tabId: string, options?: { color?: TabGroupColor }) => {
      createdGroups.push({ tabId, color: options?.color });
      return "group-created";
    },
    assignTabToGroup: () => undefined,
    removeTabFromGroup: () => undefined,
    toggleGroupCollapsed: () => false,
    setGroupColor: (groupId: string, color: TabGroupColor) => {
      colorChanges.push({ groupId, color });
    },
  };

  assert.match(
    await executeAction("list_groups", {}, { runtime, tabManager: tabManager as never }),
    /\[group-1\] Research/,
  );
  assert.equal(
    await executeAction(
      "set_group_color",
      { groupId: "group-1", color: "green" },
      { runtime, tabManager: tabManager as never },
    ),
    "Set group group-1 color to green",
  );
  assert.deepEqual(colorChanges, [{ groupId: "group-1", color: "green" }]);
  assert.equal(
    await executeAction(
      "create_group",
      { tabId: "tab-1", color: "chartreuse" },
      { runtime, tabManager: tabManager as never },
    ),
    "Error: Invalid tab group color",
  );
  assert.deepEqual(createdGroups, []);
  assert.equal(
    await executeAction(
      "assign_to_group",
      { groupId: "missing-group", tabId: "tab-1" },
      { runtime, tabManager: tabManager as never },
    ),
    "Error: Group not found",
  );
  assert.equal(
    await executeAction(
      "assign_to_group",
      { groupId: "group-1", tabId: "missing-tab" },
      { runtime, tabManager: tabManager as never },
    ),
    "Error: Tab not found",
  );
  assert.notEqual(
    await executeAction(
      "toggle_group",
      { groupId: "group-1" },
      { runtime, tabManager: tabManager as never },
    ),
    "Unknown tool: toggle_group",
  );
});
