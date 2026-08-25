import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { app, safeStorage } from "electron";

test("failed Premium token migration preserves the only usable legacy copy", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-premium-failed-migration-"));
  const mutableApp = app as unknown as { getPath: (name: string) => string };
  const mutableSafeStorage = safeStorage as typeof safeStorage & {
    __setEncryptionAvailable: (value: boolean) => void;
  };
  const originalGetPath = mutableApp.getPath;
  mutableApp.getPath = () => userDataPath;
  mutableSafeStorage.__setEncryptionAvailable(false);
  const settingsPath = path.join(userDataPath, "vessel-settings.json");

  try {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        premium: {
          status: "active",
          customerId: "cus_legacy",
          verificationToken: "only-legacy-token",
          email: "premium@example.com",
          validatedAt: new Date().toISOString(),
          expiresAt: "",
        },
      }),
      "utf-8",
    );

    const settingsModule = await import("../src/main/config/settings");
    assert.equal(settingsModule.loadSettings().premium.verificationToken, "only-legacy-token");
    assert.ok(
      settingsModule.getSettingsLoadIssues().some(
        (issue) => issue.code === "settings-premium-token-migration-failed",
      ),
    );

    settingsModule.setSetting("theme", "light");
    await settingsModule.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      premium: { verificationToken: string };
    };
    assert.equal(persisted.premium.verificationToken, "only-legacy-token");
  } finally {
    mutableSafeStorage.__setEncryptionAvailable(true);
    mutableApp.getPath = originalGetPath;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
