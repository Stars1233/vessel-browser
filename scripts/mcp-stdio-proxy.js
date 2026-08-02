#!/usr/bin/env node
// Stdio-to-HTTP proxy for Vessel's MCP server.
//
// Reads newline-delimited JSON-RPC messages from stdin and delegates MCP HTTP
// transport semantics to the official SDK, adding Vessel's persisted bearer
// token before writing responses and notifications back to stdout.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

const CONFIG_DIR =
  process.env.VESSEL_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "vessel");
const AUTH_PATH = path.join(CONFIG_DIR, "mcp-auth.json");
const SETTINGS_PATH = path.join(CONFIG_DIR, "vessel-settings.json");
const DEFAULT_PORT = 3100;

function buildEndpoint() {
  let port = DEFAULT_PORT;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const parsedPort = Number(settings.mcpPort);
    if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      port = parsedPort;
    }
  } catch {}
  return `http://127.0.0.1:${port}/mcp`;
}

function loadAuth() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const token = (auth.token || "").trim();
    const endpoint = (auth.endpoint || "").trim();
    if (token && endpoint) return { token, endpoint };
    if (token) return { token, endpoint: buildEndpoint() };
  } catch {}
  return null;
}

function createJsonRpcError(id, message, code = -32000) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function trackLegacyProtocolVersion(message, transport) {
  const version = message?.result?.protocolVersion;
  if (typeof version === "string" && version.trim()) {
    transport.setProtocolVersion(version.trim());
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function handleLine(transport, line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  try {
    await transport.send(message);
  } catch (error) {
    writeMessage(
      createJsonRpcError(
        message && typeof message === "object" ? (message.id ?? null) : null,
        `Vessel MCP proxy error: ${errorMessage(error)}`,
      ),
    );
  }
}

async function main() {
  const auth = loadAuth();
  if (!auth) {
    process.stderr.write(
      "Vessel MCP stdio proxy: no auth token found.\n" +
        "Launch Vessel or run the installer to generate one.\n",
    );
    process.exitCode = 1;
    return;
  }

  const transport = new StreamableHTTPClientTransport(new URL(auth.endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${auth.token}` },
    },
  });
  transport.onmessage = (message) => {
    trackLegacyProtocolVersion(message, transport);
    writeMessage(message);
  };
  transport.onerror = (error) => {
    if (process.env.VESSEL_DEBUG_MCP === "1" || process.env.VESSEL_DEBUG_MCP === "true") {
      process.stderr.write(`Vessel MCP transport error: ${errorMessage(error)}\n`);
    }
  };
  await transport.start();

  const rl = readline.createInterface({ input: process.stdin });
  let requestQueue = Promise.resolve();
  rl.on("line", (line) => {
    requestQueue = requestQueue.then(() => handleLine(transport, line));
  });
  rl.on("close", () => {
    void requestQueue
      .then(() => transport.close())
      .catch((error) => {
        process.stderr.write(`Vessel MCP proxy shutdown failed: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      });
  });
}

main().catch((error) => {
  process.stderr.write(`Vessel MCP stdio proxy failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
