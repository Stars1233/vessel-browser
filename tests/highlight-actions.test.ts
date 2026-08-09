import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { app, ipcMain } from "electron";

import { handleClearHighlights } from "../src/main/ai/page-actions/handlers/highlights";
import * as highlightsManager from "../src/main/highlights/manager";
import type { ActionContext } from "../src/main/ai/page-actions/core";
import { registerHighlightHandlers } from "../src/main/ipc/highlights";
import { registerTrustedIpcSender } from "../src/main/ipc/common";
import { Channels } from "../src/shared/channels";

test("browser-agent clear_highlights removes persisted highlights for the current page", async () => {
  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, "vessel-highlights.json"),
    JSON.stringify({ highlights: [] }),
  );

  const url = "https://news.ycombinator.com/item?id=123#comments";
  const normalizedUrl = highlightsManager.normalizeUrl(url);
  highlightsManager.clearHighlightsForUrl(normalizedUrl);

  highlightsManager.addHighlight(
    normalizedUrl,
    undefined,
    "MAI-Code-1-Flash",
    "important story",
    "green",
    "agent",
  );

  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 1);

  const ctx = {
    tabManager: {
      getActiveTab: () => ({
        view: {
          webContents: {
            getURL: () => url,
            executeJavaScript: async () => "Cleared 1 highlight",
          },
        },
      }),
    },
  } as unknown as ActionContext;

  const result = await handleClearHighlights(ctx);

  assert.equal(result, "Cleared 1 highlight");
  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 0);
});

test("sidebar highlight clear-all IPC removes persisted highlights for the current page", async () => {
  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, "vessel-highlights.json"),
    JSON.stringify({ highlights: [] }),
  );

  const url = "https://news.ycombinator.com/#top";
  const normalizedUrl = highlightsManager.normalizeUrl(url);
  highlightsManager.clearHighlightsForUrl(normalizedUrl);
  highlightsManager.addHighlight(
    normalizedUrl,
    undefined,
    "Treating pancreatic tumours may have revealed cancer's machinery",
    "important story",
    "green",
    "agent",
  );
  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 1);

  const webContents = {
    id: 4242,
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    executeJavaScript: async (script: string) => (script.includes("return true") ? true : 0),
    once: () => undefined,
    send: () => undefined,
  };
  registerTrustedIpcSender(webContents as never, () => true);

  const windowState = {
    tabManager: {
      getActiveTab: () => ({
        view: { webContents },
      }),
      onHighlightCapture: () => undefined,
    },
    chromeView: {
      webContents: {
        isDestroyed: () => false,
        send: () => undefined,
      },
    },
  };
  registerHighlightHandlers(windowState as never, () => undefined);

  const handler = ipcMain._handlers.get(Channels.HIGHLIGHT_NAV_CLEAR);
  assert.equal(typeof handler, "function");

  const result = await handler({ sender: webContents, senderFrame: { url } });

  assert.equal(result, true);
  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 0);
});

test("sidebar highlight remove-current IPC removes the matching persisted highlight", async () => {
  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, "vessel-highlights.json"),
    JSON.stringify({ highlights: [] }),
  );

  const url = "https://news.ycombinator.com/#top";
  const normalizedUrl = highlightsManager.normalizeUrl(url);
  const text = "MAI-Code-1-Flash";
  highlightsManager.clearHighlightsForUrl(normalizedUrl);
  highlightsManager.addHighlight(
    normalizedUrl,
    undefined,
    text,
    "important story",
    "green",
    "agent",
  );
  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 1);

  const webContents = {
    id: 4343,
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    executeJavaScript: async (script: string) => {
      if (script.includes("data-vessel-highlight-text")) return text;
      if (script.includes("return true")) return true;
      return 0;
    },
    once: () => undefined,
    send: () => undefined,
  };
  registerTrustedIpcSender(webContents as never, () => true);

  const windowState = {
    tabManager: {
      getActiveTab: () => ({
        view: { webContents },
      }),
      onHighlightCapture: () => undefined,
    },
    chromeView: {
      webContents: {
        isDestroyed: () => false,
        send: () => undefined,
      },
    },
  };
  registerHighlightHandlers(windowState as never, () => undefined);

  const handler = ipcMain._handlers.get(Channels.HIGHLIGHT_NAV_REMOVE);
  assert.equal(typeof handler, "function");

  const result = await handler({ sender: webContents, senderFrame: { url } }, 0);

  assert.equal(result, true);
  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 0);
});
