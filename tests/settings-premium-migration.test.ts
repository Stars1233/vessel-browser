import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { app, safeStorage } from "electron";

test("legacy plaintext Premium tokens migrate before settings JSON is redacted", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-premium-migration-"));
  const mutableApp = app as unknown as { getPath: (name: string) => string };
  const originalGetPath = mutableApp.getPath;
  mutableApp.getPath = () => userDataPath;
  const settingsPath = path.join(userDataPath, "vessel-settings.json");
  const tokenPath = path.join(userDataPath, "vessel-premium-token");

  try {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        premium: {
          status: "active",
          customerId: "cus_legacy",
          verificationToken: "legacy-signed-token",
          email: "premium@example.com",
          validatedAt: new Date().toISOString(),
          expiresAt: "",
        },
      }),
      "utf-8",
    );

    const settingsModule = await import("../src/main/config/settings");
    assert.equal(
      settingsModule.loadSettings().premium.verificationToken,
      "legacy-signed-token",
    );

    const stored = JSON.parse(
      safeStorage.decryptString(fs.readFileSync(tokenPath)),
    ) as { version: number; verificationToken: string };
    assert.deepEqual(stored, { version: 1, verificationToken: "legacy-signed-token" });

    await settingsModule.flushPersist();
    const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
      premium: { verificationToken: string };
    };
    assert.equal(persisted.premium.verificationToken, "");
  } finally {
    mutableApp.getPath = originalGetPath;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
