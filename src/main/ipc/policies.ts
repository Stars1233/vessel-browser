import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { ACTION_CLASSES, POLICY_DECISIONS } from "../../shared/policy-types";
import type { PolicyManager } from "../policy/manager";
import { assertTrustedIpcSender, parseIpc } from "./common";

const RuleIdSchema = z.string().min(1).max(200);
const RuleSchema = z.object({
  decision: z.enum(POLICY_DECISIONS),
  actionClass: z.enum(ACTION_CLASSES),
  scope: z.enum(["global", "domain", "run"]),
  domain: z.string().trim().max(500).optional(),
  runId: z.string().trim().max(200).optional(),
  reason: z.string().trim().max(2000),
  expiresAt: z.string().datetime().nullable().optional(),
});
const EvaluationSchema = z.object({
  input: z.object({
    runId: z.string().max(200).optional(),
    actionName: z.string().min(1).max(500),
    actionClass: z.enum(ACTION_CLASSES),
    domain: z.string().max(500).optional(),
    url: z.string().max(20_000).optional(),
    dangerous: z.boolean(),
    requiresApproval: z.boolean(),
  }),
  approvalMode: z.enum(["auto", "confirm-dangerous", "manual"]),
  hardDenyReason: z.string().max(2000).nullable().optional(),
});

export function registerPolicyHandlers(
  manager: PolicyManager,
  sendToRendererViews: (channel: string, ...args: unknown[]) => void,
): void {
  manager.subscribe((rules) => sendToRendererViews(Channels.POLICY_UPDATE, rules));

  ipcMain.handle(Channels.POLICY_LIST, (event) => {
    assertTrustedIpcSender(event);
    return manager.listRules();
  });

  ipcMain.handle(Channels.POLICY_ADD, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return manager.addRule(parseIpc(RuleSchema, input, "policy rule"));
  });

  ipcMain.handle(Channels.POLICY_REMOVE, (event, ruleId: unknown) => {
    assertTrustedIpcSender(event);
    return manager.removeRule(parseIpc(RuleIdSchema, ruleId, "policy rule ID"));
  });

  ipcMain.handle(Channels.POLICY_EVALUATE, (event, payload: unknown) => {
    assertTrustedIpcSender(event);
    const validated = parseIpc(EvaluationSchema, payload, "policy evaluation");
    return manager.evaluate(validated.input, validated.approvalMode, validated.hardDenyReason);
  });
}
