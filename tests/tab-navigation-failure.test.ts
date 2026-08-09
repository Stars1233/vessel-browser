import assert from "node:assert/strict";
import test from "node:test";

import { Tab } from "../src/main/tabs/tab";

test("main-frame navigation failures show an escaped retry page", () => {
  const tab = new Tab("failed-tab", "https://start.example", () => undefined);
  const webContents = tab.view.webContents as typeof tab.view.webContents & {
    _emit: (event: string, ...args: unknown[]) => void;
    _loadedUrls: string[];
  };
  const failedUrl = "https://unreachable.example/path?value=<unsafe>&next=1";

  try {
    webContents._emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED <unsafe>", failedUrl, true);

    assert.equal(tab.state.url, failedUrl);
    assert.equal(tab.state.title, "Page unavailable");
    assert.equal(tab.state.isLoading, false);

    const dataUrl = webContents._loadedUrls.at(-1);
    assert.ok(dataUrl?.startsWith("data:text/html;charset=utf-8,"));
    const html = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1));
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /ERR_NAME_NOT_RESOLVED &lt;unsafe&gt;/);
    assert.match(
      html,
      /href="https:\/\/unreachable\.example\/path\?value=&lt;unsafe&gt;&amp;next=1"/,
    );

    webContents._emit("did-navigate", {}, dataUrl);
    assert.equal(tab.state.url, failedUrl);

    tab.reload();
    assert.equal(webContents._loadedUrls.at(-1), failedUrl);
  } finally {
    tab.dispose();
  }
});

test("subframe failures and aborted navigations do not replace the page", () => {
  const tab = new Tab("healthy-tab", "https://start.example", () => undefined);
  const webContents = tab.view.webContents as typeof tab.view.webContents & {
    _emit: (event: string, ...args: unknown[]) => void;
    _loadedUrls: string[];
  };

  try {
    const initialLoadCount = webContents._loadedUrls.length;
    webContents._emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://frame.example",
      false,
    );
    webContents._emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://start.example", true);

    assert.equal(webContents._loadedUrls.length, initialLoadCount);
    assert.equal(tab.state.title, "New Tab");
  } finally {
    tab.dispose();
  }
});
