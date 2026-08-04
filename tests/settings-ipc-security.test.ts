import assert from "node:assert/strict";
import test from "node:test";
import { ipcMain } from "electron";

import { flushPersist, setSetting } from "../src/main/config/settings";
import { registerSettingsHandlers } from "../src/main/ipc/settings";
import { registerTrustedIpcSender } from "../src/main/ipc/common";
import { isPremium } from "../src/main/premium/manager";
import { Channels } from "../src/shared/channels";
import type { PremiumState } from "../src/shared/types";

function registerSettingsIpcForTest() {
  const webContents = {
    id: 9001,
    isDestroyed: () => false,
    once: () => undefined,
    send: () => undefined,
  };
  registerTrustedIpcSender(webContents as never);

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
    event: { sender: webContents },
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
