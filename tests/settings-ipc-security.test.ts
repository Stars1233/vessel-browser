import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ipcMain } from "electron";

import {
  flushPersist,
  getSettingsPath,
  setSetting,
} from "../src/main/config/settings";
import {
  normalizeProviderEndpointOrigin,
  resolveProviderSecretForLoad,
} from "../src/main/config/provider-secrets";
import { registerSettingsHandlers } from "../src/main/ipc/settings";
import { registerTrustedIpcSender } from "../src/main/ipc/common";
import { isPremium, resetPremium } from "../src/main/premium/manager";
import { Channels } from "../src/shared/channels";
import { resolveProviderBaseUrl } from "../src/shared/providers";
import type { PremiumState } from "../src/shared/types";

function registerSettingsIpcForTest() {
  const webContents = {
    id: 9001,
    getURL: () => "file:///app/index.html",
    isDestroyed: () => false,
    once: () => undefined,
    send: () => undefined,
  };
  registerTrustedIpcSender(webContents as never, () => true);

  registerSettingsHandlers(
    {} as never,
    {
      setApprovalMode: () => undefined,
    } as never,
    () => undefined,
    () => null,
  );

  const handler = ipcMain._handlers.get(Channels.SETTINGS_SET);
  assert.equal(typeof handler, "function");

  return {
    handler,
    event: { sender: webContents, senderFrame: { url: webContents.getURL() } },
  };
}

const forgedPremiumState: PremiumState = {
  status: "active",
  customerId: "cus_forged",
  verificationToken: "token_forged",
  email: "premium@example.com",
  validatedAt: new Date().toISOString(),
  expiresAt: "",
};

test("renderer settings IPC cannot mutate premium entitlement state", async () => {
  const { handler, event } = registerSettingsIpcForTest();

  try {
    setSetting("premium", {
      status: "free",
      customerId: "",
      verificationToken: "",
      email: "",
      validatedAt: "",
      expiresAt: "",
    });

    await assert.rejects(
      () => handler(event, "premium", forgedPremiumState),
      /Unknown setting key/,
    );

    assert.equal(isPremium(), false);
  } finally {
    setSetting("premium", {
      status: "free",
      customerId: "",
      verificationToken: "",
      email: "",
      validatedAt: "",
      expiresAt: "",
    });
    await flushPersist();
  }
});

test("renderer settings IPC still accepts normal user settings", async () => {
  const { handler, event } = registerSettingsIpcForTest();

  try {
    const result = await handler(event, "telemetryEnabled", false);
    assert.equal(result.telemetryEnabled, false);
  } finally {
    setSetting("telemetryEnabled", true);
    await flushPersist();
  }
});

test("premium reset is durable when its promise resolves", async () => {
  setSetting("premium", {
    status: "active",
    customerId: "cus_persisted",
    verificationToken: "token_persisted",
    email: "premium@example.com",
    validatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await flushPersist();

  const state = await resetPremium();
  const persisted = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8")) as {
    premium: PremiumState;
  };

  assert.equal(state.status, "free");
  assert.equal(persisted.premium.status, "free");
  assert.equal(persisted.premium.verificationToken, "");
});

test("renderer settings IPC validates supported history retention periods", async () => {
  const { handler, event } = registerSettingsIpcForTest();
  setSetting("telemetryEnabled", false);

  try {
    const result = await handler(event, "historyRetentionDays", 90);
    assert.equal(result.historyRetentionDays, 90);
    await assert.rejects(
      () => handler(event, "historyRetentionDays", 45),
      /Invalid historyRetentionDays value/,
    );
  } finally {
    setSetting("historyRetentionDays", 90);
    setSetting("telemetryEnabled", true);
    await flushPersist();
  }
});

test("stored provider keys remain bound to their endpoint origin", async () => {
  const { handler, event } = registerSettingsIpcForTest();
  setSetting("telemetryEnabled", false);
  try {
    const initial = await handler(event, "chatProvider", {
      id: "custom",
      apiKey: "endpoint-secret",
      model: "local-model",
      baseUrl: "http://localhost:8080/v1",
    });
    assert.equal(initial.chatProvider.hasApiKey, true);

    const sameOrigin = await handler(event, "chatProvider", {
      id: "custom",
      apiKey: "",
      hasApiKey: true,
      model: "local-model",
      baseUrl: "http://localhost:8080/alternate-path",
    });
    assert.equal(sameOrigin.chatProvider.hasApiKey, true);

    await assert.rejects(
      () =>
        handler(event, "chatProvider", {
          id: "custom",
          apiKey: "",
          hasApiKey: true,
          model: "local-model",
          baseUrl: "http://localhost:9090/v1",
        }),
      /Re-enter the API key/,
    );
    assert.throws(
      () =>
        normalizeProviderEndpointOrigin({
          id: "custom",
          baseUrl: "http://provider.example/v1",
        }),
      /must use HTTPS/,
    );
  } finally {
    setSetting("chatProvider", null);
    setSetting("telemetryEnabled", true);
    await flushPersist();
  }
});

test("unsafe legacy providers are quarantined without throwing away other settings", () => {
  const result = resolveProviderSecretForLoad(
    {
      id: "custom",
      apiKey: "legacy-secret",
      model: "legacy-model",
      baseUrl: "http://provider.example/v1",
    },
    {
      providerId: "custom",
      apiKey: "stored-secret",
    },
  );

  assert.equal(result.provider, null);
  assert.match(result.issue ?? "", /must use HTTPS/);
  assert.equal(result.secretToPersist, undefined);
});

test("provider requests and secret binding share one endpoint resolver", () => {
  assert.equal(resolveProviderBaseUrl({ id: "anthropic" }), "https://api.anthropic.com");
  assert.equal(resolveProviderBaseUrl({ id: "openai" }), "https://api.openai.com/v1");
  assert.equal(
    resolveProviderBaseUrl({ id: "openai_codex" }),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(normalizeProviderEndpointOrigin({ id: "openai" }), "https://api.openai.com");
});
