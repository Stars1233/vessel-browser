import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

export function runNavigationProcess({ command, args, cwd, env, resultPath, timeout = 180_000 }) {
  // Never accept a completion report left behind by an earlier run.
  rmSync(resultPath, { force: true });
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`Navigation process failed (${result.signal || result.status}).`);
  }
  // Electron can exit successfully while scenario promises are still pending.
  const report = JSON.parse(readFileSync(resultPath, "utf8"));
  if (report.passed !== true || !Number.isInteger(report.scenarios) || report.scenarios < 1) {
    throw new Error("Navigation suite did not report successful completion.");
  }
  return report;
}
