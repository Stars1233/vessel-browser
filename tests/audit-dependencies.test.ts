import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAuditReport } from "../scripts/audit-dependencies.mjs";

const vulnerableReport = {
  vulnerabilities: {
    "@hono/node-server": {
      severity: "moderate",
      isDirect: false,
      fixAvailable: false,
      via: [
        {
          url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
        },
      ],
    },
    "@modelcontextprotocol/node": {
      severity: "moderate",
      isDirect: true,
      fixAvailable: false,
      via: ["@hono/node-server"],
    },
  },
};

test("dependency audit passes a clean report", () => {
  assert.deepEqual(evaluateAuditReport({ vulnerabilities: {} }), []);
});

test("dependency audit rejects the former MCP adapter advisories", () => {
  const result = evaluateAuditReport(vulnerableReport);
  assert.deepEqual(
    result.map(({ name }) => name),
    ["@hono/node-server", "@modelcontextprotocol/node"],
  );
});

test("dependency audit rejects unrelated vulnerabilities", () => {
  const report = { vulnerabilities: {} };
  report.vulnerabilities.dompurify = {
    severity: "moderate",
    isDirect: true,
    fixAvailable: true,
    via: [{ url: "https://github.com/advisories/GHSA-new" }],
  };

  const result = evaluateAuditReport(report);
  assert.deepEqual(
    result.map(({ name }) => name),
    ["dompurify"],
  );
});
