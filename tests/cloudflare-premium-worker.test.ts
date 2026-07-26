import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  ActivationAttemptGuard,
} from "../scripts/cloudflare-worker/vessel-premium-api.js";

const STRIPE_API = "https://api.stripe.com/v1";
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const WORKER_URL = "https://premium.example";
const nowSeconds = () => Math.floor(Date.now() / 1000);

type MockFetchHandler = (
  url: string,
  init?: RequestInit,
) => unknown | Promise<unknown>;

const env = {
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_ID: "price_test",
  PREMIUM_TOKEN_SECRET: "test-secret",
  RESEND_API_KEY: "re_test",
  PREMIUM_FROM_EMAIL: "Vessel <premium@example.com>",
  FEEDBACK_TO_EMAIL: "hello@quantaintellect.com",
};

function createMemoryKv(): {
  get: (key: string) => Promise<string | null>;
  put: (
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ) => Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}

function createMemoryActivationGuard(): {
  getByName: (name: string) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
} {
  const states = new Map<string, { attempts: number; redeemed: boolean }>();
  const queues = new Map<string, Promise<void>>();

  return {
    getByName(name: string) {
      return {
        fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const run = async () => {
            const body = JSON.parse(String(init?.body || "{}")) as { action?: string };
            const state = states.get(name) || { attempts: 0, redeemed: false };
            if (state.redeemed) {
              return jsonResponse({ status: "redeemed", attempts: state.attempts });
            }
            if (state.attempts >= 5) {
              return jsonResponse({ status: "limited", attempts: state.attempts });
            }
            if (body.action === "invalid") {
              state.attempts += 1;
              states.set(name, state);
              return jsonResponse({ status: "recorded", attempts: state.attempts });
            }
            if (body.action === "redeem") {
              state.redeemed = true;
              states.set(name, state);
              return jsonResponse({ status: "redeemed", attempts: state.attempts });
            }
            return jsonResponse({ status: "ready", attempts: state.attempts });
          };

          const response = (queues.get(name) || Promise.resolve()).then(run);
          queues.set(name, response.then(() => undefined, () => undefined));
          return response;
        },
      };
    },
  };
}

function createActivationBindings() {
  return {
    ACTIVATION_KV: createMemoryKv(),
    ACTIVATION_GUARD: createMemoryActivationGuard(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMockFetch<T>(
  handler: MockFetchHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input.toString();
    const result = await handler(rawUrl, init);
    return result instanceof Response ? result : jsonResponse(result);
  }) as typeof fetch;

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function postJsonWithEnv(
  path: string,
  body: unknown,
  envOverrides: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { ...env, ...envOverrides },
  );
}

async function createPremiumToken(customerId = "cus_test"): Promise<string> {
  const kv = createMemoryKv();
  return withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_test`) {
        return { customer: customerId, subscription: "sub_trial" };
      }
      if (url === `${STRIPE_API}/subscriptions/sub_trial`) {
        return {
          id: "sub_trial",
          status: "trialing",
          trial_end: nowSeconds() + 7 * 24 * 60 * 60,
          current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
        };
      }
      if (url === `${STRIPE_API}/customers/${customerId}`) {
        return { id: customerId, email: "premium@example.com" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJsonWithEnv(
        "/verify",
        { identifier: "cs_test" },
        { ACTIVATION_KV: kv },
      );
      const data = await response.json() as { verificationToken?: string };
      assert.equal(response.status, 200);
      assert.equal(typeof data.verificationToken, "string");
      return data.verificationToken!;
    },
  );
}

test("premium worker proxies mobile-only routes to the configured Node backend", async () => {
  let proxiedUrl = "";
  let proxiedEdgeHeader = "";
  let proxiedHostHeader = "";

  await withMockFetch(
    (url, init) => {
      proxiedUrl = url;
      proxiedEdgeHeader = String(new Headers(init?.headers).get("x-vessel-edge") || "");
      proxiedHostHeader = String(new Headers(init?.headers).get("x-forwarded-host") || "");
      return { ok: true };
    },
    async () => {
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/health?probe=1`),
        { ...env, MOBILE_BACKEND_ORIGIN: "https://mobile-origin.example" },
      );
      const data = await response.json() as { ok?: boolean };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.equal(proxiedUrl, "https://mobile-origin.example/health?probe=1");
      assert.equal(proxiedEdgeHeader, "cloudflare-premium-worker");
      assert.equal(proxiedHostHeader, "premium.example");
    },
  );
});

