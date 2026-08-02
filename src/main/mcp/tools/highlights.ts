import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createLogger } from "../../../shared/logger";
import type { AgentRuntime } from "../../agent/runtime";
import { clearHighlights, highlightOnPage } from "../../highlights/inject";
import { captureLiveHighlightSnapshot } from "../../highlights/live-snapshot";
import * as highlightsManager from "../../highlights/manager";
import type { TabManager } from "../../tabs/tab-manager";
import { normalizeLooseString, normalizedOptionalStringSchema } from "../../tools/input-coercion";
import { resolveSelector } from "../../utils/selector-resolver";
import { asNoActiveTabResponse, asTextResponse, withAction } from "../mcp-helpers";

const logger = createLogger("MCPHighlightTools");

export function registerHighlightTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "highlight",
    {
      title: "Highlight Element",
      description:
        "Visually highlight an element or text on the page for the user. Use to draw attention to specific parts of the page. Highlights persist until cleared. Set persist=true to save the highlight so it re-appears when the user revisits this page.",
      inputSchema: z.object({
        index: z
          .number()
          .optional()
          .describe("Element index from extracted content to highlight"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of element to highlight"),
        text: normalizedOptionalStringSchema().describe(
          "Text to find and highlight on the page (highlights all occurrences)",
        ),
        label: z
          .string()
          .optional()
          .describe("Optional annotation label to display near the highlight"),
        durationMs: z
          .number()
          .optional()
          .describe(
            "Auto-clear after this many milliseconds (omit for permanent)",
          ),
        persist: z
          .boolean()
          .optional()
          .describe(
            "If true, save this highlight so it re-appears automatically when the user revisits the page. Ignored when durationMs is set.",
          ),
        color: z
          .enum(["yellow", "red", "green", "blue", "purple", "orange"])
          .optional()
          .describe(
            "Highlight color. Use red for problems/errors, green for targets/success, blue for informational, purple for important, orange for warnings. Defaults to yellow.",
          ),
      }),
    },
    async ({ index, selector, text, label, durationMs, persist, color }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      const normalizedText = normalizeLooseString(text);
      return withAction(
        runtime,
        tabManager,
        "highlight",
        {
          index,
          selector,
          text: normalizedText,
          label,
          durationMs,
          persist,
          color,
        },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          const result = await highlightOnPage(
            wc,
            resolvedSelector,
            normalizedText,
            label,
            durationMs,
            color,
          );

          if (
            persist &&
            !durationMs &&
            !result.startsWith("Error") &&
            !result.includes("not found")
          ) {
            const url = highlightsManager.normalizeUrl(wc.getURL());
            highlightsManager.addHighlight(
              url,
              resolvedSelector ?? undefined,
              normalizedText,
              label,
              color,
              "agent",
            );
          }

          return result;
        },
      );
    },
  );

  server.registerTool(
    "clear_highlights",
    {
      title: "Clear Highlights",
      description:
        "Remove all visual highlights from the current page, including any saved persistent highlights for this URL.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "clear_highlights",
        {},
        async () => {
          const wc = tab.view.webContents;
          const url = highlightsManager.normalizeUrl(wc.getURL());
          highlightsManager.clearHighlightsForUrl(url);
          return clearHighlights(wc);
        },
      );
    },
  );

  server.registerTool(
    "list_highlights",
    {
      title: "List Highlights",
      description:
        "List highlights related to the current browsing session. Includes saved persistent highlights plus the active tab's live text selection and any visible unsaved highlight marks. IMPORTANT: When the user says they highlighted or selected text, call this tool before falling back to screenshots or vision.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe(
            "URL to list highlights for. Omit to see active tab highlights first, then all others.",
          ),
      }),
    },
    async ({ url }) => {
      const state = highlightsManager.getState();
      const activeTab = tabManager.getActiveTab();
      const activeUrl = activeTab
        ? highlightsManager.normalizeUrl(activeTab.view.webContents.getURL())
        : null;
      const activeSavedHighlights = activeUrl
        ? state.highlights.filter((highlight) => highlight.url === activeUrl)
        : [];
      const liveSnapshot =
        activeTab && activeUrl
          ? await captureLiveHighlightSnapshot(
              activeTab.view.webContents,
              activeSavedHighlights,
            )
          : { pageHighlights: [] };
      const unsavedLiveHighlights = liveSnapshot.pageHighlights.filter(
        (highlight) => !highlight.persisted,
      );

      if (url) {
        const filtered = state.highlights.filter(
          (h) => h.url === highlightsManager.normalizeUrl(url),
        );
        const normalizedUrl = highlightsManager.normalizeUrl(url);
        const sections: string[] = [];
        if (activeUrl && activeUrl === normalizedUrl) {
          if (liveSnapshot.activeSelection) {
            sections.push(
              `## Active selection (${activeUrl})\n${JSON.stringify(liveSnapshot.activeSelection, null, 2)}`,
            );
          }
          if (unsavedLiveHighlights.length > 0) {
            sections.push(
              `## Visible unsaved highlights (${activeUrl})\n${JSON.stringify(unsavedLiveHighlights, null, 2)}`,
            );
          }
        }
        if (filtered.length > 0) {
          sections.push(
            `## Saved highlights (${normalizedUrl})\n${JSON.stringify(filtered, null, 2)}`,
          );
        }
        if (sections.length === 0) {
          return asTextResponse(`No highlights or active selection for ${url}`);
        }
        return asTextResponse(sections.join("\n\n"));
      }

      // No URL filter — show active tab's highlights prominently first
      const activeHighlights = activeSavedHighlights;
      const otherHighlights = activeUrl
        ? state.highlights.filter((h) => h.url !== activeUrl)
        : state.highlights;

      const sections: string[] = [];

      if (liveSnapshot.activeSelection) {
        sections.push(
          `## Active selection (${activeUrl})\n${JSON.stringify(liveSnapshot.activeSelection, null, 2)}`,
        );
      }

      if (unsavedLiveHighlights.length > 0) {
        sections.push(
          `## Visible unsaved highlights on active tab (${activeUrl})\n${JSON.stringify(unsavedLiveHighlights, null, 2)}`,
        );
      }

      if (activeHighlights.length > 0) {
        sections.push(
          `## Saved highlights on active tab (${activeUrl})\n${JSON.stringify(activeHighlights, null, 2)}`,
        );
      } else if (activeUrl) {
        sections.push(
          `## Active tab (${activeUrl})\nNo saved highlights on this page.`,
        );
      }

      if (otherHighlights.length > 0) {
        sections.push(
          `## Other saved highlights\n${JSON.stringify(otherHighlights, null, 2)}`,
        );
      }

      if (sections.length === 0) {
        return asTextResponse("No saved or live highlights");
      }

      return asTextResponse(sections.join("\n\n"));
    },
  );

  server.registerTool(
    "remove_highlight",
    {
      title: "Remove Persistent Highlight",
      description:
        "Remove a persistent highlight by ID and clear it from any open tab. Use list_highlights to find IDs.",
      inputSchema: z.object({
        id: z.string().describe("ID of the highlight to remove"),
      }),
    },
    async ({ id }) => {
      const removed = highlightsManager.removeHighlight(id);
      if (!removed) {
        return asTextResponse(`No highlight found with id ${id}`);
      }

      // Clear visual highlights and re-apply remaining ones on matching tabs
      const remaining = highlightsManager.getHighlightsForUrl(removed.url);
      for (const tabState of tabManager.getAllStates()) {
        if (highlightsManager.normalizeUrl(tabState.url) !== removed.url) {
          continue;
        }
        const tab = tabManager.getTab(tabState.id);
        if (!tab) continue;
        const wc = tab.view.webContents;
        await clearHighlights(wc);
        for (const h of remaining) {
          if (!h.selector && !h.text) continue;
          void highlightOnPage(
            wc,
            h.selector ?? null,
            h.text,
            h.label,
            undefined,
            h.color,
          ).catch((err) =>
            logger.warn("Failed to restore highlight after removal:", err),
          );
        }
      }

      return asTextResponse(`Removed highlight ${id}`);
    },
  );

}
