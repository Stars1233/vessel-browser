import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNavigationProcess } from "../scripts/navigation-process.mjs";

for (const [name, script, passes] of [
  [
    "accepts a completed suite",
    'require("fs").writeFileSync(process.argv[1], JSON.stringify({passed:true,scenarios:3}))',
    true,
  ],
  ["rejects a premature zero exit", "process.exit(0)", false],
  ["rejects an assertion failure", "process.exit(1)", false],
  [
    "rejects an empty suite",
    'require("fs").writeFileSync(process.argv[1], JSON.stringify({passed:true,scenarios:0}))',
    false,
  ],
  ["rejects a malformed report", 'require("fs").writeFileSync(process.argv[1], "not json")', false],
  ["terminates a hung suite", "setInterval(() => {}, 1000)", false],
] as const) {
  test(`navigation runner ${name}`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "vessel-navigation-runner-"));
    const resultPath = path.join(directory, "result.json");
    // Even a valid stale report must not turn an incomplete run green.
    writeFileSync(resultPath, JSON.stringify({ passed: true, scenarios: 99 }));
    try {
      const run = () =>
        runNavigationProcess({
          command: process.execPath,
          args: ["-e", script, resultPath],
          resultPath,
          timeout: name === "terminates a hung suite" ? 200 : 10_000,
        });
      if (passes) assert.equal(run().scenarios, 3);
      else assert.throws(run);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
