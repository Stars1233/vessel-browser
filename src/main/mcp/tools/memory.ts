import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import { extractContent } from "../../content/extractor";
import {
  appendToMemoryNote,
  capturePageToVault,
  listMemoryNotes,
  searchMemoryNotes,
  writeMemoryNote,
} from "../../memory/obsidian";
import type { TabManager } from "../../tabs/tab-manager";
import { asNoActiveTabResponse, withAction } from "../mcp-helpers";

export function registerMemoryTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "memory_note_create",
    {
      title: "Create Memory Note",
      description:
        "Write a markdown note into the configured Obsidian vault for research notes, breadcrumbs, or synthesis.",
      inputSchema: z.object({
        title: z.string().describe("Title of the note"),
        body: z.string().describe("Markdown body for the note"),
        folder: z
          .string()
          .optional()
          .describe(
            "Relative folder inside the vault (default: Vessel/Research)",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags to store in frontmatter"),
      }),
    },
    async ({ title, body, folder, tags }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_create",
        { title, folder, tags },
        async () => {
          const saved = await writeMemoryNote({ title, body, folder, tags });
          return `Saved memory note "${saved.title}" to ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "memory_append",
    {
      title: "Append Memory Note",
      description:
        "Append markdown content to an existing note in the configured Obsidian vault.",
      inputSchema: z.object({
        note_path: z
          .string()
          .describe("Relative path to an existing note inside the vault"),
        content: z.string().describe("Markdown content to append"),
        heading: z
          .string()
          .optional()
          .describe("Optional section heading to add before the content"),
      }),
    },
    async ({ note_path, content, heading }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_append",
        { note_path, heading },
        async () => {
          const saved = await appendToMemoryNote({
            notePath: note_path,
            content,
            heading,
          });
          return `Appended memory note at ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List Memory Notes",
      description:
        "List recent markdown notes in the configured Obsidian vault.",
      inputSchema: z.object({
        folder: z
          .string()
          .optional()
          .describe("Optional relative folder inside the vault"),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Maximum number of notes to return"),
      }),
    },
    async ({ folder, limit }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_list",
        { folder, limit },
        async () => {
          const notes = await listMemoryNotes({ folder, limit });
          if (notes.length === 0) {
            return "No memory notes found.";
          }
          return notes
            .map(
              (note) =>
                `- ${note.title} | path=${note.relativePath} | modified=${note.modifiedAt}${note.tags.length ? ` | tags=${note.tags.join(",")}` : ""}`,
            )
            .join("\n");
        },
      );
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search Memory Notes",
      description:
        "Search markdown notes in the configured Obsidian vault by title, path, body, and optional tags.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        folder: z
          .string()
          .optional()
          .describe("Optional relative folder inside the vault"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags that matching notes must contain"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum number of matching notes to return"),
      }),
    },
    async ({ query, folder, tags, limit }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_search",
        { query, folder, tags, limit },
        async () => {
          const notes = await searchMemoryNotes({ query, folder, tags, limit });
          if (notes.length === 0) {
            return `No memory notes matched "${query}".`;
          }
          return notes
            .map(
              (note) =>
                `- ${note.title} | path=${note.relativePath} | modified=${note.modifiedAt}${note.tags.length ? ` | tags=${note.tags.join(",")}` : ""}`,
            )
            .join("\n");
        },
      );
    },
  );

  server.registerTool(
    "memory_page_capture",
    {
      title: "Capture Page To Memory",
      description:
        "Capture the current page into the configured Obsidian vault as a markdown note with URL, excerpt, and content snapshot.",
      inputSchema: z.object({
        title: z.string().optional().describe("Optional note title override"),
        folder: z
          .string()
          .optional()
          .describe("Relative folder inside the vault (default: Vessel/Pages)"),
        summary: z
          .string()
          .optional()
          .describe("Optional summary written into the note"),
        note: z
          .string()
          .optional()
          .describe("Optional research note or breadcrumb"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags to store in frontmatter"),
      }),
    },
    async ({ title, folder, summary, note, tags }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "memory_page_capture",
        { title, folder, tags },
        async () => {
          const page = await extractContent(tab.view.webContents);
          const saved = await capturePageToVault({
            page,
            title,
            folder,
            summary,
            note,
            tags,
          });
          return `Captured page "${saved.title}" to ${saved.relativePath}`;
        },
      );
    },
  );
}
