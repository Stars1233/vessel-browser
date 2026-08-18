import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentVersion } from "../src/main/updates/checker";

test("current Vessel version comes from the packaged Electron app", () => {
  assert.equal(getCurrentVersion(), "0.1.0-test");
});
