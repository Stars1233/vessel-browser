import assert from "node:assert/strict";
import test from "node:test";
import { resolveTabNavigationIndex } from "../src/renderer/src/lib/tab-navigation";

test("tab navigation resolves boundaries from the visible tab count", () => {
  assert.equal(resolveTabNavigationIndex(1, 2, "first"), 0);
  assert.equal(resolveTabNavigationIndex(0, 3, "last"), 2);
});

test("tab navigation wraps previous and next without invalid indexes", () => {
  assert.equal(resolveTabNavigationIndex(0, 3, "previous"), 2);
  assert.equal(resolveTabNavigationIndex(2, 3, "next"), 0);
  assert.equal(resolveTabNavigationIndex(-1, 3, "next"), null);
  assert.equal(resolveTabNavigationIndex(0, 0, "next"), null);
});
