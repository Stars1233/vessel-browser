import fs from "node:fs";
import path from "node:path";
import type { Bookmark, PageContent } from "../../shared/types";
import { loadSettings } from "../config/settings";

const DEFAULT_PAGE_FOLDER = "Vessel/Pages";
const DEFAULT_NOTE_FOLDER = "Vessel/Research";
const DEFAULT_BOOKMARK_FOLDER = "Vessel/Bookmarks";
const PAGE_CONTENT_LIMIT = 6000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;
const { access, lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } = fs.promises;

export interface SavedMemoryNote {
  title: string;
  absolutePath: string;
  relativePath: string;
}

export interface MemoryNoteSummary extends SavedMemoryNote {
  modifiedAt: string;
  tags: string[];
}

interface WriteMemoryNoteInput {
  title: string;
  body: string;
  folder?: string;
  tags?: string[];
  frontmatter?: Record<string, string | string[] | undefined>;
}

interface CapturePageNoteInput {
  page: PageContent;
  title?: string;
  folder?: string;
  summary?: string;
  note?: string;
  tags?: string[];
}

interface ListMemoryNotesInput {
  folder?: string;
  limit?: number;
}

interface SearchMemoryNotesInput {
  query: string;
  folder?: string;
  tags?: string[];
  limit?: number;
}

interface AppendMemoryNoteInput {
  notePath: string;
  content: string;
  heading?: string;
}

interface LinkBookmarkToMemoryInput {
  bookmark: Bookmark;
  notePath?: string;
  title?: string;
  folder?: string;
  note?: string;
  tags?: string[];
}

function getVaultRoot(): string {
  const configured = loadSettings().obsidianVaultPath.trim();
  if (!configured) {
    throw new Error(
      "Obsidian not configured. Set vault path in Vessel settings to use memory capture.",
    );
  }
  return path.resolve(configured);
}

function assertInsideVault(targetPath: string, vaultRoot: string): string {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(vaultRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved note path is outside the configured vault.");
  }
  return resolved;
}

async function canonicalVaultRoot(create: true): Promise<string>;
async function canonicalVaultRoot(create?: false): Promise<string | null>;
async function canonicalVaultRoot(create = false): Promise<string | null> {
  const root = getVaultRoot();
  if (create) await mkdir(root, { recursive: true });
  if (!(await pathExists(root))) return null;
  return await realpath(root);
}