test("premium worker rejects unsupported methods before proxying", async () => {
  let proxyCalls = 0;

  await withMockFetch(
    () => {
      proxyCalls += 1;
      return { ok: true };
    },
    async () => {
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/admin/usage`, { method: "DELETE" }),
        { ...env, MOBILE_BACKEND_ORIGIN: "https://mobile-origin.example" },
      );
      const data = await response.json() as { error?: string };

      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "GET");
      assert.match(data.error || "", /Use GET/);
      assert.equal(proxyCalls, 0);
    },
  );
});

test("premium checkout uses Stripe-configured dynamic payment methods", async () => {
  let checkoutParams: URLSearchParams | undefined;

  await withMockFetch(
    (url, init) => {
      assert.equal(url, `${STRIPE_API}/checkout/sessions`);
      checkoutParams = new URLSearchParams(String(init?.body || ""));
      return { url: "https://checkout.stripe.test/session" };
    },
    async () => {
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/checkout?email=person%40example.com`, { method: "POST" }),
        env,
      );
      const data = await response.json() as { url?: string };

      assert.equal(response.status, 200);
      assert.equal(data.url, "https://checkout.stripe.test/session");
      assert.equal(checkoutParams?.get("mode"), "subscription");
      assert.equal(checkoutParams?.get("customer_email"), "person@example.com");
      assert.equal(
        [...(checkoutParams?.keys() ?? [])].some((key) => key.startsWith("payment_method_types")),
        false,
      );
    },
  );
});

test("premium worker proxies mobile entitlement tokens while keeping desktop tokens local", async () => {
  const mobileToken = "mobile.jwt.token";
  let proxiedUrl = "";
  let proxiedBody = "";

  await withMockFetch(
    async (url, init) => {
      proxiedUrl = url;
      proxiedBody = await new Response(init?.body as BodyInit).text();
      return { status: "active", verificationToken: mobileToken };
    },
    async () => {
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/entitlement`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: mobileToken }),
        }),
        { ...env, MOBILE_BACKEND_ORIGIN: "https://mobile-origin.example" },
      );
      const data = await response.json() as { status?: string; verificationToken?: string };

      assert.equal(response.status, 200);
      assert.equal(data.status, "active");
      assert.equal(data.verificationToken, mobileToken);
      assert.equal(proxiedUrl, "https://mobile-origin.example/entitlement");
      assert.equal(proxiedBody, JSON.stringify({ identifier: mobileToken }));
    },
  );

  const desktopToken = await createPremiumToken("cus_desktop_proxy_guard");
  let didProxyDesktopToken = false;
  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/customers/cus_desktop_proxy_guard`) {
        return { id: "cus_desktop_proxy_guard", email: "premium@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_desktop_proxy_guard&status=all&limit=10`) {
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
      if (url.startsWith("https://mobile-origin.example")) {
        didProxyDesktopToken = true;
        return { status: "proxied" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/entitlement`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: desktopToken }),
        }),
        { ...env, MOBILE_BACKEND_ORIGIN: "https://mobile-origin.example" },
      );
      const data = await response.json() as { status?: string; customerId?: string };

      assert.equal(response.status, 200);
      assert.equal(data.status, "active");
      assert.equal(data.customerId, "cus_desktop_proxy_guard");
      assert.equal(didProxyDesktopToken, false);
    },
  );
});

test("premium worker proxies mobile AI bearer tokens to the Node backend", async () => {
  let proxiedUrl = "";
  let proxiedAuthorization = "";
  let proxiedBody = "";

  await withMockFetch(
    async (url, init) => {
      proxiedUrl = url;
      proxiedAuthorization = String(new Headers(init?.headers).get("authorization") || "");
      proxiedBody = await new Response(init?.body as BodyInit).text();
      return { id: "chatcmpl_mobile", choices: [] };
    },
    async () => {
      const body = { model: "vessel/default", messages: [{ role: "user", content: "hello" }] };
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/ai/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer mobile.jwt.token",
          },
          body: JSON.stringify(body),
        }),
        { ...env, MOBILE_BACKEND_ORIGIN: "https://mobile-origin.example" },
      );
      const data = await response.json() as { id?: string };

      assert.equal(response.status, 200);
      assert.equal(data.id, "chatcmpl_mobile");
      assert.equal(proxiedUrl, "https://mobile-origin.example/ai/chat/completions");
      assert.equal(proxiedAuthorization, "Bearer mobile.jwt.token");
      assert.equal(proxiedBody, JSON.stringify(body));
    },
  );
});

test("premium worker returns a clear config error for mobile-only routes without an origin", async () => {
  const response = await worker.fetch(
    new Request(`${WORKER_URL}/play/topup/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "token", packageName: "pkg", productId: "sku", purchaseToken: "purchase" }),
    }),
    env,
  );
  const data = await response.json() as { error?: string };

  assert.equal(response.status, 503);
  assert.match(data.error || "", /MOBILE_BACKEND_ORIGIN/);
});

