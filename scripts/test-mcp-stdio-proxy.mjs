import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const LEGACY_MESSAGES = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "2.0.0" },
};
const MODERN_MESSAGES = [
  {
    jsonrpc: "2.0",
    id: 3,
    method: "server/discover",
    params: { _meta: MODERN_META },
  },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "réad", arguments: {}, _meta: MODERN_META },
  },
];

function responseFor(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "vessel", version: "test" },
      };
    case "tools/list":
      return { tools: [] };
    case "server/discover":
      return {
        resultType: "complete",
        supportedProtocolVersions: ["2026-07-28"],
        capabilities: {},
        serverInfo: { name: "vessel", version: "test" },
      };
    case "tools/call":
      return {
        resultType: "complete",
        content: [{ type: "text", text: "ok" }],
      };
    default:
      throw new Error(`Unexpected method: ${message.method}`);
  }
}

function validateHeaders(message, headers) {
  assert.equal(headers.authorization, "Bearer test-token");
  const accept = String(headers.accept || "");
  assert.ok(accept.includes("application/json"));
  assert.ok(accept.includes("text/event-stream"));

  if (message.method === "initialize") {
    assert.equal(headers["mcp-session-id"], undefined);
    return;
  }
  if (message.method === "tools/list") {
    assert.equal(headers["mcp-session-id"], "session-123");
    assert.equal(headers["mcp-protocol-version"], "2025-03-26");
    return;
  }

  assert.equal(headers["mcp-session-id"], undefined);
  assert.equal(headers["mcp-protocol-version"], "2026-07-28");
  assert.equal(headers["mcp-method"], message.method);
  const expectedName =
    message.method === "tools/call"
      ? `=?base64?${Buffer.from("réad").toString("base64")}?=`
      : undefined;
  assert.equal(headers["mcp-name"], expectedName);
}

async function runProxy(configDir, messages) {
  const child = spawn(process.execPath, ["scripts/mcp-stdio-proxy.js"], {
    cwd: process.cwd(),
    env: { ...process.env, VESSEL_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  for (const message of messages) {
    child.stdin.write(JSON.stringify(message) + "\n");
  }
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr.trim(), "");
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "vessel-proxy-test-"));
  const configDir = path.join(tmpDir, "config");
  mkdirSync(configDir, { recursive: true });
  const seenMethods = [];
  const validationErrors = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const message = JSON.parse(body);
      seenMethods.push(message.method);
      try {
        validateHeaders(message, req.headers);
      } catch (error) {
        validationErrors.push(
          `${message.method}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...(message.method === "initialize" ? { "mcp-session-id": "session-123" } : {}),
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: responseFor(message) }));
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 3100;
    writeFileSync(
      path.join(configDir, "mcp-auth.json"),
      JSON.stringify({ endpoint: `http://127.0.0.1:${port}/mcp`, token: "test-token", pid: null }) +
        "\n",
    );
    writeFileSync(
      path.join(configDir, "vessel-settings.json"),
      JSON.stringify({ mcpPort: port }) + "\n",
    );

    const legacyResponses = await runProxy(configDir, LEGACY_MESSAGES);
    const modernResponses = await runProxy(configDir, MODERN_MESSAGES);
    assert.deepEqual(
      [...legacyResponses, ...modernResponses].map((message) => message.id),
      [1, 2, 3, 4],
    );
    assert.deepEqual(seenMethods, ["initialize", "tools/list", "server/discover", "tools/call"]);
    assert.deepEqual(validationErrors, []);
    process.stdout.write("[mcp-proxy] proxy integration check passed\n");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
