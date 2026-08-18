import assert from "node:assert/strict";
import test from "node:test";

import worker from "../scripts/cloudflare-worker/vessel-premium-api.js";
import {
  OPENROUTER_API,
  STRIPE_API,
  WORKER_URL,
  createActivationBindings,
  createMemoryKv,
  createMemorySecurityGuard,
  createPremiumToken,
  createSignedPremiumToken,
  env,
  nowSeconds,
  postJson,
  postJsonWithEnv,
  usageKey,
  withMockFetch,
} from "./helpers/cloudflare-premium-worker.js";

function makeAiRequest(token: string, bindings: Record<string, unknown>): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_URL}/ai/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 2000,
      }),
    }),
    { ...env, ...bindings, OPENROUTER_API_KEY: "sk-or-test" },
  );
}

test("premium worker preserves the original Google Play token expiry on entitlement refresh", async () => {
  const expiresAt = Date.now() + 30 * 60 * 1000;
  const token = await createSignedPremiumToken({
    customerId: "play:test-customer",
    email: "play@example.com",
    plan: "plus",
    source: "google_play",
    iat: Date.now(),
    exp: expiresAt,
  });

  const first = await postJson("/entitlement", { identifier: token });
  const firstData = (await first.json()) as {
    verificationToken?: string;
    expiresAt?: string;
  };
  const second = await postJson("/entitlement", {
    identifier: firstData.verificationToken,
  });
  const secondData = (await second.json()) as {
    verificationToken?: string;
    expiresAt?: string;
  };

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstData.verificationToken, token);
  assert.equal(secondData.verificationToken, token);
  assert.equal(firstData.expiresAt, new Date(expiresAt).toISOString());
  assert.equal(secondData.expiresAt, new Date(expiresAt).toISOString());
});

test("premium worker atomically reserves AI budget before concurrent provider calls", async () => {
  const kv = createMemoryKv();
  const guard = createMemorySecurityGuard();
  const token = await createPremiumToken("cus_ai_concurrent");
  const key = await usageKey("cus_ai_concurrent");
  await kv.put(
    key,
    JSON.stringify({
      period: key.split(":")[1],
      requests: 10,
      estimatedCostUsd: 4.997,
      promptTokens: 1000,
      completionTokens: 1000,
    }),
  );
  let upstreamCalls = 0;

  await withMockFetch(
    (url) => {
      assert.equal(url, `${OPENROUTER_API}/chat/completions`);
      upstreamCalls += 1;
      return {
        id: `gen_concurrent_${upstreamCalls}`,
        model: "upstream/model",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 1000 },
      };
    },
    async () => {
      const bindings = { ACTIVATION_KV: kv, ACTIVATION_GUARD: guard };
      const responses = await Promise.all([
        makeAiRequest(token, bindings),
        makeAiRequest(token, bindings),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 402]);
      assert.equal(upstreamCalls, 1);
    },
  );
});

test("premium worker fails closed before AI provider access when the budget guard is missing", async () => {
  const token = await createPremiumToken("cus_ai_missing_guard");
  let upstreamCalls = 0;

  await withMockFetch(
    () => {
      upstreamCalls += 1;
      return { error: "provider should not be called" };
    },
    async () => {
      const response = await makeAiRequest(token, { ACTIVATION_KV: createMemoryKv() });
      assert.equal(response.status, 503);
      assert.equal(upstreamCalls, 0);
    },
  );
});