async function rejectSymlinkComponents(vaultRoot: string, targetPath: string): Promise<void> {
  const relative = path.relative(vaultRoot, assertInsideVault(targetPath, vaultRoot));
  let current = vaultRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed in configured vault paths.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function resolveExistingVaultPath(vaultRoot: string, targetPath: string): Promise<string> {
  await rejectSymlinkComponents(vaultRoot, targetPath);
  return assertInsideVault(await realpath(targetPath), vaultRoot);
}

function normalizeFolder(folder: string | undefined, fallback: string): string {
  const raw = (folder?.trim() || fallback).replace(/\\/g, "/");
  if (!raw) return fallback;
  if (path.isAbsolute(raw)) {
    throw new Error("Vault note folders must be relative to the vault root.");
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Vault note folders cannot traverse outside the vault.");
  }
  return segments.join(path.sep);
}

function normalizeNotePath(notePath: string): string {
  const raw = notePath.trim().replace(/\\/g, "/");
  if (!raw) {
    throw new Error("A note path is required.");
  }
  if (path.isAbsolute(raw)) {
    throw new Error("Note paths must be relative to the vault root.");
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Note paths cannot traverse outside the vault.");
  }
  const normalized = segments.join(path.sep);
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

function renderFrontmatter(data: Record<string, string | string[] | undefined>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${escapeYaml(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${escapeYaml(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "note";
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildUniqueNotePath(dir: string, title: string): Promise<string> {
  const datePrefix = new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  const base = `${datePrefix}-${slug}`;
  let candidate = `${base}.md`;
  let counter = 2;
  while (await pathExists(path.join(dir, candidate))) {
    candidate = `${base}-${counter}.md`;
    counter += 1;
  }
  return path.join(dir, candidate);
}

function trimContent(content: string, limit = PAGE_CONTENT_LIMIT): string {
  const cleaned = content.trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit)}\n\n[Truncated]`;
}

function parseFrontmatter(content: string): {
  body: string;
  title?: string;
  tags: string[];
} {
  if (!content.startsWith("---\n")) {
    return { body: content, tags: [] };
  }

  const closingIndex = content.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return { body: content, tags: [] };
  }

  const raw = content.slice(4, closingIndex);
  const body = content.slice(closingIndex + 5);
  const lines = raw.split("\n");
  const result: { title?: string; tags: string[] } = { tags: [] };
  let activeArrayKey = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("- ") && activeArrayKey === "tags") {
      result.tags.push(
        trimmed
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
      continue;
    }

    activeArrayKey = "";
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key === "title" && value) {
      result.title = value.replace(/^["']|["']$/g, "");
    } else if (key === "tags") {
      activeArrayKey = "tags";
      if (value.startsWith("[") && value.endsWith("]")) {
        const inline = value
          .slice(1, -1)
          .split(",")
          .map((item) => item.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        result.tags.push(...inline);
        activeArrayKey = "";
      }
    }
  }

  return { body, title: result.title, tags: result.tags };
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectMarkdownFiles(absolutePath);
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        return [absolutePath];
      }
      return [];
    }),
  );

  return nestedFiles.flat();
}

async function toSummary(
  absolutePath: string,
  vaultRoot: string,
  raw?: string,
): Promise<MemoryNoteSummary> {
  const stats = await stat(absolutePath);
  const relativePath = path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
  const noteContent = raw ?? (await readFile(absolutePath, "utf-8"));
  const parsed = parseFrontmatter(noteContent);
  const headingMatch = parsed.body.match(/^#\s+(.+)$/m);
  const title = parsed.title || headingMatch?.[1]?.trim() || path.basename(absolutePath, ".md");

  return {
    title,
    absolutePath,
    relativePath,
    modifiedAt: stats.mtime.toISOString(),
    tags: parsed.tags,
  };
}

function renderBookmarkLinkBlock(bookmark: Bookmark, note?: string): string {
  const lines = [
    "## Linked Bookmark",
    "",
    `- Bookmark ID: \`${bookmark.id}\``,
    `- Title: ${bookmark.title || bookmark.url}`,
    `- URL: [${bookmark.url}](${bookmark.url})`,
    `- Saved At: ${bookmark.savedAt}`,
  ];

  if (note?.trim()) {
    lines.push("", "### Context", "", note.trim());
  }

  return `${lines.join("\n")}\n`;
}

export async function writeMemoryNote({
  title,
  body,
  folder,
  tags = [],
  frontmatter = {},
}: WriteMemoryNoteInput): Promise<SavedMemoryNote> {
  const vaultRoot = await canonicalVaultRoot(true);
  const relativeFolder = normalizeFolder(folder, DEFAULT_NOTE_FOLDER);
  const targetDir = path.join(vaultRoot, relativeFolder);
  await rejectSymlinkComponents(vaultRoot, targetDir);
  await mkdir(targetDir, { recursive: true });
  await resolveExistingVaultPath(vaultRoot, targetDir);

  const absolutePath = await buildUniqueNotePath(targetDir, title);
  const relativePath = path.relative(vaultRoot, absolutePath);
  const content = [
    renderFrontmatter({
      title,
      created_at: new Date().toISOString(),
      tags,
      ...frontmatter,
    }),
    body.trim(),
    "",
  ].join("\n");

  await writeFile(absolutePath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });

  return {
    title,
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

export async function appendToMemoryNote({
  notePath,
  content,
  heading,
}: AppendMemoryNoteInput): Promise<SavedMemoryNote> {
  const vaultRoot = await canonicalVaultRoot();
  const relativePath = normalizeNotePath(notePath);
  if (!vaultRoot) {
    throw new Error(`Memory note not found: ${relativePath.split(path.sep).join("/")}`);
  }
  let absolutePath = assertInsideVault(path.join(vaultRoot, relativePath), vaultRoot);
  if (!(await pathExists(absolutePath))) {
    throw new Error(`Memory note not found: ${relativePath.split(path.sep).join("/")}`);
  }
  absolutePath = await resolveExistingVaultPath(vaultRoot, absolutePath);

  const handle = await open(absolutePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const current = (await handle.readFile("utf-8")).trimEnd();
    const nextParts = [current, ""];
    if (heading?.trim()) {
      nextParts.push(`## ${heading.trim()}`, "");
    }
    nextParts.push(content.trim(), "");
    await handle.truncate(0);
    await handle.write(nextParts.join("\n"), 0, "utf-8");
  } finally {
    await handle.close();
  }

  return {
    title: path.basename(absolutePath, ".md"),
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

export async function listMemoryNotes({
  folder,
  limit = DEFAULT_LIST_LIMIT,
}: ListMemoryNotesInput = {}): Promise<MemoryNoteSummary[]> {
  const vaultRoot = await canonicalVaultRoot();
  if (!vaultRoot) return [];
  const relativeFolder = normalizeFolder(folder, "");
  const targetDir = relativeFolder ? path.join(vaultRoot, relativeFolder) : vaultRoot;

  if (!(await pathExists(targetDir))) {
    return [];
  }
  const safeTargetDir = await resolveExistingVaultPath(vaultRoot, targetDir);

  const notes = await Promise.all(
    (await collectMarkdownFiles(safeTargetDir)).map((absolutePath) =>
      toSummary(absolutePath, vaultRoot),
    ),
  );
  return notes
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, Math.max(1, limit));
}

export async function searchMemoryNotes({
  query,
  folder,
  tags = [],
  limit = DEFAULT_SEARCH_LIMIT,
}: SearchMemoryNotesInput): Promise<MemoryNoteSummary[]> {
  const loweredQuery = query.trim().toLowerCase();
  if (!loweredQuery) {
    throw new Error("A non-empty memory search query is required.");
  }

  const vaultRoot = await canonicalVaultRoot();
  if (!vaultRoot) return [];
  const relativeFolder = normalizeFolder(folder, "");
  const targetDir = relativeFolder ? path.join(vaultRoot, relativeFolder) : vaultRoot;

  if (!(await pathExists(targetDir))) {
    return [];
  }
  const safeTargetDir = await resolveExistingVaultPath(vaultRoot, targetDir);

  const loweredTags = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);

  const matches = await Promise.all(
    (await collectMarkdownFiles(safeTargetDir)).map(async (absolutePath) => {
      const raw = await readFile(absolutePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const summary = await toSummary(absolutePath, vaultRoot, raw);
      const haystack = `${summary.title}\n${summary.relativePath}\n${parsed.body}`.toLowerCase();
      const hasQuery = haystack.includes(loweredQuery);
      const hasTags =
        loweredTags.length === 0 ||
        loweredTags.every((tag) => summary.tags.some((noteTag) => noteTag.toLowerCase() === tag));

      return hasQuery && hasTags ? summary : null;
    }),
  );
  return matches
    .filter((item): item is MemoryNoteSummary => item !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, Math.max(1, limit));
}

export async function capturePageToVault({
  page,
  title,
  folder,
  summary,
  note,
  tags = [],
}: CapturePageNoteInput): Promise<SavedMemoryNote> {
  const noteTitle = title?.trim() || page.title.trim() || page.url;
  const bodyLines = [
    `# ${noteTitle}`,
    "",
    `Source: [${page.title || page.url}](${page.url})`,
    `Captured: ${new Date().toISOString()}`,
  ];

  if (page.byline) {
    bodyLines.push(`Byline: ${page.byline}`);
  }

  bodyLines.push("");

  if (summary?.trim()) {
    bodyLines.push("## Summary", "", summary.trim(), "");
  }

  if (note?.trim()) {
    bodyLines.push("## Research Note", "", note.trim(), "");
  }

  if (page.excerpt.trim()) {
    bodyLines.push("## Excerpt", "", page.excerpt.trim(), "");
  }

  const snapshot = trimContent(page.content);
  if (snapshot) {
    bodyLines.push("## Page Snapshot", "", snapshot, "");
  }

  return await writeMemoryNote({
    title: noteTitle,
    body: bodyLines.join("\n"),
    folder: folder || DEFAULT_PAGE_FOLDER,
    tags,
    frontmatter: {
      source_url: page.url,
      source_title: page.title || page.url,
    },
  });
}

export async function linkBookmarkToMemory({
  bookmark,
  notePath,
  title,
  folder,
  note,
  tags = [],
}: LinkBookmarkToMemoryInput): Promise<SavedMemoryNote> {
  if (notePath?.trim()) {
    return await appendToMemoryNote({
      notePath,
      heading: "Linked Bookmark",
      content: [
        `- Bookmark ID: \`${bookmark.id}\``,
        `- Title: ${bookmark.title || bookmark.url}`,
        `- URL: [${bookmark.url}](${bookmark.url})`,
        `- Saved At: ${bookmark.savedAt}`,
        note?.trim() ? `- Note: ${note.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const noteTitle = title?.trim() || bookmark.title || bookmark.url;
  return await writeMemoryNote({
    title: noteTitle,
    body: renderBookmarkLinkBlock(bookmark, note),
    folder: folder || DEFAULT_BOOKMARK_FOLDER,
    tags,
    frontmatter: {
      bookmark_id: bookmark.id,
      source_url: bookmark.url,
      source_title: bookmark.title || bookmark.url,
    },
  });
}
