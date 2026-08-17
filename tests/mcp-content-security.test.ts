import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { parseHTML } from "linkedom";
import type { AgentRuntime } from "../src/main/agent/runtime";
import { loadSettings, setSetting } from "../src/main/config/settings";
import { registerContentTools } from "../src/main/mcp/tools/content";
import type { TabManager } from "../src/main/tabs/tab-manager";

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

function harness(html: string, deny = false) {
  const { document, window } = parseHTML(html);
  const dom = window as unknown as Record<string, unknown>;
  Object.assign(globalThis, {
    document,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    HTMLSelectElement: dom.HTMLSelectElement,
  });
  const handlers = new Map<string, Handler>();
  const webContents = {
    getURL: () => "https://example.test/",
    executeJavaScript: async (script: string) =>
      script.includes("sensitiveValuePresent")
        ? {
            tag: "input",
            role: null,
            text: "",
            value: null,
            attr: null,
            sensitiveValuePresent: true,
          }
        : Function(
            "document",
            "HTMLElement",
            "HTMLInputElement",
            "HTMLTextAreaElement",
            "HTMLSelectElement",
            `return ${script}`,
          )(
            document,
            dom.HTMLElement,
            dom.HTMLInputElement,
            dom.HTMLTextAreaElement,
            dom.HTMLSelectElement,
          ),
  };
  const tab = {
    view: { webContents, getBounds: () => ({ width: 100, height: 100 }) },
    state: { adBlockingEnabled: true },
  };
  const tabManager = {
    getActiveTab: () => tab,
    getActiveTabId: () => "tab-1",
    getAllStates: () => [],
  } as unknown as TabManager;
  const runtime = {
    runControlledAction: async ({
      name,
      executor,
    }: {
      name: string;
      executor: () => Promise<string>;
    }) => (deny ? `Action denied: ${name}` : executor()),
    getFlowContext: () => "",
  } as unknown as AgentRuntime;
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerContentTools(server, tabManager, runtime);
  return handlers;
}

test("content extraction tools pass through the controlled action policy", async (t) => {
  const originalPremium = loadSettings().premium;
  t.after(() => setSetting("premium", originalPremium));
  setSetting("premium", {
    status: "active",
    customerId: "cus_test",
    verificationToken: "token",
    email: "test@example.com",
    validatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const handlers = harness("<main>secret</main>", true);
  for (const name of [
    "extract_content",
    "extract_structured_data",
    "extract_text",
    "suggest",
    "screenshot",
  ]) {
    const response = await handlers.get(name)!({ selector: "main" });
    assert.match(response.content.at(-1)?.text || "", new RegExp(`Action denied: ${name}`));
  }
});

test("extract_text redacts password and one-time-code values", async () => {
  const handlers = harness(
    `<input id="password" type="password" value="vault-secret"><input id="otp" autocomplete="one-time-code" value="123456">`,
  );
  for (const selector of ["#password", "#otp"]) {
    const response = await handlers.get("extract_text")!({ selector });
    const text = response.content[0]?.text || "";
    assert.match(text, /\[redacted sensitive field\]/);
    assert.doesNotMatch(text, /vault-secret|123456/);
  }
});
