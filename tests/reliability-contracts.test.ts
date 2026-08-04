import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_SOURCES,
  RUN_STATUSES,
  isTerminalRunStatus,
  normalizeHistoryRetentionDays,
} from "../src/shared/run-types";
import { ACTION_CLASSES, POLICY_DECISIONS, isApprovalResolution } from "../src/shared/policy-types";
import { RunChannels } from "../src/shared/channels/run-channels";
import { ConversationChannels } from "../src/shared/channels/conversation-channels";
import { PolicyChannels } from "../src/shared/channels/policy-channels";

test("run contracts expose every durable source and status", () => {
  assert.deepEqual(RUN_SOURCES, ["chat", "mcp", "scheduled", "research"]);
  assert.deepEqual(RUN_STATUSES, [
    "running",
    "waiting-approval",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  assert.equal(isTerminalRunStatus("completed"), true);
  assert.equal(isTerminalRunStatus("interrupted"), true);
  assert.equal(isTerminalRunStatus("running"), false);
});

test("retention accepts supported periods and defaults invalid values to 90 days", () => {
  for (const value of [7, 30, 90, 180, 365, null] as const) {
    assert.equal(normalizeHistoryRetentionDays(value), value);
  }
  assert.equal(normalizeHistoryRetentionDays(undefined), 90);
  assert.equal(normalizeHistoryRetentionDays(0), 90);
  assert.equal(normalizeHistoryRetentionDays("forever"), 90);
});

test("policy contracts validate structured approval resolutions", () => {
  assert.ok(ACTION_CLASSES.includes("credential-use"));
  assert.deepEqual(POLICY_DECISIONS, ["allow", "ask", "deny"]);
  assert.equal(isApprovalResolution({ decision: "approve-once" }), true);
  assert.equal(
    isApprovalResolution({ decision: "reject-steer", steering: "Use the other account" }),
    true,
  );
  assert.equal(isApprovalResolution({ decision: "reject-steer", steering: "" }), false);
  assert.equal(isApprovalResolution({ decision: "approve-everywhere" }), false);
});

test("reliability domains expose dedicated IPC channels", () => {
  assert.equal(RunChannels.RUN_LIST, "run:list");
  assert.equal(RunChannels.RUN_UPDATE, "run:update");
  assert.equal(ConversationChannels.CONVERSATION_LIST, "conversation:list");
  assert.equal(ConversationChannels.CONVERSATION_MESSAGE_APPEND, "conversation:message-append");
  assert.equal(PolicyChannels.POLICY_LIST, "policy:list");
  assert.equal(PolicyChannels.POLICY_EVALUATE, "policy:evaluate");
});
