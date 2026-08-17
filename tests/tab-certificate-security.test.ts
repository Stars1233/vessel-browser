import assert from "node:assert/strict";
import test from "node:test";
import { Tab } from "../src/main/tabs/tab";

type MockWebContents = Electron.WebContents & {
  _emit: (event: string, ...args: unknown[]) => void;
  _loadedUrls: string[];
};

test("subresource certificate errors cannot create a top-level proceed action", () => {
  const tab = new Tab("cert-subresource", "https://start.example", () => undefined);
  const webContents = tab.view.webContents as MockWebContents;
  let prevented = false;
  const decisions: boolean[] = [];
  try {
    webContents._emit(
      "certificate-error",
      { preventDefault: () => { prevented = true; } },
      "https://cdn.example/script.js",
      "ERR_CERT_AUTHORITY_INVALID",
      { fingerprint: "AA" },
      (value: boolean) => decisions.push(value),
      false,
    );
    assert.equal(prevented, false);
    assert.equal(tab.securityState.status, "none");
    tab.proceedAnyway();
    assert.deepEqual(decisions, []);
  } finally {
    tab.dispose();
  }
});

test("main-frame certificate approval resolves only the pending request without reloading", () => {
  const tab = new Tab("cert-main", "https://start.example", () => undefined);
  const webContents = tab.view.webContents as MockWebContents;
  const decisions: boolean[] = [];
  const initialLoads = webContents._loadedUrls.length;
  try {
    webContents._emit(
      "certificate-error",
      { preventDefault: () => undefined },
      "https://expired.example/",
      "ERR_CERT_DATE_INVALID",
      { fingerprint: "BB" },
      (value: boolean) => decisions.push(value),
      true,
    );
    assert.equal(tab.securityState.status, "error");
    tab.proceedAnyway();
    assert.deepEqual(decisions, [true]);
    assert.equal(webContents._loadedUrls.length, initialLoads);
    tab.proceedAnyway();
    assert.deepEqual(decisions, [true]);
  } finally {
    tab.dispose();
  }
});
