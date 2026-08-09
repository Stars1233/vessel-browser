import assert from "node:assert/strict";
import test from "node:test";
import { ipcMain } from "electron";

import { registerTrustedIpcSender } from "../src/main/ipc/common";
import { registerTabHandlers } from "../src/main/ipc/tabs";
import { Channels } from "../src/shared/channels";

function registerTabsIpcForTest() {
  const webContents = {
    id: 9101,
    getURL: () => "file:///app/index.html",
    isDestroyed: () => false,
    once: () => undefined,
    send: () => undefined,
  };
  registerTrustedIpcSender(webContents as never, () => true);

  const calls = {
    navigate: [] as Array<{
      id: string;
      url: string;
      postBody?: Record<string, string>;
    }>,
    colors: [] as Array<{ groupId: string; color: string }>,
  };

  const tabManager = {
    createTab: () => "tab-created",
    closeTab: () => undefined,
    switchTab: () => undefined,
    navigateTab: (id: string, url: string, postBody?: Record<string, string>) => {
      calls.navigate.push({ id, url, postBody });
    },
    goBack: () => undefined,
    goForward: () => undefined,
    reloadTab: () => undefined,
    getTab: () => null,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    zoomReset: () => undefined,
    reopenClosedTab: () => null,
    duplicateTab: () => null,
    pinTab: () => undefined,
    unpinTab: () => undefined,
    createGroupFromTab: () => "group-created",
    assignTabToGroup: () => undefined,
    removeTabFromGroup: () => undefined,
    toggleGroupCollapsed: () => null,
    setGroupColor: (groupId: string, color: string) => {
      calls.colors.push({ groupId, color });
    },
    toggleMuted: () => null,
    printTab: () => undefined,
    saveTabAsPdf: () => null,
    getAllStates: () => [],
    getActiveTabId: () => "",
    getActiveTab: () => null,
    findTabByWebContentsId: () => null,
  };

  registerTabHandlers(
    {
      tabManager,
      mainWindow: {
        getContentSize: () => [1280, 800],
      },
      chromeView: {
        webContents: {
          isDestroyed: () => false,
          send: () => undefined,
        },
      },
      uiState: {
        focusMode: false,
        sidebarPanelMode: "closed",
        sidebarWidth: 400,
        settingsOpen: false,
        devtoolsPanelMode: "closed",
        devtoolsPanelHeight: 250,
      },
      sidebarView: { setBounds: () => undefined },
      devtoolsPanelView: { setBounds: () => undefined },
    } as never,
    () => undefined,
  );

  return {
    calls,
    event: { sender: webContents, senderFrame: { url: webContents.getURL() } },
  };
}

test("tab navigation IPC rejects non-string post body values", async () => {
  const { calls, event } = registerTabsIpcForTest();
  const handler = ipcMain._handlers.get(Channels.TAB_NAVIGATE);
  assert.equal(typeof handler, "function");

  assert.throws(
    () => handler(event, "tab-1", "https://example.com", { ok: 1 }),
    /Invalid postBody/,
  );
  assert.deepEqual(calls.navigate, []);

  await handler(event, "tab-1", "https://example.com", { ok: "1" });
  assert.deepEqual(calls.navigate, [
    {
      id: "tab-1",
      url: "https://example.com",
      postBody: { ok: "1" },
    },
  ]);
});

test("tab group color IPC rejects colors outside the shared palette", async () => {
  const { calls, event } = registerTabsIpcForTest();
  const handler = ipcMain._handlers.get(Channels.TAB_GROUP_SET_COLOR);
  assert.equal(typeof handler, "function");

  assert.throws(
    () => handler(event, "group-1", "chartreuse"),
    /Invalid color: Invalid tab group color/,
  );
  assert.deepEqual(calls.colors, []);

  await handler(event, "group-1", "purple");
  assert.deepEqual(calls.colors, [{ groupId: "group-1", color: "purple" }]);
});
