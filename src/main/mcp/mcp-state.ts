import http from "node:http";
import type { McpHttpHandler } from "@modelcontextprotocol/server";

export interface McpRuntimeHandle {
  httpServer: http.Server;
  mcpHandler: McpHttpHandler;
  authToken: string;
}

export interface McpRuntimeState {
  active: McpRuntimeHandle | null;
}

export const mcpRuntimeState: McpRuntimeState = {
  active: null,
};
