import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import { clickResolvedSelector } from "../../ai/page-actions/navigation";
import {
  fillFormFields,
  setElementValue,
  submitFormDirect as submitForm,
} from "../../ai/page-actions/interaction";
import type { TabManager } from "../../tabs/tab-manager";
import { waitForLoad, waitForPotentialNavigation } from "../../utils/webcontents-utils";
import { asNoActiveTabResponse, asTextResponse, withAction } from "../mcp-helpers";

export function registerMacroTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "fill_form",
    {
      title: "Fill Form",
      description:
        "Fill multiple form fields at once. Provide a map of field identifiers to values. Fields are matched by index, name, label, or placeholder. Much faster than calling type for each field individually.",
      inputSchema: z.object({
        fields: z
          .array(
            z.object({
              index: z
                .number()
                .optional()
                .describe("Element index from page content"),
              selector: z.string().optional().describe("CSS selector fallback"),
              name: z
                .string()
                .optional()
                .describe("Field name or id, such as custname"),
              label: z
                .string()
                .optional()
                .describe("Visible label or aria-label text"),
              placeholder: z
                .string()
                .optional()
                .describe("Placeholder text shown in the field"),
              value: z.string().describe("Value to enter"),
            }),
          )
          .describe(
            "Fields to fill, matched by index, selector, name, label, or placeholder",
          ),
        submit: z
          .boolean()
          .optional()
          .describe("Submit the form after filling (default false)"),
      }),
    },
    async ({ fields, submit }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "fill_form",
        { fieldCount: fields.length, submit },
        async () => {
          const wc = tab.view.webContents;
          const fillResults = await fillFormFields(wc, fields);
          const results = fillResults.map((item) => item.result);
          if (submit) {
            // Find and submit the form containing the first field
            const firstSel =
              fillResults.find((item) => item.selector)?.selector ?? null;
            if (firstSel) {
              const beforeUrl = wc.getURL();
              const submitResult = await submitForm(wc, undefined, firstSel);
              await waitForPotentialNavigation(wc, beforeUrl);
              const afterUrl = wc.getURL();
              results.push(
                afterUrl !== beforeUrl
                  ? `Submitted → ${afterUrl}`
                  : submitResult,
              );
            }
          }
          return `Filled ${results.length} field(s):\n${results.join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "login",
    {
      title: "Login",
      description:
        "Compound action: navigate to a login page, fill credentials, and submit. Handles the full login flow in one call.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Login page URL (skip if already on login page)"),
        username: z.string().describe("Username or email"),
        password: z.string().describe("Password"),
        username_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for username field (auto-detected if omitted)",
          ),
        password_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for password field (auto-detected if omitted)",
          ),
        submit_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for submit button (auto-detected if omitted)",
          ),
      }),
    },
    async ({
      url,
      username,
      password,
      username_selector,
      password_selector,
      submit_selector,
    }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "login",
        { url, username: username.slice(0, 3) + "***" },
        async () => {
          const wc = tab.view.webContents;
          const steps: string[] = [];

          // Step 1: Navigate if URL provided
          if (url) {
            const id = tabManager.getActiveTabId();
            if (!id) return asNoActiveTabResponse();
            tabManager.navigateTab(id, url);
            await waitForLoad(wc);
            steps.push(`Navigated to ${wc.getURL()}`);
          }

          // Step 2: Find form fields
          const userSel =
            username_selector ||
            (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[name="user"], input[autocomplete="username"], input[autocomplete="email"], input[type="text"]:not([name="search"]):not([name="q"])');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
          if (!userSel)
            return "Error: Could not find username/email field. Try providing username_selector.";

          const passSel =
            password_selector ||
            (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="password"]');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
          if (!passSel)
            return "Error: Could not find password field. Try providing password_selector.";

          // Step 3: Fill credentials
          const userResult = await setElementValue(wc, userSel, username);
          steps.push(userResult);
          const passResult = await setElementValue(wc, passSel, password);
          steps.push(passResult);

          // Step 4: Submit
          const beforeUrl = wc.getURL();
          if (submit_selector) {
            await clickResolvedSelector(wc, submit_selector);
          } else {
            // Try to find and click a submit button
            const clicked = await wc.executeJavaScript(`
              (function() {
                var btn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type="button"])');
                if (btn) { btn.click(); return true; }
                var form = document.querySelector('input[type="password"]')?.closest('form');
                if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; }
                return false;
              })()
            `);
            if (!clicked)
              return (
                steps.join("\n") +
                "\nWarning: Could not find submit button. Credentials filled but form not submitted."
              );
          }

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          steps.push(
            afterUrl !== beforeUrl
              ? `Submitted → ${afterUrl}`
              : "Form submitted (same page)",
          );

          return `Login flow complete:\n${steps.join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Compound action: find a search box on the current page, type a query, and submit. Returns the resulting page state.",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for search input (auto-detected if omitted)"),
      }),
    },
    async ({ query, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      // Guard: reject queries that look like button/UI labels, not search terms
      const qLower = query.toLowerCase().trim();
      const buttonLabels = [
        "add to cart",
        "add to bag",
        "add to basket",
        "buy now",
        "buy it now",
        "purchase",
        "continue shopping",
        "keep shopping",
        "view cart",
        "view bag",
        "view basket",
        "go to cart",
        "go to checkout",
        "checkout",
        "check out",
        "proceed to checkout",
        "place order",
        "submit",
        "subscribe",
        "sign up",
        "sign in",
        "log in",
        "register",
        "continue",
      ];
      if (buttonLabels.some((p) => qLower.includes(p))) {
        return asTextResponse(
          `Error: "${query}" looks like a button label, not a search query. Use the click tool to interact with this element instead.`,
        );
      }

      return withAction(runtime, tabManager, "search", { query }, async () => {
        const wc = tab.view.webContents;

        // Find search input
        const searchSel =
          selector ||
          (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[role="searchbox"], input[aria-label*="search" i], input[placeholder*="search" i]');
                if (!el) {
                  var inputs = document.querySelectorAll('input[type="text"]');
                  for (var i = 0; i < inputs.length; i++) {
                    var form = inputs[i].closest('form');
                    if (form && (form.getAttribute('role') === 'search' || form.action?.includes('search'))) {
                      el = inputs[i];
                      break;
                    }
                  }
                }
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
        if (!searchSel)
          return "Error: Could not find search input. Try providing a selector.";

        // Type query
        await setElementValue(wc, searchSel, query);

        // Focus input and press Enter via native Chromium input events
        // (JS dispatchEvent doesn't work on sites like Google that use custom handlers)
        await wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(searchSel)});
              if (el) el.focus();
            })()
          `);
        await new Promise((r) => setTimeout(r, 50));
        const beforeUrl = wc.getURL();
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        await new Promise((r) => setTimeout(r, 16));
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });

        await waitForPotentialNavigation(wc, beforeUrl);
        const afterUrl = wc.getURL();
        return afterUrl !== beforeUrl
          ? `Searched "${query}" → ${afterUrl}`
          : `Searched "${query}" (same page — results may have loaded dynamically)`;
      });
    },
  );

  server.registerTool(
    "paginate",
    {
      title: "Paginate",
      description:
        "Navigate to the next or previous page of results. Auto-detects pagination controls.",
      inputSchema: z.object({
        direction: z.enum(["next", "prev"]).describe("Pagination direction"),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for the pagination link (auto-detected if omitted)",
          ),
      }),
    },
    async ({ direction, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "paginate",
        { direction },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();

          if (selector) {
            return clickResolvedSelector(wc, selector);
          }

          // Auto-detect pagination
          const isNext = direction === "next";
          const clicked = await wc.executeJavaScript(`
            (function() {
              var patterns = ${
                isNext
                  ? '["next", "Next", "›", "»", "→", ">", "Next Page", "Load More"]'
                  : '["prev", "Prev", "Previous", "‹", "«", "←", "<", "Previous Page"]'
              };
              var links = document.querySelectorAll('a, button');
              for (var i = 0; i < links.length; i++) {
                var el = links[i];
                var text = (el.textContent || '').trim();
                var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                var rel = (el.getAttribute('rel') || '').toLowerCase();
                if (rel === '${isNext ? "next" : "prev"}') { el.click(); return true; }
                for (var j = 0; j < patterns.length; j++) {
                  if (text === patterns[j] || ariaLabel.includes(patterns[j].toLowerCase())) {
                    el.click();
                    return true;
                  }
                }
              }
              return false;
            })()
          `);

          if (!clicked)
            return `Error: Could not find ${direction} pagination control. Try providing a selector.`;

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `Paginated ${direction} → ${afterUrl}`
            : `Clicked ${direction} (page may have updated dynamically)`;
        },
      );
    },
  );

}
