import { dialog, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { RUN_SOURCES, RUN_STATUSES } from "../../shared/run-types";
import type { RunManager } from "../runs/manager";
import { assertTrustedIpcSender, parseIpc } from "./common";

const RunIdSchema = z.string().min(1).max(200);
const RunListQuerySchema = z
  .object({
    statuses: z.array(z.enum(RUN_STATUSES)).optional(),
    sources: z.array(z.enum(RUN_SOURCES)).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .optional();

export function registerRunHandlers(
  manager: RunManager,
  sendToRendererViews: (channel: string, ...args: unknown[]) => void,
): void {
  manager.subscribe((runs) => sendToRendererViews(Channels.RUN_UPDATE, runs));

  ipcMain.handle(Channels.RUN_LIST, (event, query: unknown) => {
    assertTrustedIpcSender(event);
    return manager.listRuns(parseIpc(RunListQuerySchema, query, "run query") ?? {});
  });

  ipcMain.handle(Channels.RUN_GET, (event, runId: unknown) => {
    assertTrustedIpcSender(event);
    return manager.getRun(parseIpc(RunIdSchema, runId, "run ID"));
  });

  ipcMain.handle(Channels.RUN_DELETE, (event, runId: unknown) => {
    assertTrustedIpcSender(event);
    return manager.deleteRun(parseIpc(RunIdSchema, runId, "run ID"));
  });

  ipcMain.handle(Channels.RUN_EXPORT, async (event, runId: unknown, format: unknown) => {
    assertTrustedIpcSender(event);
    const id = parseIpc(RunIdSchema, runId, "run ID");
    const exportFormat = parseIpc(z.enum(["json", "markdown"]), format, "run export format");
    const run = manager.getRun(id);
    if (!run) return null;
    const extension = exportFormat === "json" ? "json" : "md";
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export Vessel Run",
      defaultPath: `vessel-run-${id}.${extension}`,
      filters: [
        exportFormat === "json"
          ? { name: "JSON", extensions: ["json"] }
          : { name: "Markdown", extensions: ["md"] },
      ],
    });
    if (canceled || !filePath) return null;
    const content =
      exportFormat === "json"
        ? JSON.stringify(run, null, 2)
        : [
            `# ${run.title}`,
            "",
            `- Status: ${run.status}`,
            `- Source: ${run.source}`,
            `- Started: ${run.startedAt}`,
            `- Finished: ${run.finishedAt ?? "Not finished"}`,
            "",
            `## Goal`,
            "",
            run.goal,
            "",
            `## Output`,
            "",
            run.outputSummary || "No output recorded.",
            "",
            `## Timeline`,
            "",
            ...run.events.map((item) => `- ${item.timestamp} — ${item.summary}`),
            "",
          ].join("\n");
    await fs.writeFile(filePath, content, "utf-8");
    return { filePath };
  });
}
