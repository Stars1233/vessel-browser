import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Report } from "c8";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testDirectory = path.join(repoRoot, "tests");
const localOnlyTests = new Set(
  readFileSync(path.join(testDirectory, "local-only-tests.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")),
);
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".test.ts") &&
      !localOnlyTests.has(entry.name),
  )
  .map((entry) => `tests/${entry.name}`)
  .sort();

if (testFiles.length === 0) {
  console.error("No canonical test files found.");
  process.exit(1);
}

const preloadMocks = [
  "--require",
  "./tests/mocks/register.cjs",
  "--import",
  "./tests/mocks/esm-register.mjs",
].join(" ");
const nodeOptions = [process.env.NODE_OPTIONS, preloadMocks].filter(Boolean).join(" ");
const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "vessel-c8-"));
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
let result;

try {
  result = spawnSync(process.execPath, [tsxCli, "--test", ...testFiles], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      NODE_V8_COVERAGE: tempDirectory,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  const report = new Report({
    omitRelative: true,
    reporter: ["text", "html"],
    reportsDirectory: path.join(repoRoot, "coverage"),
    resolve: "",
    tempDirectory,
  });
  await report.run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

if (process.exitCode == null) {
  process.exitCode = result?.status ?? 1;
}
