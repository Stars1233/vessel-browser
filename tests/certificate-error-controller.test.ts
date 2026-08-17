import assert from "node:assert/strict";
import test from "node:test";
import { CertificateErrorController } from "../src/main/tabs/certificate-error-controller";

test("certificate approval is single-use and bound to the exact main-frame error", () => {
  const controller = new CertificateErrorController();
  const decisions: boolean[] = [];
  assert.equal(
    controller.begin({
      url: "https://example.test/",
      error: "bad",
      fingerprint: "aa",
      isMainFrame: false,
      respond: (value) => decisions.push(value),
    }),
    false,
  );
  assert.equal(
    controller.begin({
      url: "https://example.test/",
      error: "bad",
      fingerprint: "aa",
      isMainFrame: true,
      respond: (value) => decisions.push(value),
    }),
    true,
  );
  assert.equal(controller.approve("https://other.test/"), false);
  assert.deepEqual(decisions, []);
  assert.equal(controller.approve("https://example.test/"), true);
  assert.deepEqual(decisions, [true]);
  assert.equal(controller.approve("https://example.test/"), false);
});

test("a replacement certificate error rejects the previous pending request", () => {
  const controller = new CertificateErrorController();
  const decisions: boolean[] = [];
  controller.begin({
    url: "https://one.test/",
    error: "bad",
    fingerprint: "aa",
    isMainFrame: true,
    respond: (value) => decisions.push(value),
  });
  controller.begin({
    url: "https://two.test/",
    error: "bad",
    fingerprint: "bb",
    isMainFrame: true,
    respond: (value) => decisions.push(value),
  });
  controller.reject();
  assert.deepEqual(decisions, [false, false]);
});
