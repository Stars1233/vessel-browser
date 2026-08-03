import assert from "node:assert/strict";
import test from "node:test";

import { ActivationAttemptGuard } from "../scripts/cloudflare-worker/activation-attempt-guard.js";

function createGuardHarness() {
  const values = new Map<string, unknown>();
  let transactionQueue = Promise.resolve();
  const storage = {
    transaction<T>(callback: (transaction: {
      get: (key: string) => Promise<unknown>;
      put: (key: string, value: unknown) => Promise<void>;
    }) => Promise<T>): Promise<T> {
      const result = transactionQueue.then(() => callback({
        async get(key: string) { return values.get(key); },
        async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
      }));
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    },
    async setAlarm() {},
    async deleteAll() { values.clear(); },
  };
  const guard = new ActivationAttemptGuard({ storage });

  return {
    async action(body: Record<string, unknown>) {
      const response = await guard.fetch(new Request("https://guard.internal/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      return response.json() as Promise<{
        status?: string;
        usage?: { requests?: number; estimatedCostUsd?: number };
      }>;
    },
  };
}

test("AI budget guard keeps monthly ledgers independent across rollover", async () => {
  const harness = createGuardHarness();

  await harness.action({
    action: "ai-reserve",
    period: "2026-08",
    baseline: { period: "2026-08", requests: 4, estimatedCostUsd: 4 },
    budgetUsd: 5,
    reservationUsd: 0.25,
    reservationId: "august-request",
  });
  await harness.action({
    action: "ai-reserve",
    period: "2026-09",
    baseline: { period: "2026-09", requests: 0, estimatedCostUsd: 0 },
    budgetUsd: 5,
    reservationUsd: 0.25,
    reservationId: "september-request",
  });
  await harness.action({
    action: "ai-reconcile",
    period: "2026-08",
    reservationId: "august-request",
    commit: true,
    promptTokens: 10,
    completionTokens: 10,
    actualCostUsd: 0.1,
  });

  const august = await harness.action({ action: "ai-get", period: "2026-08" });
  const september = await harness.action({ action: "ai-get", period: "2026-09" });
  assert.equal(august.usage?.requests, 5);
  assert.equal(august.usage?.estimatedCostUsd, 4.1);
  assert.equal(september.usage?.requests, 0);
  assert.equal(september.usage?.estimatedCostUsd, 0);
});

test("AI budget reconciliation is idempotent", async () => {
  const harness = createGuardHarness();
  await harness.action({
    action: "ai-reserve",
    period: "2026-08",
    budgetUsd: 5,
    reservationUsd: 0.25,
    reservationId: "request-1",
  });
  const reconciliation = {
    action: "ai-reconcile",
    period: "2026-08",
    reservationId: "request-1",
    commit: true,
    promptTokens: 10,
    completionTokens: 10,
    actualCostUsd: 0.1,
  };

  await harness.action(reconciliation);
  await harness.action(reconciliation);

  const usage = await harness.action({ action: "ai-get", period: "2026-08" });
  assert.equal(usage.usage?.requests, 1);
  assert.equal(usage.usage?.estimatedCostUsd, 0.1);
});

test("activation attempt guard serializes concurrent invalid attempts", async () => {
  const harness = createGuardHarness();
  const expiresAt = Date.now() + 60_000;
  const results = await Promise.all(
    Array.from({ length: 6 }, () => harness.action({
      action: "invalid",
      expiresAt,
    })),
  );

  assert.equal(results.filter((result) => result.status === "recorded").length, 5);
  assert.equal(results.filter((result) => result.status === "limited").length, 1);
  assert.equal(
    (await harness.action({ action: "redeem", expiresAt })).status,
    "redeemed",
  );
});
