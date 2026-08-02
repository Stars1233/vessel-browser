import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import { asTextResponse, getPremiumToolGateResponse } from "../mcp-helpers";

export function registerMetricsTools(
  server: McpServer,
  _tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "metrics",
    {
      title: "Session Metrics",
      description:
        "Show performance metrics: total tool calls, average duration, per-tool breakdown.",
      inputSchema: z.object({}),
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("metrics");
      if (premiumGate) return premiumGate;

      const m = runtime.getMetrics();
      const lines = [
        `Session Metrics:`,
        `  Total actions: ${m.totalActions}`,
        `  Completed: ${m.completedActions}`,
        `  Failed: ${m.failedActions}`,
        `  Average duration: ${m.averageDurationMs}ms`,
        ``,
        `Tool breakdown:`,
      ];
      for (const [name, stats] of Object.entries(m.toolBreakdown)) {
        lines.push(
          `  ${name}: ${stats.count} calls, avg ${stats.avgMs}ms${stats.errors > 0 ? `, ${stats.errors} errors` : ""}`,
        );
      }
      return asTextResponse(lines.join("\n"));
    },
  );}
