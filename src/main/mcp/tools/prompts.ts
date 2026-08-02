import { McpServer } from "@modelcontextprotocol/server";
import { createLogger } from "../../../shared/logger";
import type { AgentRuntime } from "../../agent/runtime";
import { detectPageType, type PageType } from "../../ai/context-builder";
import { extractContent } from "../../content/extractor";
import type { TabManager } from "../../tabs/tab-manager";
import { TOOL_DEFINITIONS } from "../../tools/definitions";
import { asPromptResponse, getActiveTabSummary } from "../mcp-helpers";

const logger = createLogger("MCPPrompts");

export function registerPromptTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerPrompt(
    "vessel-supervisor-brief",
    {
      title: "Vessel Supervisor Brief",
      description:
        "A reusable prompt for reviewing the current Vessel runtime state.",
    },
    async () => {
      const state = runtime.getState();
      const activeTab = getActiveTabSummary(tabManager);
      return asPromptResponse(
        [
          "Review the current Vessel runtime state.",
          `Paused: ${state.supervisor.paused ? "yes" : "no"}`,
          `Approval mode: ${state.supervisor.approvalMode}`,
          `Pending approvals: ${state.supervisor.pendingApprovals.length}`,
          `Open tabs: ${state.session?.tabs.length || 0}`,
          `Human-focused tab: ${activeTab ? `${activeTab.title || "(untitled)"} — ${activeTab.url} [${activeTab.tabId}]` : "none"}`,
          `Recent actions: ${
            state.actions
              .slice(-5)
              .map((action) => action.name)
              .join(", ") || "none"
          }`,
        ].join("\n"),
      );
    },
  );

  server.registerResource(
    "vessel-runtime-state",
    "vessel://runtime/state",
    {
      title: "Vessel Runtime State",
      description:
        "Current supervisor, session, and checkpoint state for the Vessel browser runtime.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://runtime/state",
          text: JSON.stringify(runtime.getState(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "vessel-active-tab",
    "vessel://tabs/active",
    {
      title: "Vessel Active Tab",
      description:
        "The tab currently visible to the human user, with URL and title.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://tabs/active",
          text: JSON.stringify(getActiveTabSummary(tabManager), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "vessel-recommended-tools",
    "vessel://context/recommended-tools",
    {
      title: "Recommended Tools for Current Page",
      description:
        "Context-aware tool recommendations based on the current page type (login, search, form, article, etc.). Returns tools sorted by relevance with contextual hints.",
      mimeType: "application/json",
    },
    async () => {
      const activeTab = tabManager.getActiveTab();
      let pageType: PageType = "GENERAL";
      let pageUrl = "";
      let pageTitle = "";

      if (activeTab) {
        try {
          const wc = activeTab.view.webContents;
          pageUrl = wc.getURL();
          pageTitle = wc.getTitle();
          const page = await extractContent(wc);
          pageType = detectPageType(page);
        } catch (err) {
          logger.warn("Failed to detect page type for tool scoring, falling back to GENERAL:", err);
        }
      }

      // Score and sort tools by relevance for this page type
      const scored = TOOL_DEFINITIONS.map((def) => {
        const tier = def.tier ?? 1;
        const isRelevant = !def.relevance || def.relevance.includes(pageType);
        let score: number;
        if (tier === 0) score = 0;
        else if (tier === 1 && isRelevant) score = 10;
        else if (tier === 2 && isRelevant) score = 20;
        else if (tier === 1) score = 30;
        else score = 40;
        return {
          name: def.name,
          title: def.title,
          description: def.description,
          tier,
          relevance: isRelevant ? "high" : "low",
          score,
        };
      });

      scored.sort((a, b) => a.score - b.score);

      const result = {
        pageType,
        pageUrl,
        pageTitle,
        recommended: scored
          .filter((t) => t.score <= 20)
          .map(({ name, title, description, relevance }) => ({
            name,
            title,
            description,
            relevance,
          })),
        available: scored
          .filter((t) => t.score > 20)
          .map(({ name, title, relevance }) => ({ name, title, relevance })),
      };

      return {
        contents: [
          {
            uri: "vessel://context/recommended-tools",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

}