test("premium worker verifies checkout sessions using the exact session subscription", async () => {
  const kv = createMemoryKv();
  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_test`) {
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
      const response = await postJsonWithEnv(
        "/verify",
        { identifier: "cs_test" },
        { ACTIVATION_KV: kv },
      );
      const data = await response.json() as {
        status?: string;
        customerId?: string;
        verificationToken?: string;
        email?: string;
      };

      assert.equal(response.status, 200);
      assert.equal(data.status, "trialing");
      assert.equal(data.customerId, "cus_test");
      assert.equal(data.email, "premium@example.com");
      assert.match(data.verificationToken || "", /^[^.]+\.[^.]+\.[^.]+$/);
    },
  );
});

test("premium worker rejects replayed checkout session identifiers", async () => {
  const kv = createMemoryKv();
  let checkoutSessionFetches = 0;

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/checkout/sessions/cs_replay`) {
        checkoutSessionFetches += 1;
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
      const first = await postJsonWithEnv(
        "/verify",
        { identifier: "cs_replay" },
        { ACTIVATION_KV: kv },
      );
      assert.equal(first.status, 200);

      const replay = await postJsonWithEnv(
        "/verify",
        { identifier: "cs_replay" },
        { ACTIVATION_KV: kv },
      );
      const data = await replay.json() as { error?: string };

      assert.equal(replay.status, 409);
      assert.match(data.error || "", /already been redeemed/i);
      assert.equal(checkoutSessionFetches, 1);
    },
  );
});

test("premium worker prefers an entitled subscription over a newer canceled subscription", async () => {
  const token = await createPremiumToken();

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/customers/cus_test`) {
        return { id: "cus_test", email: "premium@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_test&status=all&limit=10`) {
        return {
          data: [
            {
              id: "sub_canceled",
              status: "canceled",
              created: nowSeconds(),
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
            {
              id: "sub_active",
              status: "active",
              created: nowSeconds() - 60,
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJson("/verify", { identifier: token });
      const data = await response.json() as { status?: string };

      assert.equal(response.status, 200);
      assert.equal(data.status, "active");
    },
  );
});

test("premium worker creates billing portal sessions only for signed premium tokens", async () => {
  const invalidResponse = await postJson("/portal", { identifier: "not-a-token" });
  assert.equal(invalidResponse.status, 403);

  const token = await createPremiumToken("cus_portal");
  let portalRequestBody = "";

  await withMockFetch(
    (_url, init) => {
      assert.equal(_url, `${STRIPE_API}/billing_portal/sessions`);
      portalRequestBody = String(init?.body || "");
      return { url: "https://billing.stripe.test/session" };
    },
    async () => {
      const response = await postJson("/portal", { identifier: token });
      const data = await response.json() as { url?: string };

      assert.equal(response.status, 200);
      assert.equal(data.url, "https://billing.stripe.test/session");
      assert.match(portalRequestBody, /customer=cus_portal/);
      assert.match(
        portalRequestBody,
        /return_url=https%3A%2F%2Fpremium\.example%2Fportal-return/,
      );
    },
  );
});

test("premium worker returns entitlement metadata for signed tokens", async () => {
  const token = await createPremiumToken("cus_entitlement");

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/customers/cus_entitlement`) {
        return { id: "cus_entitlement", email: "premium@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_entitlement&status=all&limit=10`) {
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
      const response = await postJson("/entitlement", { identifier: token });
      const data = await response.json() as {
        status?: string;
        plan?: string;
        usage?: { monthlyBudgetUsd?: number; remainingBudgetUsd?: number };
      };

      assert.equal(response.status, 200);
      assert.equal(data.status, "active");
      assert.equal(data.plan, "premium");
      assert.equal(data.usage?.monthlyBudgetUsd, 5);
      assert.equal(data.usage?.remainingBudgetUsd, 5);
    },
  );
});

