import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAuditReport } from "../scripts/audit-dependencies.mjs";

const approvedReport = {
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

test("dependency audit accepts only the reviewed MCP adapter advisory", () => {
  const result = evaluateAuditReport(approvedReport);
  assert.deepEqual(
    result.approved.map(({ name }) => name),
    ["@hono/node-server", "@modelcontextprotocol/node"],
  );
  assert.deepEqual(result.unexpected, []);
});

test("dependency audit passes a clean report", () => {
  assert.deepEqual(evaluateAuditReport({ vulnerabilities: {} }), {
    approved: [],
    unexpected: [],
  });
});

test("dependency audit rejects new advisories on an approved package", () => {
  const report = structuredClone(approvedReport);
  report.vulnerabilities["@hono/node-server"].via.push({
    url: "https://github.com/advisories/GHSA-unreviewed",
  });

  const result = evaluateAuditReport(report);
  assert.deepEqual(
    result.unexpected.map(({ name }) => name),
    ["@hono/node-server"],
  );
});

test("dependency audit rejects an approved advisory once a fix is available", () => {
  const report = structuredClone(approvedReport);
  report.vulnerabilities["@hono/node-server"].fixAvailable = true;

  const result = evaluateAuditReport(report);
  assert.deepEqual(
    result.unexpected.map(({ name }) => name),
    ["@hono/node-server"],
  );
});

test("dependency audit rejects unrelated vulnerabilities", () => {
  const report = structuredClone(approvedReport);
  report.vulnerabilities.dompurify = {
    severity: "moderate",
    isDirect: true,
    fixAvailable: true,
    via: [{ url: "https://github.com/advisories/GHSA-new" }],
  };

  const result = evaluateAuditReport(report);
  assert.deepEqual(
    result.unexpected.map(({ name }) => name),
    ["dompurify"],
  );
});
