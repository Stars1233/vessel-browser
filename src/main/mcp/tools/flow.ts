import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import { coerceStringArray, stringArrayLikeSchema } from "../../tools/input-coercion";
import { asTextResponse, getPremiumToolGateResponse } from "../mcp-helpers";

export function registerFlowTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "flow_start",
    {
      title: "Start Workflow",
      description:
        "Begin tracking a multi-step web workflow. Vessel will show progress after every action so you always know where you are in the flow.",
      inputSchema: z.object({
        goal: z
          .string()
          .describe(
            "What this workflow accomplishes (e.g. 'Purchase item from Amazon')",
          ),
        steps: stringArrayLikeSchema().describe(
          "Ordered list of step labels (e.g. ['Log in', 'Search', 'Select item', 'Checkout'])",
        ),
      }),
    },
    async ({ goal, steps }) => {
      const premiumGate = getPremiumToolGateResponse("flow_start");
      if (premiumGate) return premiumGate;

      const normalizedSteps = coerceStringArray(steps) ?? [];
      const tab = tabManager.getActiveTab();
      const flow = runtime.startFlow(
        goal,
        normalizedSteps,
        tab?.view.webContents.getURL(),
      );
      return asTextResponse(
        `Flow started: ${flow.goal}\n${flow.steps.map((s, i) => `  ${i === 0 ? "→" : " "} ${s.label}`).join("\n")}`,
      );
    },
  );

  server.registerTool(
    "flow_advance",
    {
      title: "Advance Workflow Step",
      description:
        "Mark the current workflow step as done and move to the next one. Call this after completing each step.",
      inputSchema: z.object({
        detail: z
          .string()
          .optional()
          .describe("Brief note about what was accomplished"),
      }),
    },
    async ({ detail }) => {
      const premiumGate = getPremiumToolGateResponse("flow_advance");
      if (premiumGate) return premiumGate;

      const flow = runtime.advanceFlow(detail);
      if (!flow) return asTextResponse("No active flow to advance");
      const ctx = runtime.getFlowContext();
      return asTextResponse(`Step completed.${ctx}`);
    },
  );

  server.registerTool(
    "flow_status",
    {
      title: "Workflow Status",
      description: "Check the current workflow progress.",
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("flow_status");
      if (premiumGate) return premiumGate;

      const flow = runtime.getFlowState();
      if (!flow) return asTextResponse("No active workflow.");
      return asTextResponse(runtime.getFlowContext());
    },
  );

  server.registerTool(
    "flow_end",
    {
      title: "End Workflow",
      description: "Clear the active workflow tracker.",
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("flow_end");
      if (premiumGate) return premiumGate;

      runtime.clearFlow();
      return asTextResponse("Workflow ended.");
    },
  );

  server.registerTool(
    "undo_last_action",
    {
      title: "Undo Last Action",
      description:
        "Undo the most recent agent action by restoring the browser to its state before that action ran. Works for click, type, submit, navigate, and similar mutating actions.",
    },
    async () => {
      const undone = runtime.undoLastAction();
      if (!undone)
        return asTextResponse(
          "Nothing to undo. No undo snapshots available.",
        );
      return asTextResponse(
        `Undid action: ${undone}. Browser restored to state before that action.`,
      );
    },
  );

}
