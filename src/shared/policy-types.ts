export const ACTION_CLASSES = [
  "navigation",
  "form-fill",
  "form-submit",
  "purchase",
  "upload",
  "download",
  "credential-use",
  "destructive",
  "tab-create",
  "external-open",
  "routine",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const POLICY_DECISIONS = ["allow", "ask", "deny"] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
export type PolicyScope = "global" | "domain" | "run";

export interface PolicyRule {
  id: string;
  decision: PolicyDecision;
  actionClass: ActionClass;
  scope: PolicyScope;
  domain?: string;
  runId?: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface PolicyEvaluationInput {
  runId?: string;
  actionName: string;
  actionClass: ActionClass;
  domain?: string;
  url?: string;
  dangerous: boolean;
  requiresApproval: boolean;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
  matchedRuleId: string | null;
  scope: PolicyScope | "fallback";
}

export const APPROVAL_DECISIONS = [
  "approve-once",
  "approve-run",
  "approve-domain",
  "reject",
  "reject-steer",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalResolution {
  decision: ApprovalDecision;
  steering?: string;
}

export function isApprovalResolution(value: unknown): value is ApprovalResolution {
  if (!value || typeof value !== "object") return false;
  const resolution = value as Record<string, unknown>;
  if (!APPROVAL_DECISIONS.includes(resolution.decision as ApprovalDecision)) return false;
  if (resolution.decision === "reject-steer") {
    return typeof resolution.steering === "string" && resolution.steering.trim().length > 0;
  }
  return resolution.steering === undefined || typeof resolution.steering === "string";
}
