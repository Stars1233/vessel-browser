#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeVia(via) {
  return via
    .map((entry) => (typeof entry === "string" ? `dependency:${entry}` : `url:${entry.url}`))
    .sort();
}

export function evaluateAuditReport(report) {
  if (!report || typeof report !== "object" || !report.vulnerabilities) {
    throw new Error("npm audit returned an invalid report");
  }

  return Object.entries(report.vulnerabilities).map(([name, vulnerability]) => {
    return {
      name,
      severity: vulnerability.severity,
      via: normalizeVia(vulnerability.via ?? []),
    };
  });
}

function runAudit() {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--omit=dev")) {
    console.error(`Unsupported audit option: ${flags.join(" ")}`);
    process.exit(2);
  }

  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "npm";
  const args = npmExecPath
    ? [npmExecPath, "audit", "--json", ...flags]
    : ["audit", "--json", ...flags];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    console.error(result.stderr || `npm audit exited with status ${result.status}`);
    process.exit(result.status ?? 2);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    console.error("Failed to parse npm audit output.");
    console.error(result.stderr || error);
    process.exit(2);
  }

  const vulnerabilities = evaluateAuditReport(report);
  if (vulnerabilities.length > 0) {
    console.error("Dependency audit found unexpected vulnerabilities:");
    for (const vulnerability of vulnerabilities) {
      console.error(
        `  ${vulnerability.name} (${vulnerability.severity}): ${vulnerability.via.join(", ")}`,
      );
    }
    process.exit(1);
  }

  console.log("Dependency audit passed with no known vulnerabilities.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    runAudit();
  } catch (error) {
    console.error(error);
    process.exit(2);
  }
}