test("premium worker forces Vessel AI model and records successful usage", async () => {
  const kv = createMemoryKv();
  const token = await createPremiumToken("cus_ai");
  let upstreamBody = "";

  await withMockFetch(
    (url, init) => {
      if (url === `${OPENROUTER_API}/chat/completions`) {
        upstreamBody = String(init?.body || "");
        return {
          id: "gen_test",
          model: "upstream/model",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        };
      }
      if (url === `${STRIPE_API}/customers/cus_ai`) {
        return { id: "cus_ai", email: "premium@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_ai&status=all&limit=10`) {
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
      const response = await worker.fetch(
        new Request(`${WORKER_URL}/ai/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            model: "expensive/model",
            messages: [{ role: "user", content: "hello" }],
            max_tokens: 999999,
          }),
        }),
        { ...env, ACTIVATION_KV: kv, OPENROUTER_API_KEY: "sk-or-test" },
      );
      const data = await response.json() as { model?: string };
      const sent = JSON.parse(upstreamBody) as { model?: string; max_tokens?: number };

      assert.equal(response.status, 200);
      assert.equal(sent.model, "minimax/minimax-m3");
      assert.equal(sent.max_tokens, 2000);
      assert.equal(data.model, "minimax/minimax-m3");

      const entitlement = await postJsonWithEnv(
        "/entitlement",
        { identifier: token },
        { ACTIVATION_KV: kv },
      );
      const entitlementData = await entitlement.json() as {
        usage?: { requests?: number; promptTokens?: number; completionTokens?: number };
      };
      assert.equal(entitlementData.usage?.requests, 1);
      assert.equal(entitlementData.usage?.promptTokens, 1000);
      assert.equal(entitlementData.usage?.completionTokens, 500);
    },
  );
});

test("premium worker sends feedback email through Resend", async () => {
  let resendRequestBody = "";
  const kv = createMemoryKv();

  await withMockFetch(
    (url, init) => {
      assert.equal(url, "https://api.resend.com/emails");
      resendRequestBody = String(init?.body || "");
      return { id: "email_test" };
    },
    async () => {
      const response = await postJsonWithEnv(
        "/feedback",
        {
          email: "User@Example.com",
          message: "This is useful, but I found a paper cut.",
          source: "settings_account",
        },
        { ACTIVATION_KV: kv },
      );
      const data = await response.json() as { ok?: boolean };

      assert.equal(response.status, 200);
      assert.equal(data.ok, true);
      assert.match(resendRequestBody, /hello@quantaintellect\.com/);
      assert.match(resendRequestBody, /user@example\.com/);
      assert.match(resendRequestBody, /settings_account/);
      assert.match(resendRequestBody, /paper cut/);
    },
  );
});

test("premium worker validates feedback payloads before sending email", async () => {
  await withMockFetch(
    () => {
      throw new Error("Feedback validation should not call Resend");
    },
    async () => {
      const response = await postJson("/feedback", {
        email: "not-an-email",
        message: "hello",
      });
      const data = await response.json() as { error?: string };

      assert.equal(response.status, 400);
      assert.match(data.error || "", /valid reply email/i);
    },
  );
});

test("premium worker rate limits feedback before sending email", async () => {
  const kv = createMemoryKv();
  let resendCalls = 0;

  await withMockFetch(
    (url) => {
      assert.equal(url, "https://api.resend.com/emails");
      resendCalls += 1;
      return { id: `email_${resendCalls}` };
    },
    async () => {
      for (let i = 0; i < 5; i++) {
        const response = await postJsonWithEnv(
          "/feedback",
          {
            email: "user@example.com",
            message: `Feedback message ${i}`,
          },
          { ACTIVATION_KV: kv },
          { "cf-connecting-ip": "203.0.113.10" },
        );
        assert.equal(response.status, 200);
      }

      const limitedResponse = await postJsonWithEnv(
        "/feedback",
        {
          email: "user@example.com",
          message: "One too many",
        },
        { ACTIVATION_KV: kv },
        { "cf-connecting-ip": "203.0.113.10" },
      );
      const data = await limitedResponse.json() as { error?: string };

      assert.equal(limitedResponse.status, 429);
      assert.match(data.error || "", /too many feedback/i);
      assert.equal(resendCalls, 5);
    },
  );
});

test("premium worker blocks feedback when spam guard storage fails", async () => {
  let resendCalls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  const failingKv = {
    async get(): Promise<string | null> {
      throw new Error("kv unavailable");
    },
    async put(): Promise<void> {
      throw new Error("kv unavailable");
    },
  };

  try {
    await withMockFetch(
      (url) => {
        assert.equal(url, "https://api.resend.com/emails");
        resendCalls += 1;
        return { id: "email_test" };
      },
      async () => {
        const response = await postJsonWithEnv(
          "/feedback",
          {
            email: "user@example.com",
            message: "Please keep the feedback path available.",
          },
          { ACTIVATION_KV: failingKv },
          { "cf-connecting-ip": "203.0.113.10" },
        );
        const data = await response.json() as { error?: string };

        assert.equal(response.status, 503);
        assert.match(data.error || "", /feedback submission is temporarily unavailable/i);
        assert.equal(resendCalls, 0);
      },
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("activation attempt guard serializes concurrent invalid attempts", async () => {
  const values = new Map<string, unknown>();
  let transactionQueue = Promise.resolve();
  const storage = {
    transaction<T>(
      callback: (transaction: {
        get: (key: string) => Promise<unknown>;
        put: (key: string, value: unknown) => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      const result = transactionQueue.then(() =>
        callback({
          async get(key: string) {
            return values.get(key);
          },
          async put(key: string, value: unknown) {
            values.set(key, value);
          },
        })
      );
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    },
    async setAlarm() {},
    async deleteAll() {
      values.clear();
    },
  };
  const guard = new ActivationAttemptGuard({ storage });
  const request = () =>
    new Request("https://activation-guard.internal/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "invalid",
        expiresAt: Date.now() + 60_000,
      }),
    });

  const responses = await Promise.all(
    Array.from({ length: 6 }, () => guard.fetch(request())),
  );
  const results = await Promise.all(
    responses.map((response) => response.json() as Promise<{ status?: string }>),
  );

  assert.equal(results.filter((result) => result.status === "recorded").length, 5);
  assert.equal(results.filter((result) => result.status === "limited").length, 1);

  const redeemed = await guard.fetch(
    new Request("https://activation-guard.internal/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "redeem",
        expiresAt: Date.now() + 60_000,
      }),
    }),
  );
  assert.equal((await redeemed.json() as { status?: string }).status, "redeemed");
});

test("premium worker locks activation challenges after repeated invalid codes", async () => {
  const activationBindings = createActivationBindings();
  let sentCode = "";

  await withMockFetch(
    (url, init) => {
      if (url === `${STRIPE_API}/customers?email=premium%40example.com&limit=100`) {
        return { data: [{ id: "cus_test", email: "premium@example.com" }] };
      }
      if (
        url === `${STRIPE_API}/customers?limit=100` ||
        url === `${STRIPE_API}/customers/search?query=email%3A'premium%40example.com'&limit=100`
      ) {
        return { data: [] };
      }
      if (url === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body || "{}")) as { text?: string };
        sentCode = body.text?.match(/\b\d{6}\b/)?.[0] || "";
        return { id: "email_test" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const start = await postJsonWithEnv(
        "/activate/start",
        { email: "premium@example.com" },
        activationBindings,
      );
      const startData = await start.json() as { challengeToken?: string };
      assert.equal(start.status, 200);
      assert.match(sentCode, /^\d{6}$/);
      assert.equal(typeof startData.challengeToken, "string");

      const attempts = await Promise.all(
        Array.from({ length: 6 }, () => postJsonWithEnv(
          "/activate/verify",
          {
            email: "premium@example.com",
            code: "000000" === sentCode ? "111111" : "000000",
            challengeToken: startData.challengeToken,
          },
          activationBindings,
        )),
      );
      assert.equal(attempts.filter((response) => response.status === 403).length, 5);
      assert.equal(attempts.filter((response) => response.status === 429).length, 1);

      const locked = await postJsonWithEnv(
        "/activate/verify",
        {
          email: "premium@example.com",
          code: sentCode,
          challengeToken: startData.challengeToken,
        },
        activationBindings,
      );
      const lockedData = await locked.json() as { error?: string };

      assert.equal(locked.status, 429);
      assert.match(lockedData.error || "", /too many verification attempts/i);
    },
  );
});

test("premium worker verifies activation codes before the attempt limit", async () => {
  const activationBindings = createActivationBindings();
  let sentCode = "";

  await withMockFetch(
    (url, init) => {
      if (url === `${STRIPE_API}/customers?email=premium%40example.com&limit=100`) {
        return { data: [{ id: "cus_test", email: "premium@example.com" }] };
      }
      if (
        url === `${STRIPE_API}/customers?limit=100` ||
        url === `${STRIPE_API}/customers/search?query=email%3A'premium%40example.com'&limit=100`
      ) {
        return { data: [] };
      }
      if (url === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body || "{}")) as { text?: string };
        sentCode = body.text?.match(/\b\d{6}\b/)?.[0] || "";
        return { id: "email_test" };
      }
      if (url === `${STRIPE_API}/customers/cus_test`) {
        return { id: "cus_test", email: "premium@example.com" };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_test&status=all&limit=10`) {
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
      const start = await postJsonWithEnv(
        "/activate/start",
        { email: "premium@example.com" },
        activationBindings,
      );
      const startData = await start.json() as { challengeToken?: string };
      assert.equal(start.status, 200);

      const verify = await postJsonWithEnv(
        "/activate/verify",
        {
          email: "premium@example.com",
          code: sentCode,
          challengeToken: startData.challengeToken,
        },
        activationBindings,
      );
      const data = await verify.json() as {
        status?: string;
        verificationToken?: string;
      };

      assert.equal(verify.status, 200);
      assert.equal(data.status, "active");
      assert.match(data.verificationToken || "", /^[^.]+\.[^.]+\.[^.]+$/);

      const replay = await postJsonWithEnv(
        "/activate/verify",
        {
          email: "premium@example.com",
          code: sentCode,
          challengeToken: startData.challengeToken,
        },
        activationBindings,
      );
      assert.equal(replay.status, 403);
    },
  );
});

test("premium worker verifies active subscriptions for mixed-case Stripe customer emails", async () => {
  const activationBindings = createActivationBindings();
  let sentCode = "";
  const infoLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => infoLogs.push(args.map(String).join(" "));

  try {
    await withMockFetch(
      (url, init) => {
        if (url === `${STRIPE_API}/customers?email=paul.h9%40proton.me&limit=100`) {
          return { data: [] };
        }
        if (url === `${STRIPE_API}/customers?limit=100`) {
          return { data: [{ id: "cus_mixed_case", email: "Paul.H9@proton.me" }] };
        }
        if (
          url ===
          `${STRIPE_API}/customers/search?query=email%3A'paul.h9%40proton.me'&limit=100`
        ) {
          return { data: [] };
        }
        if (url === "https://api.resend.com/emails") {
          const body = JSON.parse(String(init?.body || "{}")) as { text?: string; to?: string[] };
          sentCode = body.text?.match(/\b\d{6}\b/)?.[0] || "";
          assert.deepEqual(body.to, ["paul.h9@proton.me"]);
          return { id: "email_test" };
        }
        if (url === `${STRIPE_API}/customers/cus_mixed_case`) {
          return { id: "cus_mixed_case", email: "Paul.H9@proton.me" };
        }
        if (url === `${STRIPE_API}/subscriptions?customer=cus_mixed_case&status=all&limit=10`) {
          return {
            data: [
              {
                id: "sub_mixed_case_active",
                status: "active",
                current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
              },
            ],
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const start = await postJsonWithEnv(
          "/activate/start",
          { email: "Paul.H9@proton.me" },
          activationBindings,
        );
        const startData = await start.json() as { challengeToken?: string };

        assert.equal(start.status, 200);
        assert.match(sentCode, /^\d{6}$/);
        assert.equal(typeof startData.challengeToken, "string");

        const verify = await postJsonWithEnv(
          "/activate/verify",
          {
            email: "Paul.H9@proton.me",
            code: sentCode,
            challengeToken: startData.challengeToken,
          },
          activationBindings,
        );
        const verifyData = await verify.json() as {
          status?: string;
          customerId?: string;
          verificationToken?: string;
        };

        assert.equal(verify.status, 200);
        assert.equal(verifyData.status, "active");
        assert.equal(verifyData.customerId, "cus_mixed_case");
        assert.match(verifyData.verificationToken || "", /^[^.]+\.[^.]+\.[^.]+$/);

        const logs = infoLogs.join("\n");
        assert.match(logs, /activation\.verify\.completed/);
        assert.match(logs, /sub_mixed_case_active/);
        assert.doesNotMatch(logs, /Paul\.H9@proton\.me/i);
        assert.doesNotMatch(logs, new RegExp(startData.challengeToken!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      },
    );
  } finally {
    console.info = originalInfo;
  }
});

test("premium worker reports Stripe failures without spending valid-code attempts", async () => {
  const activationBindings = createActivationBindings();
  let sentCode = "";
  let subscriptionLookups = 0;
  const errorLogs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errorLogs.push(args.map(String).join(" "));

  try {
    await withMockFetch(
      (url, init) => {
        if (url === `${STRIPE_API}/customers?email=premium%40example.com&limit=100`) {
          return { data: [{ id: "cus_retry", email: "premium@example.com" }] };
        }
        if (
          url === `${STRIPE_API}/customers?limit=100` ||
          url === `${STRIPE_API}/customers/search?query=email%3A'premium%40example.com'&limit=100`
        ) {
          return { data: [] };
        }
        if (url === "https://api.resend.com/emails") {
          const body = JSON.parse(String(init?.body || "{}")) as { text?: string };
          sentCode = body.text?.match(/\b\d{6}\b/)?.[0] || "";
          return { id: "email_test" };
        }
        if (url === `${STRIPE_API}/customers/cus_retry`) {
          return { id: "cus_retry", email: "premium@example.com" };
        }
        if (url === `${STRIPE_API}/subscriptions?customer=cus_retry&status=all&limit=10`) {
          subscriptionLookups += 1;
          if (subscriptionLookups <= 5) {
            return new Response(
              JSON.stringify({
                error: {
                  type: "api_error",
                  code: "temporary_failure",
                  message: "Do not log premium@example.com or secret diagnostic details",
                },
              }),
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  "request-id": "req_activation_retry",
                },
              },
            );
          }
          return {
            data: [
              {
                id: "sub_retry_active",
                status: "active",
                current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
              },
            ],
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const start = await postJsonWithEnv(
          "/activate/start",
          { email: "premium@example.com" },
          activationBindings,
        );
        const startData = await start.json() as { challengeToken?: string };

        for (let i = 0; i < 5; i++) {
          const failed = await postJsonWithEnv(
            "/activate/verify",
            {
              email: "premium@example.com",
              code: sentCode,
              challengeToken: startData.challengeToken,
            },
            activationBindings,
          );
          const failedData = await failed.json() as { error?: string };

          assert.equal(failed.status, 503);
          assert.match(failedData.error || "", /code was not consumed/i);
        }

        const retried = await postJsonWithEnv(
          "/activate/verify",
          {
            email: "premium@example.com",
            code: sentCode,
            challengeToken: startData.challengeToken,
          },
          activationBindings,
        );
        const retriedData = await retried.json() as { status?: string };

        assert.equal(retried.status, 200);
        assert.equal(retriedData.status, "active");
        assert.equal(subscriptionLookups, 6);

        const logs = errorLogs.join("\n");
        assert.match(logs, /req_activation_retry/);
        assert.match(logs, /temporary_failure/);
        assert.doesNotMatch(logs, /premium@example\.com/i);
        assert.doesNotMatch(logs, /secret diagnostic details/i);
      },
    );
  } finally {
    console.error = originalError;
  }
});

test("premium worker finds an active subscription on a duplicate Stripe customer", async () => {
  const activationBindings = createActivationBindings();
  let sentCode = "";

  await withMockFetch(
    (url, init) => {
      if (url === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body || "{}")) as { text?: string };
        sentCode = body.text?.match(/\b\d{6}\b/)?.[0] || "";
        return { id: "email_test" };
      }
      if (url === `${STRIPE_API}/customers/cus_new_canceled`) {
        return { id: "cus_new_canceled", email: "duplicate@example.com" };
      }
      if (
        url ===
        `${STRIPE_API}/subscriptions?customer=cus_new_canceled&status=all&limit=10`
      ) {
        return {
          data: [
            {
              id: "sub_new_canceled",
              status: "canceled",
              created: nowSeconds(),
              current_period_end: nowSeconds() - 60,
            },
          ],
        };
      }
      if (url === `${STRIPE_API}/customers?email=duplicate%40example.com&limit=100`) {
        return {
          data: [
            { id: "cus_new_canceled", email: "duplicate@example.com" },
            { id: "cus_old_active", email: "Duplicate@Example.com" },
          ],
        };
      }
      if (url === `${STRIPE_API}/customers?limit=100`) {
        return {
          data: [{ id: "cus_old_active", email: "Duplicate@Example.com" }],
        };
      }
      if (
        url ===
        `${STRIPE_API}/customers/search?query=email%3A'duplicate%40example.com'&limit=100`
      ) {
        return {
          data: [{ id: "cus_old_active", email: "Duplicate@Example.com" }],
        };
      }
      if (url === `${STRIPE_API}/customers/cus_old_active`) {
        return { id: "cus_old_active", email: "Duplicate@Example.com" };
      }
      if (
        url === `${STRIPE_API}/subscriptions?customer=cus_old_active&status=all&limit=10`
      ) {
        return {
          data: [
            {
              id: "sub_old_active",
              status: "active",
              current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            },
          ],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const start = await postJsonWithEnv(
        "/activate/start",
        { email: "duplicate@example.com" },
        activationBindings,
      );
      const startData = await start.json() as { challengeToken?: string };

      const verify = await postJsonWithEnv(
        "/activate/verify",
        {
          email: "duplicate@example.com",
          code: sentCode,
          challengeToken: startData.challengeToken,
        },
        activationBindings,
      );
      const verifyData = await verify.json() as {
        status?: string;
        customerId?: string;
      };

      assert.equal(verify.status, 200);
      assert.equal(verifyData.status, "active");
      assert.equal(verifyData.customerId, "cus_old_active");
    },
  );
});

test("premium worker selects the highest entitlement across duplicate Stripe customers", async () => {
  const activationBindings = createActivationBindings();
  const customerEnv = {
    ...activationBindings,
    STRIPE_STARTER_PRICE_ID: "price_starter",
    STRIPE_PRO_PRICE_ID: "price_pro",
  };
  let sentCode = "";
  const customers = [
    { id: "cus_new_starter", email: "tiers@example.com" },
    { id: "cus_old_pro", email: "Tiers@Example.com" },
  ];

  await withMockFetch(
    (url, init) => {
      if (url === `${STRIPE_API}/customers?email=tiers%40example.com&limit=100`) {
        return { data: customers };
      }
      if (url === `${STRIPE_API}/customers?limit=100`) {
        return { data: customers };
      }
      if (
        url === `${STRIPE_API}/customers/search?query=email%3A'tiers%40example.com'&limit=100`
      ) {
        return { data: customers };
      }
      if (url === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body || "{}")) as { text?: string };
        sentCode = body.text?.match(/\b\d{6}\b/)?.[0] || "";
        return { id: "email_test" };
      }
      if (
        url === `${STRIPE_API}/subscriptions?customer=cus_new_starter&status=all&limit=10`
      ) {
        return {
          data: [{
            id: "sub_starter",
            status: "active",
            current_period_end: nowSeconds() + 30 * 24 * 60 * 60,
            items: { data: [{ price: { id: "price_starter" } }] },
          }],
        };
      }
      if (url === `${STRIPE_API}/subscriptions?customer=cus_old_pro&status=all&limit=10`) {
        return {
          data: [{
            id: "sub_pro",
            status: "active",
            current_period_end: nowSeconds() + 20 * 24 * 60 * 60,
            items: { data: [{ price: { id: "price_pro" } }] },
          }],
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const start = await postJsonWithEnv(
        "/activate/start",
        { email: "tiers@example.com" },
        customerEnv,
      );
      const startData = await start.json() as { challengeToken?: string };

      const verify = await postJsonWithEnv(
        "/activate/verify",
        {
          email: "tiers@example.com",
          code: sentCode,
          challengeToken: startData.challengeToken,
        },
        customerEnv,
      );
      const verifyData = await verify.json() as {
        status?: string;
        customerId?: string;
        plan?: string;
      };

      assert.equal(verify.status, 200);
      assert.equal(verifyData.status, "active");
      assert.equal(verifyData.customerId, "cus_old_pro");
      assert.equal(verifyData.plan, "pro");
    },
  );
});

test("premium worker falls back to Stripe Search for older mixed-case customers", async () => {
  const activationBindings = createActivationBindings();
  let searchCalls = 0;

  await withMockFetch(
    (url) => {
      if (url === `${STRIPE_API}/customers?email=older%40example.com&limit=100`) {
        return { data: [] };
      }
      if (url === `${STRIPE_API}/customers?limit=100`) {
        return { data: [] };
      }
      if (url === `${STRIPE_API}/customers/search?query=email%3A'older%40example.com'&limit=100`) {
        searchCalls += 1;
        return { data: [{ id: "cus_older", email: "Older@example.com" }] };
      }
      if (url === "https://api.resend.com/emails") {
        return { id: "email_test" };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    async () => {
      const response = await postJsonWithEnv(
        "/activate/start",
        { email: "Older@example.com" },
        activationBindings,
      );

      assert.equal(response.status, 200);
      assert.equal(searchCalls, 1);
    },
  );
});
