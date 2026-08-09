import assert from "node:assert/strict";
import test from "node:test";
import { BaseWindow } from "electron";

import { TabManager } from "../src/main/tabs/tab-manager";
import type { SessionSnapshot } from "../src/shared/types";

type TrackedWebContents = Electron.WebContents & { _loadedUrls: string[] };

test("restored background tabs load once when first activated", () => {
  const manager = new TabManager(new BaseWindow(), () => undefined);
  const snapshot: SessionSnapshot = {
    tabs: [
      { id: "first", url: "https://first.example", title: "First" },
      { id: "active", url: "https://active.example", title: "Active" },
      { id: "last", url: "https://last.example", title: "Last" },
    ],
    activeIndex: 1,
    capturedAt: new Date(0).toISOString(),
  };

  try {
    const ids = manager.restoreSession(snapshot);
    const states = manager.getAllStates();
    assert.deepEqual(
      states.map(({ url, title }) => ({ url, title })),
      snapshot.tabs.map(({ url, title }) => ({ url, title })),
    );

    const first = manager.getTab(ids[0]);
    const active = manager.getTab(ids[1]);
    const last = manager.getTab(ids[2]);
    assert.ok(first && active && last);
    assert.deepEqual((first.view.webContents as TrackedWebContents)._loadedUrls, []);
    assert.deepEqual((active.view.webContents as TrackedWebContents)._loadedUrls, [
      "https://active.example",
    ]);
    assert.deepEqual((last.view.webContents as TrackedWebContents)._loadedUrls, []);

    assert.equal(manager.navigateTab(ids[2], "https://replacement.example"), null);
    manager.switchTab(ids[2]);
    assert.deepEqual((last.view.webContents as TrackedWebContents)._loadedUrls, [
      "https://replacement.example",
    ]);

    manager.switchTab(ids[0]);
    manager.switchTab(ids[1]);
    manager.switchTab(ids[0]);
    assert.deepEqual((first.view.webContents as TrackedWebContents)._loadedUrls, [
      "https://first.example",
    ]);
  } finally {
    manager.destroyAllTabs();
  }
});

test("ordinary background tabs still begin loading immediately", () => {
  const manager = new TabManager(new BaseWindow(), () => undefined);

  try {
    const id = manager.createTab("https://background.example", { background: true });
    const tab = manager.getTab(id);
    assert.ok(tab);
    assert.deepEqual((tab.view.webContents as TrackedWebContents)._loadedUrls, [
      "https://background.example",
    ]);
  } finally {
    manager.destroyAllTabs();
  }
});
