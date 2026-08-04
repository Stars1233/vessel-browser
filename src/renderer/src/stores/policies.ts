import { createSignal } from "solid-js";
import type { PolicyRule } from "../../../shared/policy-types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("PolicyStore");
const [policyRules, setPolicyRules] = createSignal<PolicyRule[]>([]);
let initialized = false;

async function refresh(): Promise<void> {
  setPolicyRules(await window.vessel.policies.list());
}

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await refresh();
    window.vessel.policies.onUpdate((rules) => setPolicyRules(rules));
  } catch (error) {
    initialized = false;
    logger.error("Failed to initialize policy store:", error);
  }
}

export function usePolicies() {
  void init();
  return {
    policyRules,
    refresh,
    removeRule: (ruleId: string) => window.vessel.policies.remove(ruleId),
  };
}
