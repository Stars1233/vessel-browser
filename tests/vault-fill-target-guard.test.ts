import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createVaultFillTargetGuard } from "../src/main/mcp/tools/vault";

function createHarness(initialUrl = "https://accounts.example/login") {
  const events = new EventEmitter();
  let currentUrl = initialUrl;
  let destroyed = false;
  const executedScripts: string[] = [];
  let mainFrame = {
    isDestroyed: () => false,
    detached: false,
    executeJavaScript: async (script: string) => {
      executedScripts.push(script);
      return "executed";
    },
  };
  const webContents = Object.assign(events, {
    id: 42,
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    get mainFrame() { return mainFrame; },
  });
  const tab = {
    state: { url: initialUrl },
    view: { webContents },
  };
  let activeTab: unknown = tab;
  const tabManager = { getActiveTab: () => activeTab };

  return {
    tab,
    tabManager,
    webContents,
    executedScripts,
    setUrl: (url: string) => { currentUrl = url; },
    navigate: (url: string) => {
      currentUrl = url;
      events.emit("did-start-navigation", {}, url, false, true);
      mainFrame = {
        isDestroyed: () => false,
        detached: false,
        executeJavaScript: async (script: string) => {
          executedScripts.push(`replacement:${script}`);
          return "replacement";
        },
      };
    },
    setDestroyed: () => { destroyed = true; },
    switchTab: () => { activeTab = { state: { url: currentUrl } }; },
  };
}

test("vault fill target guard accepts the unchanged active document", async () => {
  const harness = createHarness();
  const guard = createVaultFillTargetGuard(harness.tabManager as never, harness.tab as never);

  const result = await guard.runAfterApproval(async () => true, async () => "ok");
  assert.deepEqual(result, { status: "completed", value: "ok" });
});

test("vault fill target guard rejects cross-origin navigation during consent", async () => {
  const harness = createHarness();
  const guard = createVaultFillTargetGuard(harness.tabManager as never, harness.tab as never);

  const result = await guard.runAfterApproval(
    async () => {
      harness.setUrl("https://attacker.example/phish");
      return true;
    },
    async () => "not reached",
  );
  assert.equal(result.status, "changed");
});

test("vault fill target guard rejects reloads even when the URL is unchanged", async () => {
  const harness = createHarness();
  const guard = createVaultFillTargetGuard(harness.tabManager as never, harness.tab as never);

  const result = await guard.runAfterApproval(
    async () => {
      harness.webContents.emit("did-start-navigation", {}, harness.webContents.getURL(), false, true);
      return true;
    },
    async () => "not reached",
  );
  assert.equal(result.status, "changed");
});

test("vault fill target guard rejects tab switches and destroyed contents", async () => {
  const switched = createHarness();
  const switchedGuard = createVaultFillTargetGuard(switched.tabManager as never, switched.tab as never);
  const switchedResult = await switchedGuard.runAfterApproval(
    async () => { switched.switchTab(); return true; },
    async () => "not reached",
  );
  assert.equal(switchedResult.status, "changed");

  const destroyed = createHarness();
  const destroyedGuard = createVaultFillTargetGuard(destroyed.tabManager as never, destroyed.tab as never);
  const destroyedResult = await destroyedGuard.runAfterApproval(
    async () => { destroyed.setDestroyed(); return true; },
    async () => "not reached",
  );
  assert.equal(destroyedResult.status, "changed");
});

test("vault fill target guard keeps execution bound to the approved document", async () => {
  const harness = createHarness();
  const guard = createVaultFillTargetGuard(harness.tabManager as never, harness.tab as never);

  const result = await guard.runAfterApproval(
    async () => true,
    async (target) => {
      harness.navigate("https://attacker.example/phish");
      return target.executeJavaScript("secret-fill");
    },
  );

  assert.equal(result.status, "changed");
  assert.deepEqual(harness.executedScripts, []);
});

test("vault fill target guard runs legitimate work on the captured frame", async () => {
  const harness = createHarness();
  const guard = createVaultFillTargetGuard(harness.tabManager as never, harness.tab as never);

  const result = await guard.runAfterApproval(
    async () => true,
    (target) => target.executeJavaScript("legitimate-fill"),
  );

  assert.deepEqual(result, { status: "completed", value: "executed" });
  assert.deepEqual(harness.executedScripts, ["legitimate-fill"]);
});
