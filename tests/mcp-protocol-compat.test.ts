import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { AgentRuntime } from "../src/main/agent/runtime";
import { startMcpServer, stopMcpServer } from "../src/main/mcp/server";
import type { TabManager } from "../src/main/tabs/tab-manager";

async function createClient(endpoint: string, token: string, modern: boolean): Promise<Client> {
  const client = new Client(
    { name: modern ? "vessel-modern-test" : "vessel-legacy-test", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return client;
}

async function createModernStdioClient(configDir: string): Promise<Client> {
  const client = new Client(
    { name: "vessel-modern-stdio-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/mcp-stdio-proxy.js"],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      VESSEL_CONFIG_DIR: configDir,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

test("Vessel serves legacy and 2026-07-28 MCP clients on one endpoint", async () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "vessel-mcp-protocol-"));
  const previousConfigDir = process.env.VESSEL_CONFIG_DIR;
  process.env.VESSEL_CONFIG_DIR = configDir;

  const started = await startMcpServer({} as TabManager, {} as AgentRuntime, 0);
  assert.equal(started.ok, true);
  assert.ok(started.endpoint);
  assert.ok(started.authToken);

  let legacy: Client | null = null;
  let modern: Client | null = null;
  let modernStdio: Client | null = null;

  try {
    legacy = await createClient(started.endpoint, started.authToken, false);
    modern = await createClient(started.endpoint, started.authToken, true);
    modernStdio = await createModernStdioClient(configDir);
    await legacy.ping();
    assert.equal(legacy.getProtocolEra(), "legacy");
    assert.equal(modern.getProtocolEra(), "modern");
    assert.equal(modernStdio.getProtocolEra(), "modern");

    const [legacyTools, modernTools, modernStdioTools] = await Promise.all([
      legacy.listTools(),
      modern.listTools(),
      modernStdio.listTools(),
    ]);
    const legacyNames = legacyTools.tools.map((tool) => tool.name);
    const modernNames = modernTools.tools.map((tool) => tool.name);
    assert.ok(legacyNames.includes("current_tab"));
    assert.deepEqual(modernNames, legacyNames);
    assert.deepEqual(
      modernStdioTools.tools.map((tool) => tool.name),
      legacyNames,
    );

    const preflight = await fetch(started.endpoint, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, content-type, mcp-method, mcp-name, mcp-protocol-version",
      },
    });
    assert.equal(preflight.status, 204);
    const allowedHeaders = preflight.headers.get("access-control-allow-headers")?.toLowerCase();
    for (const header of [
      "authorization",
      "content-type",
      "mcp-method",
      "mcp-name",
      "mcp-protocol-version",
    ]) {
      assert.ok(allowedHeaders?.includes(header), `CORS should allow ${header}`);
    }
  } finally {
    await Promise.allSettled([legacy?.close(), modern?.close(), modernStdio?.close()]);
    await stopMcpServer();
    if (previousConfigDir === undefined) {
      delete process.env.VESSEL_CONFIG_DIR;
    } else {
      process.env.VESSEL_CONFIG_DIR = previousConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
});
