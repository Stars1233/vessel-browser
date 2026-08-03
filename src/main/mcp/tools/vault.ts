import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createLogger } from "../../../shared/logger";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import { appendAuditEntry } from "../../vault/audit";
import { requestConsent } from "../../vault/consent";
import { requestHumanVaultConsent } from "../../vault/human-consent";
import * as humanVault from "../../vault/human-vault";
import * as vaultManager from "../../vault/manager";
import { trackVaultAction } from "../../telemetry/posthog";
import { asErrorTextResponse, asNoActiveTabResponse, asTextResponse, getPremiumToolGateResponse } from "../mcp-helpers";
import { createVaultFillTargetGuard } from "./vault-fill-target";

export { createVaultFillTargetGuard } from "./vault-fill-target";

const logger = createLogger("MCPVaultTools");

export function registerVaultTools(
  server: McpServer,
  tabManager: TabManager,
  _runtime: AgentRuntime,
): void {
  server.registerTool(
    "vault_status",
    {
      title: "Check Vault Credentials",
      description:
        "Check whether stored credentials exist for a domain. Returns credential labels and usernames but NEVER password values. Use this before vault_login to verify credentials are available.",
      inputSchema: z.object({
        domain: z
          .string()
          .describe(
            "The domain to check credentials for (e.g. 'github.com'). If omitted, checks the active tab's domain.",
          )
          .optional(),
      }),
    },
    async ({ domain }) => {
      const premiumGate = getPremiumToolGateResponse("vault_status");
      if (premiumGate) return premiumGate;

      let targetDomain = domain;
      if (!targetDomain) {
        const tab = tabManager.getActiveTab();
        if (!tab) return asErrorTextResponse("No active tab and no domain specified");
        try {
          targetDomain = new URL(tab.state.url).hostname;
        } catch (err) {
          logger.warn("Failed to parse active tab URL for vault_status:", err);
          return asErrorTextResponse("Could not parse active tab URL");
        }
      }

      const matches = vaultManager.findEntriesForDomain(
        targetDomain.includes("://") ? targetDomain : `https://${targetDomain}`,
      );

      if (matches.length === 0) {
        return asTextResponse(
          `No stored credentials found for ${targetDomain}. The user needs to add credentials in Settings > Agent Credential Vault before the agent can log in.`,
        );
      }

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: matches[0].id,
        credentialLabel: matches[0].label,
        domain: targetDomain,
        action: "status_check",
        approved: true,
      });

      const summary = matches
        .map((m) => `  - "${m.label}" (${m.username})`)
        .join("\n");

      return asTextResponse(
        `Found ${matches.length} credential(s) for ${targetDomain}:\n${summary}\n\nUse vault_login to fill the login form. Credentials are filled directly — you will NOT see the password values.`,
      );
    },
  );

  server.registerTool(
    "vault_login",
    {
      title: "Fill Login with Vault Credentials",
      description:
        "Fill a login form on the current page using stored credentials from the Agent Credential Vault. The credential values are filled directly into the page — they are NEVER returned in this response. The user will see a consent dialog before credentials are used.",
      inputSchema: z.object({
        credential_label: z
          .string()
          .optional()
          .describe(
            "Label of the credential to use. If omitted, uses the first matching credential for the current domain.",
          ),
        username_index: z
          .number()
          .optional()
          .describe(
            "Element index of the username/email input field from read_page.",
          ),
        password_index: z
          .number()
          .optional()
          .describe(
            "Element index of the password input field from read_page.",
          ),
        submit_after: z
          .boolean()
          .optional()
          .describe(
            "Whether to click the submit button after filling credentials. Defaults to false.",
          ),
        submit_index: z
          .number()
          .optional()
          .describe(
            "Element index of the submit button. Required if submit_after is true.",
          ),
      }),
    },
    async ({
      credential_label,
      username_index,
      password_index,
      submit_after,
      submit_index,
    }) => {
      const premiumGate = getPremiumToolGateResponse("vault_login");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      const wc = tab.view.webContents;
      let hostname: string;
      try {
        hostname = new URL(wc.getURL() || tab.state.url).hostname;
      } catch (err) {
        logger.warn("Failed to parse active tab URL for vault_login:", err);
        return asErrorTextResponse("Could not parse active tab URL");
      }

      // Find matching credentials
      const matches = vaultManager.findEntriesForDomain(`https://${hostname}`);
      if (matches.length === 0) {
        return asTextResponse(
          `No stored credentials for ${hostname}. The user needs to add credentials in Settings > Agent Credential Vault.`,
        );
      }

      const match = credential_label
        ? matches.find(
            (m) => m.label.toLowerCase() === credential_label.toLowerCase(),
          )
        : matches[0];

      if (!match) {
        return asTextResponse(
          `No credential named "${credential_label}" found for ${hostname}. Available: ${matches.map((m) => m.label).join(", ")}`,
        );
      }

      const fillTarget = createVaultFillTargetGuard(tabManager, tab);
      const fill = await fillTarget.runAfterApproval(
        async () => {
          const consent = await requestConsent({
            credentialLabel: match.label,
            username: match.username,
            domain: hostname,
          });
          appendAuditEntry({
            timestamp: new Date().toISOString(),
            credentialId: match.id,
            credentialLabel: match.label,
            domain: hostname,
            action: "login_fill",
            approved: consent.approved,
          });
          return consent.approved;
        },
        async (target) => {
          // Get raw credentials only after approval is bound to the captured document.
          const creds = vaultManager.getCredential(match.id);
          if (!creds) return asErrorTextResponse("Credential not found in vault");

          const results: string[] = [];
          if (username_index != null) {
            const usernameResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${username_index}, "value", ${JSON.stringify(creds.username)}) || "Error: interactByIndex not available"`,
            );
            results.push(`Username: ${usernameResult}`);
          }
          if (password_index != null) {
            const passwordResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${password_index}, "value", ${JSON.stringify(creds.password)}) || "Error: interactByIndex not available"`,
            );
            results.push(`Password: ${passwordResult.replace(/Typed into:.*/, "Typed into: [password field]")}`);
          }

          vaultManager.recordUsage(match.id);
          trackVaultAction("login_fill");

          if (submit_after && submit_index != null) {
            const submitResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
            );
            results.push(`Submit: ${submitResult}`);
          }

          return asTextResponse(
            [
              `Login form filled for ${hostname} using credential "${match.label}".`,
              ...results,
              "",
              "Note: Credential values were filled directly into the page. They are NOT included in this response.",
            ].join("\n"),
          );
        },
      );

      if (fill.status === "denied") {
        return asTextResponse(
          `User denied credential access for ${hostname}. The agent should not retry without being asked.`,
        );
      }
      if (fill.status === "changed") {
        return asErrorTextResponse(
          "The page changed while credential approval was pending. Refusing to fill credentials.",
        );
      }
      return fill.value;
    },
  );

  server.registerTool(
    "vault_totp",
    {
      title: "Fill TOTP Code from Vault",
      description:
        "Generate a TOTP 2FA code from a stored secret and fill it into a code input field. The TOTP secret and generated code are NEVER returned — only filled directly into the page.",
      inputSchema: z.object({
        credential_label: z
          .string()
          .optional()
          .describe(
            "Label of the credential whose TOTP secret to use. If omitted, uses the first matching credential with a TOTP secret.",
          ),
        code_index: z
          .number()
          .describe(
            "Element index of the TOTP/2FA code input field from read_page.",
          ),
        submit_after: z
          .boolean()
          .optional()
          .describe("Whether to click submit after filling the code."),
        submit_index: z
          .number()
          .optional()
          .describe("Element index of the submit button."),
      }),
    },
    async ({ credential_label, code_index, submit_after, submit_index }) => {
      const premiumGate = getPremiumToolGateResponse("vault_totp");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      const wc = tab.view.webContents;
      let hostname: string;
      try {
        hostname = new URL(wc.getURL() || tab.state.url).hostname;
      } catch (err) {
        logger.warn("Failed to parse active tab URL for vault_totp:", err);
        return asErrorTextResponse("Could not parse active tab URL");
      }

      const matches = vaultManager.findEntriesForDomain(`https://${hostname}`);
      const match = credential_label
        ? matches.find(
            (m) => m.label.toLowerCase() === credential_label.toLowerCase(),
          )
        : matches.find((m) => vaultManager.hasTotpSecret(m.id));

      if (!match) {
        return asTextResponse(
          `No credential with TOTP secret found for ${hostname}.`,
        );
      }

      const fillTarget = createVaultFillTargetGuard(tabManager, tab);
      const fill = await fillTarget.runAfterApproval(
        async () => {
          const consent = await requestConsent({
            credentialLabel: match.label,
            username: match.username,
            domain: hostname,
          });
          appendAuditEntry({
            timestamp: new Date().toISOString(),
            credentialId: match.id,
            credentialLabel: match.label,
            domain: hostname,
            action: "totp_generate",
            approved: consent.approved,
          });
          return consent.approved;
        },
        async (target) => {
          const secret = vaultManager.getTotpSecret(match.id);
          if (!secret) {
            return asTextResponse(
              `Credential "${match.label}" does not have a TOTP secret configured.`,
            );
          }

          const code = vaultManager.generateTotpCode(secret);
          const fillResult = await target.executeJavaScript<string>(
            `window.__vessel?.interactByIndex?.(${code_index}, "value", ${JSON.stringify(code)}) || "Error: interactByIndex not available"`,
          );
          vaultManager.recordUsage(match.id);
          trackVaultAction("totp_fill");

          const results = [`2FA code filled: ${fillResult.replace(/Typed into:.*/, "Typed into: [2FA field]")}`];
          if (submit_after && submit_index != null) {
            const submitResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
            );
            results.push(`Submit: ${submitResult}`);
          }

          return asTextResponse(
            [
              `TOTP code filled for ${hostname} using credential "${match.label}".`,
              ...results,
              "",
              "Note: The TOTP code was filled directly into the page. It is NOT included in this response.",
            ].join("\n"),
          );
        },
      );

      if (fill.status === "denied") {
        return asTextResponse(
          `User denied TOTP access for ${hostname}.`,
        );
      }
      if (fill.status === "changed") {
        return asErrorTextResponse(
          "The page changed while TOTP approval was pending. Refusing to fill the code.",
        );
      }
      return fill.value;
    },
  );

  // --- Human Password Manager ---

  server.registerTool(
    "human_vault_list",
    {
      title: "List Human Passwords",
      description:
        "List saved human passwords for a domain, or all passwords. " +
        "Returns metadata only (never passwords). Use human_vault_fill to fill credentials into a page. " +
        "Requires user consent.",
      inputSchema: z.object({
        domain: z
          .string()
          .optional()
          .describe("Filter by domain (e.g. 'github.com'). Omit for all."),
      }),
    },
    async ({ domain }) => {
      const premiumGate = getPremiumToolGateResponse("human_vault_list");
      if (premiumGate) return premiumGate;

      const consent = await requestHumanVaultConsent({
        action: "list",
        domain: domain ?? "all",
      });
      if (!consent.approved) {
        return asTextResponse("User denied access to password list.");
      }

      humanVault.recordListAccess(domain ?? "all", "mcp_tool");

      const entries = domain
        ? humanVault.findForDomain(domain)
        : humanVault.listEntries();

      if (entries.length === 0) {
        return asTextResponse(
          domain
            ? `No saved passwords for ${domain}.`
            : "No saved passwords.",
        );
      }

      const lines = entries.map((e, i) => {
        const parts = [
          `${i + 1}. "${e.title}"`,
          `   URL: ${e.url}`,
          `   Username: ${e.username || "(none)"}`,
        ];
        if (e.category) parts.push(`   Category: ${e.category}`);
        if (e.tags?.length) parts.push(`   Tags: ${e.tags.join(", ")}`);
        parts.push(
          `   Last used: ${e.lastUsedAt ? new Date(e.lastUsedAt).toLocaleDateString() : "never"}`,
        );
        return parts.join("\n");
      });

      return asTextResponse(
        [
          `Saved passwords${domain ? ` for ${domain}` : ""} (${entries.length}):`,
          "",
          ...lines,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "human_vault_fill",
    {
      title: "Fill Human Password",
      description:
        "Fill saved credentials into the active page's login form. " +
        "Requires user consent. The password is filled directly into the page -- " +
        "it is NEVER included in the response.",
      inputSchema: z.object({
        entry_id: z
          .string()
          .optional()
          .describe("Specific entry ID to fill. Omit to auto-detect by domain."),
        username_index: z
          .number()
          .optional()
          .describe("Element index of the username/email field."),
        password_index: z
          .number()
          .optional()
          .describe("Element index of the password field."),
        submit_after: z
          .boolean()
          .optional()
          .describe("Whether to click submit after filling (default: false)."),
        submit_index: z
          .number()
          .optional()
          .describe("Element index of the submit button (required if submit_after is true)."),
      }),
    },
    async ({ entry_id, username_index, password_index, submit_after, submit_index }) => {
      const premiumGate = getPremiumToolGateResponse("human_vault_fill");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      let hostname: string;
      try {
        hostname = new URL(tab.view.webContents.getURL() || tab.state.url).hostname;
      } catch {
        return asErrorTextResponse("Could not parse active tab URL.");
      }

      // Find the entry
      if (username_index == null && password_index == null) {
        return asErrorTextResponse("Provide at least one field index to fill.");
      }
      if (submit_after && submit_index == null) {
        return asErrorTextResponse("submit_index is required when submit_after is true.");
      }

      let entry;
      if (entry_id) {
        entry = humanVault.getEntry(entry_id);
        if (!entry) {
          return asErrorTextResponse(`No entry found with ID ${entry_id}.`);
        }
        if (!humanVault.entryMatchesUrl(entry.id, `https://${hostname}`)) {
          return asErrorTextResponse(
            `Credential "${entry.title}" is not saved for ${hostname}. Refusing to fill it on this site.`,
          );
        }
      } else {
        const matches = humanVault.findForDomain(`https://${hostname}`);
        if (matches.length === 0) {
          return asTextResponse(
            `No saved passwords for ${hostname}. Add one in Settings > Passwords first.`,
          );
        }
        entry = humanVault.getEntry(matches[0].id);
        if (!entry) {
          return asErrorTextResponse("Matched credential could not be loaded.");
        }
      }

      const fillTarget = createVaultFillTargetGuard(tabManager, tab);
      const fill = await fillTarget.runAfterApproval(
        async () => {
          const consent = await requestHumanVaultConsent({
            action: "fill",
            entryId: entry.id,
            title: entry.title,
            username: entry.username,
            domain: hostname,
          });
          return consent.approved;
        },
        async (target) => {
          const decrypted = humanVault.getCredential(entry.id);
          if (!decrypted) return asErrorTextResponse("Failed to decrypt password.");

          const results: string[] = [];
          if (username_index != null) {
            const usernameResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${username_index}, "value", ${JSON.stringify(entry.username)}) || "Error: interactByIndex not available"`,
            );
            results.push(`Username filled: ${usernameResult.replace(/Typed into:.*/, "Typed into: [username field]")}`);
          }
          if (password_index != null) {
            const passwordResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${password_index}, "value", ${JSON.stringify(decrypted.password)}) || "Error: interactByIndex not available"`,
            );
            results.push(`Password filled: ${passwordResult.replace(/Typed into:.*/, "Typed into: [password field]")}`);
          }
          if (submit_after && submit_index != null) {
            const submitResult = await target.executeJavaScript<string>(
              `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
            );
            results.push(`Submit: ${submitResult}`);
          }

          humanVault.recordUsage(entry.id, "mcp_tool");
          return asTextResponse(
            [
              `Credentials filled for ${hostname} using "${entry.title}".`,
              ...results,
              "",
              "Note: The password was filled directly into the page. It is NOT included in this response.",
            ].join("\n"),
          );
        },
      );

      if (fill.status === "denied") {
        return asTextResponse("User denied filling credentials.");
      }
      if (fill.status === "changed") {
        return asErrorTextResponse(
          "The page changed while password approval was pending. Refusing to fill credentials.",
        );
      }
      return fill.value;
    },
  );

  server.registerTool(
    "human_vault_remove",
    {
      title: "Remove Human Password",
      description:
        "Delete a saved password. Requires user consent. This cannot be undone.",
      inputSchema: z.object({
        entry_id: z.string().describe("ID of the entry to remove."),
      }),
    },
    async ({ entry_id }) => {
      const premiumGate = getPremiumToolGateResponse("human_vault_remove");
      if (premiumGate) return premiumGate;

      const entry = humanVault.getEntry(entry_id);
      if (!entry) {
        return asErrorTextResponse(`No entry found with ID ${entry_id}.`);
      }

      const consent = await requestHumanVaultConsent({
        action: "remove",
        entryId: entry.id,
        title: entry.title,
      });
      if (!consent.approved) {
        return asTextResponse("User denied removing this password.");
      }

      humanVault.removeEntry(entry_id, "mcp_tool");
      return asTextResponse(`Password "${entry.title}" removed.`);
    },
  );

}
