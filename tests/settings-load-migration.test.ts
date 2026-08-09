import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { app } from "electron";

test("unsafe legacy provider settings do not reset unrelated preferences", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-settings-migration-"));
  const mutableApp = app as unknown as { getPath: (name: string) => string };
  const originalGetPath = mutableApp.getPath;
  mutableApp.getPath = () => userDataPath;

  try {
    fs.writeFileSync(
      path.join(userDataPath, "vessel-settings.json"),
      JSON.stringify({
        theme: "light",
        telemetryEnabled: false,
        historyRetentionDays: 365,
        chatProvider: {
          id: "custom",
          apiKey: "legacy-secret",
          model: "legacy-model",
          baseUrl: "http://provider.example/v1",
        },
      }),
    );

    const moduleUrl = new URL("../src/main/config/settings.ts", import.meta.url);
    moduleUrl.searchParams.set("migration-test", String(Date.now()));
    const { getSettingsLoadIssues, loadSettings } = await import(moduleUrl.href);
    const loaded = loadSettings();

    assert.equal(loaded.theme, "light");
    assert.equal(loaded.telemetryEnabled, false);
    assert.equal(loaded.historyRetentionDays, 365);
    assert.equal(loaded.chatProvider, null);
    assert.ok(
      getSettingsLoadIssues().some(
        (issue) => issue.code === "settings-invalid-chat-provider-endpoint",
      ),
    );
  } finally {
    mutableApp.getPath = originalGetPath;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
