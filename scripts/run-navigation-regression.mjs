import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "vite";
import { runNavigationProcess } from "./navigation-process.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
// Keep bundles beneath the repository so external packages resolve normally.
mkdirSync(path.join(root, "out"), { recursive: true });
const directory = mkdtempSync(path.join(root, "out", ".navigation-"));
const resultPath = path.join(directory, "result.json");

try {
  for (const [entry, folder, filename, noExternal] of [
    ["src/preload/content-script.ts", "preload", "content-script.js", ["@mozilla/readability"]],
    ["tests/navigation-regression-entry.ts", "main", "navigation.cjs", []],
  ]) {
    await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: "warn",
      ssr: { noExternal },
      build: {
        ssr: path.join(root, entry),
        target: "node22",
        outDir: path.join(directory, folder),
        minify: false,
        rollupOptions: {
          external: ["electron"],
          output: { format: "cjs", entryFileNames: filename, inlineDynamicImports: true },
        },
      },
    });
  }

  const env = { ...process.env, VESSEL_NAVIGATION_RESULT_PATH: resultPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = runNavigationProcess({
    command: require("electron"),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      path.join(directory, "main", "navigation.cjs"),
    ],
    cwd: root,
    env,
    resultPath,
  });
  console.log(`[navigation] Verified completion of ${report.scenarios} scenarios.`);
} catch (error) {
  console.error("Navigation regression failed:", error);
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
