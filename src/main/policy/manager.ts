import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApprovalMode } from "../../shared/types";
import type {
  PolicyEvaluation,
  PolicyEvaluationInput,
  PolicyRule,
} from "../../shared/policy-types";
import { ACTION_CLASSES, POLICY_DECISIONS } from "../../shared/policy-types";
import { PersistentState } from "../persistence/persistent-state";

interface PolicyStoreState {
  version: 1;
  rules: PolicyRule[];
}

interface AddPolicyRuleInput {
  decision: PolicyRule["decision"];
  actionClass: PolicyRule["actionClass"];
  scope: PolicyRule["scope"];
  domain?: string;
  runId?: string;
  reason: string;
  expiresAt?: string | null;
}

interface PolicyManagerOptions {
  filename?: string;
  createId?: () => string;
  now?: () => Date;
}

const EMPTY_STATE: PolicyStoreState = { version: 1, rules: [] };
const StoredPolicyRuleSchema = z
  .object({
    id: z.string().min(1),
    decision: z.enum(POLICY_DECISIONS),
    actionClass: z.enum(ACTION_CLASSES),
    scope: z.enum(["global", "domain", "run"]),
    domain: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    reason: z.string(),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1).nullable(),
  })
  .superRefine((rule, context) => {
    if (rule.scope === "domain" && !rule.domain) {
      context.addIssue({ code: "custom", message: "Domain rule is missing its domain" });
    }
    if (rule.scope === "run" && !rule.runId) {
      context.addIssue({ code: "custom", message: "Run rule is missing its run ID" });
    }
    if (rule.expiresAt && Number.isNaN(new Date(rule.expiresAt).getTime())) {
      context.addIssue({ code: "custom", message: "Policy expiration is invalid" });
    }
  });

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesDomain(hostname: string, ruleDomain: string): boolean {
  return hostname === ruleDomain || hostname.endsWith(`.${ruleDomain}`);
}

const SCOPE_PRIORITY: Record<PolicyRule["scope"], number> = {
  global: 1,
  domain: 2,
  run: 3,
};

export class PolicyManager {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly state: PersistentState<PolicyStoreState>;

  constructor(options: PolicyManagerOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.state = new PersistentState<PolicyStoreState>({
      filename: options.filename ?? "vessel-policies.json",
      fallback: clone(EMPTY_STATE),
      parse: (raw) => this.parseStoredState(raw),
      logLabel: "policies",
      debounceMs: 150,
      resetOnSchedule: true,
      snapshot: clone,
    });
  }

  addRule(input: AddPolicyRuleInput): PolicyRule {
    const domain = input.domain
      ?.trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
    const runId = input.runId?.trim();
    if (input.scope === "domain" && !domain) {
      throw new Error("Domain-scoped policy rules require a domain");
    }
    if (input.scope === "run" && !runId) {
      throw new Error("Run-scoped policy rules require a run ID");
    }
    const rule: PolicyRule = {
      id: this.createId(),
      decision: input.decision,
      actionClass: input.actionClass,
      scope: input.scope,
      reason: input.reason.trim() || `${input.decision} ${input.actionClass}`,
      createdAt: this.now().toISOString(),
      expiresAt: input.expiresAt ?? null,
      ...(domain ? { domain } : {}),
      ...(runId ? { runId } : {}),
    };
    this.state.mutate((state) => state.rules.push(rule));
    return clone(rule);
  }

  evaluate(
    input: PolicyEvaluationInput,
    approvalMode: ApprovalMode,
    hardDenyReason?: string | null,
  ): PolicyEvaluation {
    if (hardDenyReason) {
      return {
        decision: "deny",
        reason: hardDenyReason,
        matchedRuleId: null,
        scope: "fallback",
      };
    }

    const nowMs = this.now().getTime();
    const hostname = input.domain?.trim().toLowerCase() ?? "";
    const matches = this.state
      .getState()
      .rules.filter((rule) => {
        if (rule.actionClass !== input.actionClass) return false;
        if (rule.expiresAt && new Date(rule.expiresAt).getTime() <= nowMs) return false;
        if (rule.scope === "run") return Boolean(input.runId && rule.runId === input.runId);
        if (rule.scope === "domain") {
          return Boolean(hostname && rule.domain && matchesDomain(hostname, rule.domain));
        }
        return true;
      })
      .sort((left, right) => {
        const scopeDifference = SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope];
        return scopeDifference || right.createdAt.localeCompare(left.createdAt);
      });

    const deny = matches.find((rule) => rule.decision === "deny");
    const matched = deny ?? matches[0];
    if (matched) {
      return {
        decision: matched.decision,
        reason: matched.reason,
        matchedRuleId: matched.id,
        scope: matched.scope,
      };
    }

    const shouldAsk =
      input.requiresApproval ||
      approvalMode === "manual" ||
      (approvalMode === "confirm-dangerous" && input.dangerous);
    return {
      decision: shouldAsk ? "ask" : "allow",
      reason: shouldAsk
        ? input.requiresApproval
          ? "Approval required: high-risk action"
          : approvalMode === "manual"
            ? "Approval required: ask every time mode"
            : "Approval required: risky action"
        : "Allowed by approval mode",
      matchedRuleId: null,
      scope: "fallback",
    };
  }

  listRules(): PolicyRule[] {
    return this.state
      .getState()
      .rules.slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  removeRule(ruleId: string): boolean {
    return this.state.mutate((state) => {
      const before = state.rules.length;
      state.rules = state.rules.filter((rule) => rule.id !== ruleId);
      return state.rules.length !== before;
    });
  }

  pruneExpired(): number {
    const nowMs = this.now().getTime();
    return this.state.mutate((state) => {
      const before = state.rules.length;
      state.rules = state.rules.filter(
        (rule) => !rule.expiresAt || new Date(rule.expiresAt).getTime() > nowMs,
      );
      return before - state.rules.length;
    });
  }

  subscribe(listener: (rules: PolicyRule[]) => void): () => void {
    return this.state.subscribe((snapshot) => listener(snapshot.rules.map(clone)));
  }

  flushPersist(): Promise<void> {
    return this.state.flushPersist();
  }

  private parseStoredState(raw: unknown): PolicyStoreState {
    if (!raw || typeof raw !== "object") return clone(EMPTY_STATE);
    const input = raw as Partial<PolicyStoreState>;
    return {
      version: 1,
      rules: Array.isArray(input.rules)
        ? input.rules.flatMap((value) => {
            const parsed = StoredPolicyRuleSchema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
          })
        : [],
    };
  }
}
