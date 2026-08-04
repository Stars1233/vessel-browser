import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app } from "electron";
import { classifyAction } from "../src/main/policy/action-class";
import { PolicyManager } from "../src/main/policy/manager";

const filename = "vessel-policies-test.json";
const statePath = path.join(app.getPath("userData"), filename);

async function cleanState(): Promise<void> {
  await fs.rm(statePath, { force: true });
}

test("action classifier maps sensitive tools to stable policy classes", () => {
  assert.equal(classifyAction("navigate"), "navigation");
  assert.equal(classifyAction("submit_form"), "form-submit");
  assert.equal(classifyAction("vessel_vault_login"), "credential-use");
  assert.equal(classifyAction("download_file"), "download");
  assert.equal(classifyAction("read_page"), "routine");
});

test("policy precedence applies hard denies before scoped rules", async () => {
  await cleanState();
  let id = 0;
  const manager = new PolicyManager({ filename, createId: () => `rule-${++id}` });
  manager.addRule({
    decision: "allow",
    actionClass: "form-submit",
    scope: "run",
    runId: "run-1",
    reason: "Approved for this run",
  });

  const evaluation = manager.evaluate(
    {
      runId: "run-1",
      actionName: "submit_form",
      actionClass: "form-submit",
      domain: "checkout.example.test",
      dangerous: true,
      requiresApproval: true,
    },
    "confirm-dangerous",
    "Navigation blocked by domain policy",
  );

  assert.equal(evaluation.decision, "deny");
  assert.equal(evaluation.scope, "fallback");
  assert.match(evaluation.reason, /domain policy/);
});

test("explicit deny wins and run rules outrank domain and global rules", async () => {
  await cleanState();
  const manager = new PolicyManager({ filename });
  manager.addRule({
    decision: "allow",
    actionClass: "form-submit",
    scope: "global",
    reason: "Global allow",
  });
  manager.addRule({
    decision: "ask",
    actionClass: "form-submit",
    scope: "domain",
    domain: "example.test",
    reason: "Ask on example",
  });
  manager.addRule({
    decision: "allow",
    actionClass: "form-submit",
    scope: "run",
    runId: "run-1",
    reason: "Run allow",
  });

  const runEvaluation = manager.evaluate(
    {
      runId: "run-1",
      actionName: "submit_form",
      actionClass: "form-submit",
      domain: "shop.example.test",
      dangerous: true,
      requiresApproval: true,
    },
    "manual",
  );
  assert.equal(runEvaluation.decision, "allow");
  assert.equal(runEvaluation.scope, "run");

  manager.addRule({
    decision: "deny",
    actionClass: "form-submit",
    scope: "domain",
    domain: "example.test",
    reason: "Never submit here",
  });
  const denied = manager.evaluate(
    {
      runId: "run-1",
      actionName: "submit_form",
      actionClass: "form-submit",
      domain: "shop.example.test",
      dangerous: true,
      requiresApproval: true,
    },
    "auto",
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.scope, "domain");
});

test("expired rules are ignored and fallback preserves approval mode", async () => {
  await cleanState();
  const now = new Date("2026-01-02T00:00:00.000Z");
  const manager = new PolicyManager({ filename, now: () => now });
  manager.addRule({
    decision: "allow",
    actionClass: "purchase",
    scope: "global",
    reason: "Expired",
    expiresAt: "2026-01-01T00:00:00.000Z",
  });
  const evaluation = manager.evaluate(
    {
      actionName: "checkout",
      actionClass: "purchase",
      domain: "shop.test",
      dangerous: true,
      requiresApproval: false,
    },
    "confirm-dangerous",
  );
  assert.equal(evaluation.decision, "ask");
  assert.equal(evaluation.scope, "fallback");
});

test("policy manager drops malformed rules without losing valid rules", async () => {
  await cleanState();
  const manager = new PolicyManager({ filename });
  manager.addRule({
    decision: "allow",
    actionClass: "navigation",
    scope: "domain",
    domain: "example.test",
    reason: "Keep this rule",
  });
  await manager.flushPersist();

  const stored = JSON.parse(await fs.readFile(statePath, "utf-8")) as { rules: unknown[] };
  stored.rules.push(null, {
    id: "bad-rule",
    decision: "allow",
    actionClass: "navigation",
    scope: "domain",
    reason: "Missing domain",
    createdAt: new Date().toISOString(),
    expiresAt: null,
  });
  await fs.writeFile(statePath, JSON.stringify(stored), "utf-8");

  const reloaded = new PolicyManager({ filename });
  assert.deepEqual(
    reloaded.listRules().map((rule) => rule.reason),
    ["Keep this rule"],
  );
});
