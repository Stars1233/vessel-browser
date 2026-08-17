import {
  applyActivationAttempt,
  applyAiBudget,
  applyCheckoutRedemption,
  applyRateLimit,
} from "./serialized-guard-policies.js";

const ACTIVATION_ACTIONS = new Set(["check", "invalid", "redeem"]);
const AI_BUDGET_ACTIONS = new Set(["ai-get", "ai-reserve", "ai-reconcile"]);

export class ActivationAttemptGuard {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const action = body?.action;
    let result;
    if (ACTIVATION_ACTIONS.has(action)) {
      result = await applyActivationAttempt(this.storage, body);
    } else if (action === "rate-limit") {
      result = await applyRateLimit(this.storage, body);
    } else if (action === "checkout-redeem") {
      result = await applyCheckoutRedemption(this.storage, body);
    } else if (AI_BUDGET_ACTIONS.has(action)) {
      result = await applyAiBudget(this.storage, body);
    } else {
      return Response.json({ error: "Invalid guard action" }, { status: 400 });
    }

    return Response.json(result, { status: result?.error ? 400 : 200 });
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}