test("premium worker releases AI reservations after failed provider responses", async () => {
  const kv = createMemoryKv();
  const guard = createMemorySecurityGuard();
  const token = await createPremiumToken("cus_ai_release");
  const key = await usageKey("cus_ai_release");
  await kv.put(
    key,
    JSON.stringify({
      period: key.split(":")[1],
      requests: 10,
      estimatedCostUsd: 4.997,
      promptTokens: 1000,
      completionTokens: 1000,
    }),
  );
  let upstreamCalls = 0;

  await withMockFetch(
    (url) => {
      assert.equal(url, `${OPENROUTER_API}/chat/completions`);
      upstreamCalls += 1;
      return new Response(JSON.stringify({ error: "temporary provider failure" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
    async () => {
      const bindings = { ACTIVATION_KV: kv, ACTIVATION_GUARD: guard };
      assert.equal((await makeAiRequest(token, bindings)).status, 500);
      assert.equal((await makeAiRequest(token, bindings)).status, 500);
      assert.equal(upstreamCalls, 2);
    },
  );
});

test("premium worker charges the reservation estimate for malformed provider usage", async () => {
  const kv = createMemoryKv();
  const guard = createMemorySecurityGuard();
  const token = await createPremiumToken("cus_ai_malformed_usage");

  await withMockFetch(
    (url) => {
      if (url === `${OPENROUTER_API}/chat/completions`) {
        return {
          id: "gen_malformed_usage",
          model: "upstream/model",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {},
        };
      }
      if (url === `${STRIPE_API}/customers/cus_ai_malformed_usage`) {
        return { id: "cus_ai_malformed_usage", email: "premium@example.com" };
      }
      if (
        url === `${STRIPE_API}/subscriptions?customer=cus_ai_malformed_usage&status=all&limit=10`
      ) {
        return {
          data: [
            {
              id: "sub_active",
              status: "active",
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const bindings = { ACTIVATION_KV: kv, ACTIVATION_GUARD: guard };
      assert.equal((await makeAiRequest(token, bindings)).status, 200);

      const entitlement = await postJsonWithEnv("/entitlement", { identifier: token }, bindings);
      const data = (await entitlement.json()) as {
        usage?: { requests?: number; estimatedCostUsd?: number };
      };
      assert.equal(data.usage?.requests, 1);
      assert.ok((data.usage?.estimatedCostUsd || 0) > 0);
    },
  );
});

test("premium worker serializes concurrent feedback rate-limit decisions", async () => {
  const guard = createMemorySecurityGuard();
  let resendCalls = 0;

  await withMockFetch(
    (url) => {
      assert.equal(url, "https://api.resend.com/emails");
      resendCalls += 1;
      return { id: `email_${resendCalls}` };
    },
    async () => {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          postJsonWithEnv(
            "/feedback",
            { email: "user@example.com", message: `Concurrent feedback ${index}` },
            { ACTIVATION_KV: createMemoryKv(), ACTIVATION_GUARD: guard },
            { "cf-connecting-ip": "203.0.113.20" },
          ),
        ),
      );

      assert.equal(responses.filter((response) => response.status === 200).length, 5);
      assert.equal(responses.filter((response) => response.status === 429).length, 7);
      assert.equal(resendCalls, 5);
    },
  );
});

test("premium worker rate limits concurrent activation-code issuance before Stripe", async () => {
  const guard = createMemorySecurityGuard();
  let stripeCalls = 0;
  let resendCalls = 0;

  await withMockFetch(
    (url) => {
      if (url.startsWith(STRIPE_API)) {
        stripeCalls += 1;
        return { data: [] };
      }
      if (url === "https://api.resend.com/emails") {
        resendCalls += 1;
        return { id: `email_${resendCalls}` };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const responses = await Promise.all(
        Array.from({ length: 12 }, () =>
          postJsonWithEnv(
            "/activate/start",
            { email: "premium@example.com" },
            { ACTIVATION_KV: createMemoryKv(), ACTIVATION_GUARD: guard },
            { "cf-connecting-ip": "203.0.113.30" },
          ),
        ),
      );

      assert.equal(responses.filter((response) => response.status === 200).length, 5);
      assert.equal(responses.filter((response) => response.status === 429).length, 7);
      assert.equal(stripeCalls, 15);
      assert.equal(resendCalls, 0);
    },
  );
});

test("premium worker rate limits concurrent checkout creation before Stripe", async () => {
  const guard = createMemorySecurityGuard();
  let stripeCalls = 0;

  await withMockFetch(
    (url) => {
      assert.equal(url, `${STRIPE_API}/checkout/sessions`);
      stripeCalls += 1;
      return { url: `https://checkout.stripe.test/session-${stripeCalls}` };
    },
    async () => {
      const responses = await Promise.all(
        Array.from({ length: 12 }, () =>
          worker.fetch(
            new Request(`${WORKER_URL}/checkout`, {
              method: "POST",
              headers: { "cf-connecting-ip": "203.0.113.40" },
            }),
            { ...env, ACTIVATION_GUARD: guard },
          ),
        ),
      );

      assert.equal(responses.filter((response) => response.status === 200).length, 10);
      assert.equal(responses.filter((response) => response.status === 429).length, 2);
      assert.equal(stripeCalls, 10);
    },
  );
});

test("premium worker serializes concurrent checkout redemption", async () => {
  const bindings = createActivationBindings();
  let checkoutFetches = 0;

  await withMockFetch(
    async (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_concurrent`) {
        checkoutFetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { customer: "cus_test", subscription: "sub_trial" };
      }
      if (url === `${STRIPE_API}/subscriptions/sub_trial`) {
        return {
          id: "sub_trial",
          status: "trialing",
          trial_end: nowSeconds() + 7 * 24 * 60 * 60,
          current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
        };
      }
      if (url === `${STRIPE_API}/customers/cus_test`) {
        return { id: "cus_test", email: "premium@example.com" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const responses = await Promise.all([
        postJsonWithEnv("/verify", { identifier: "cs_concurrent" }, bindings),
        postJsonWithEnv("/verify", { identifier: "cs_concurrent" }, bindings),
      ]);

      assert.equal(responses.filter((response) => response.status === 200).length, 1);
      assert.equal(responses.filter((response) => response.status === 409).length, 1);
      assert.equal(checkoutFetches, 1);
    },
  );
});

test("premium worker caps Stripe token lifetime to subscription access", async () => {
  const accessEndsAt = nowSeconds() + 5 * 60;
  const bindings = createActivationBindings();

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_short_lived`) {
        return { customer: "cus_test", subscription: "sub_short" };
      }
      if (url === `${STRIPE_API}/subscriptions/sub_short`) {
        return {
          id: "sub_short",
          status: "active",
          current_period_end: accessEndsAt,
        };
      }
      if (url === `${STRIPE_API}/customers/cus_test`) {
        return { id: "cus_test", email: "premium@example.com" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJsonWithEnv("/verify", { identifier: "cs_short_lived" }, bindings);
      const data = (await response.json()) as { verificationToken?: string };
      const payloadPart = data.verificationToken?.split(".")[1] || "";
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
        exp: number;
      };

      assert.equal(response.status, 200);
      assert.ok(payload.exp <= accessEndsAt * 1000);
      assert.ok(payload.exp > Date.now());
    },
  );
});

test("premium worker refreshes a recently expired Stripe token after renewal", async () => {
  const expiredToken = await createSignedPremiumToken({
    customerId: "cus_renewed",
    email: "renewed@example.com",
    iat: Date.now() - 31 * 24 * 60 * 60 * 1000,
    exp: Date.now() - 60 * 1000,
  });

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/customers/cus_renewed`) {
        return { id: "cus_renewed", email: "renewed@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_renewed&status=all&limit=10`) {
        return {
          data: [
            {
              id: "sub_renewed",
              status: "active",
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJsonWithEnv(
        "/verify",
        { identifier: expiredToken },
        {},
        { "X-Vessel-Version": "0.2.0" },
      );
      const data = (await response.json()) as { verificationToken?: string };
      const payloadPart = data.verificationToken?.split(".")[1] || "";
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
        exp: number;
      };

      assert.equal(response.status, 200);
      assert.notEqual(data.verificationToken, expiredToken);
      assert.ok(payload.exp > Date.now());
    },
  );
});

test("premium worker keeps recently expired tokens blocked from entitlement access", async () => {
  const expiredToken = await createSignedPremiumToken({
    customerId: "cus_expired_entitlement",
    email: "expired@example.com",
    iat: Date.now() - 31 * 24 * 60 * 60 * 1000,
    exp: Date.now() - 60 * 1000,
  });

  const response = await postJson("/entitlement", { identifier: expiredToken });
  assert.equal(response.status, 403);
});

test("premium worker rejects refresh tokens beyond the renewal grace period", async () => {
  const expiredToken = await createSignedPremiumToken({
    customerId: "cus_too_old",
    email: "old@example.com",
    iat: Date.now() - 40 * 24 * 60 * 60 * 1000,
    exp: Date.now() - 8 * 24 * 60 * 60 * 1000,
  });

  const response = await postJson("/verify", { identifier: expiredToken });
  assert.equal(response.status, 403);
});
