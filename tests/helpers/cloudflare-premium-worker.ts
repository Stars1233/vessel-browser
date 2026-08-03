import assert from "node:assert/strict";

import worker, {
  ActivationAttemptGuard,
} from "../../scripts/cloudflare-worker/vessel-premium-api.js";

export const STRIPE_API = "https://api.stripe.com/v1";
export const OPENROUTER_API = "https://openrouter.ai/api/v1";
export const WORKER_URL = "https://premium.example";
export const nowSeconds = () => Math.floor(Date.now() / 1000);

type MockFetchHandler = (
  url: string,
  init?: RequestInit,
) => unknown | Promise<unknown>;

export const env = {
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_ID: "price_test",
  PREMIUM_TOKEN_SECRET: "test-secret",
  RESEND_API_KEY: "re_test",
  PREMIUM_FROM_EMAIL: "Vessel <premium@example.com>",
  FEEDBACK_TO_EMAIL: "hello@quantaintellect.com",
};

export function createMemoryKv(): {
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

export function createMemorySecurityGuard(): {
  getByName: (name: string) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
} {
  const guards = new Map<string, ActivationAttemptGuard>();
  const queues = new Map<string, Promise<void>>();

  return {
    getByName(name: string) {
      let guard = guards.get(name);
      if (!guard) {
        const values = new Map<string, unknown>();
        const storage = {
          transaction<T>(callback: (transaction: {
            get: (key: string) => Promise<unknown>;
            put: (key: string, value: unknown) => Promise<void>;
          }) => Promise<T>): Promise<T> {
            const result = (queues.get(name) || Promise.resolve()).then(() =>
              callback({
                async get(key: string) { return values.get(key); },
                async put(key: string, value: unknown) { values.set(key, value); },
              }),
            );
            queues.set(name, result.then(() => undefined, () => undefined));
            return result;
          },
          async setAlarm() {},
          async deleteAll() { values.clear(); },
        };
        guard = new ActivationAttemptGuard({ storage });
        guards.set(name, guard);
      }
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          return guard!.fetch(new Request(input, init));
        },
      };
    },
  };
}

export function createActivationBindings() {
  return {
    ACTIVATION_KV: createMemoryKv(),
    ACTIVATION_GUARD: createMemorySecurityGuard(),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function withMockFetch<T>(
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

export async function postJson(path: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

export async function postJsonWithEnv(
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

export async function createPremiumToken(customerId = "cus_test"): Promise<string> {
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

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

export async function createSignedPremiumToken(
  payload: Record<string, unknown>,
): Promise<string> {
  const header = base64Url(JSON.stringify({
    alg: "HS256",
    typ: "JWT",
    purpose: "premium-access",
  }));
  const body = base64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.PREMIUM_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

export async function usageKey(subject: string): Promise<string> {
  const normalized = subject.trim().toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hash = Buffer.from(digest).toString("hex");
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `ai-usage:${period}:${hash}`;
}
