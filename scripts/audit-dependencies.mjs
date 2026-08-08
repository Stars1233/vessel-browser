#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @modelcontextprotocol/node@2.0.0 constrains this adapter to its 1.x line.
// Vessel's authenticated loopback MCP endpoint does not use Hono's serveStatic
// middleware. Match the complete npm audit shape so new findings, severity
// changes, or an available upstream fix still fail CI.
const APPROVED_VULNERABILITIES = new Map([
  [
    "@hono/node-server",
    {
      severity: "moderate",
      isDirect: false,
      via: ["url:https://github.com/advisories/GHSA-frvp-7c67-39w9"],
    },
  ],
  [
    "@modelcontextprotocol/node",
    {
      severity: "moderate",
      isDirect: true,
      via: ["dependency:@hono/node-server"],
    },
  ],
]);

function normalizeVia(via) {
  return via
    .map((entry) => (typeof entry === "string" ? `dependency:${entry}` : `url:${entry.url}`))
    .sort();
}

export function evaluateAuditReport(report) {
  if (!report || typeof report !== "object" || !report.vulnerabilities) {
    throw new Error("npm audit returned an invalid report");
  }

  const approved = [];
  const unexpected = [];

  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    const policy = APPROVED_VULNERABILITIES.get(name);
    const via = normalizeVia(vulnerability.via ?? []);
    const matchesPolicy =
      policy &&
      vulnerability.severity === policy.severity &&
      vulnerability.isDirect === policy.isDirect &&
      vulnerability.fixAvailable === false &&
      JSON.stringify(via) === JSON.stringify(policy.via);

    (matchesPolicy ? approved : unexpected).push({
      name,
      severity: vulnerability.severity,
      via,
    });
  }

  return { approved, unexpected };
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

  const { approved, unexpected } = evaluateAuditReport(report);
  if (unexpected.length > 0) {
    console.error("Dependency audit found unexpected vulnerabilities:");
    for (const vulnerability of unexpected) {
      console.error(
        `  ${vulnerability.name} (${vulnerability.severity}): ${vulnerability.via.join(", ")}`,
      );
    }
    process.exit(1);
  }

  if (approved.length === 0) {
    console.log("Dependency audit passed with no known vulnerabilities.");
    return;
  }

  console.log("Dependency audit passed with approved temporary exceptions:");
  for (const vulnerability of approved) {
    console.log(`  ${vulnerability.name}: ${vulnerability.via.join(", ")}`);
  }
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
