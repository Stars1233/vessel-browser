import { dialog, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Channels } from "../../shared/channels";
import type { DownloadRecord } from "../../shared/types";
import {
  DownloadRecordSchema,
  parseArrayStateWithFallback,
} from "../../shared/persistence-schemas";
import { PersistentState } from "../persistence/persistent-state";

const EXECUTABLE_EXTENSIONS = new Set([
  ".appimage",
  ".bat",
  ".cmd",
  ".command",
  ".desktop",
  ".exe",
  ".msi",
  ".ps1",
  ".scr",
  ".sh",
]);

const DOWNLOADS_FALLBACK = { items: [] as DownloadRecord[] };

export type DownloadRecordInput = Omit<DownloadRecord, "id" | "startedAt" | "updatedAt">;

export interface DownloadRecordStore {
  clear: () => void;
  get: (id: string) => DownloadRecord | undefined;
  list: () => DownloadRecord[];
  upsert: (input: DownloadRecordInput) => DownloadRecord;
}

function hasMisleadingDoubleExtension(filename: string): boolean {
  return /\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|txt|zip)\.(exe|msi|bat|cmd|ps1|sh|scr|appimage)$/i.test(
    filename,
  );
}

function isExecutableDownload(savePath: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(path.extname(savePath).toLowerCase());
}

function executableWarningDetail(item: DownloadRecord): string {
  return [
    "This file can run code on your computer. Only open it if you trust the source.",
    item.url ? `Source: ${item.url}` : null,
    item.mimeType ? `Type: ${item.mimeType}` : null,
    hasMisleadingDoubleExtension(item.filename)
      ? "Warning: this filename uses a misleading double extension."
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const store = new PersistentState<{ items: DownloadRecord[] }>({
  filename: "vessel-downloads.json",
  fallback: DOWNLOADS_FALLBACK,
  parse: (raw: unknown) =>
    parseArrayStateWithFallback(
      DownloadRecordSchema,
      raw,
      "items",
      DOWNLOADS_FALLBACK,
      "downloads",
    ),
  logLabel: "downloads",
  debounceMs: 250,
});

let broadcaster: ((channel: string, payload: unknown) => void) | null = null;

function emit(): void {
  broadcaster?.(Channels.DOWNLOADS_UPDATE, listDownloads());
}

export function setDownloadBroadcaster(fn: (channel: string, payload: unknown) => void): void {
  broadcaster = fn;
}

export function listDownloads(): DownloadRecord[] {
  return store.getState().items.map((item) => ({ ...item }));
}

export function upsertDownload(input: DownloadRecordInput): DownloadRecord {
  const now = new Date().toISOString();
  const result = store.mutate((s) => {
    const existing = s.items.find((item) => item.savePath === input.savePath);
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      return existing;
    } else {
      const record: DownloadRecord = { id: randomUUID(), ...input, startedAt: now, updatedAt: now };
      s.items = [record, ...s.items];
      s.items = s.items.slice(0, 200);
      return record;
    }
  });
  emit();
  return result;
}

export function clearDownloads(): void {
  store.mutate((s) => {
    s.items = [];
  });
  emit();
}

export const persistentDownloadStore: DownloadRecordStore = {
  clear: clearDownloads,
  get: (id) => {
    const record = store.getState().items.find((item) => item.id === id);
    return record ? { ...record } : undefined;
  },
  list: listDownloads,
  upsert: (input) => ({ ...upsertDownload(input) }),
};

export function createInMemoryDownloadStore(): DownloadRecordStore {
  const records = new Map<string, DownloadRecord>();

  return {
    clear: () => records.clear(),
    get: (id) => {
      const record = records.get(id);
      return record ? { ...record } : undefined;
    },
    list: () => [...records.values()].reverse().map((record) => ({ ...record })),
    upsert: (input) => {
      const now = new Date().toISOString();
      const existing = [...records.values()].find((record) => record.savePath === input.savePath);
      const record: DownloadRecord = existing
        ? { ...existing, ...input, updatedAt: now }
        : {
            id: randomUUID(),
            ...input,
            startedAt: now,
            updatedAt: now,
          };
      records.set(record.id, record);
      if (records.size > 200) {
        const oldestId = records.keys().next().value;
        if (oldestId) records.delete(oldestId);
      }
      return { ...record };
    },
  };
}

export async function openDownload(id: string): Promise<boolean> {
  const item = store.getState().items.find((d) => d.id === id);
  return openDownloadRecord(item);
}

export async function openDownloadRecord(item: DownloadRecord | undefined): Promise<boolean> {
  if (!item || item.state !== "completed" || !fs.existsSync(item.savePath)) return false;
  if (isExecutableDownload(item.savePath)) {
    const result = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Cancel", "Open Anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "Open executable download?",
      message: `Open ${item.filename}?`,
      detail: executableWarningDetail(item),
    });
    if (result !== 1) return false;
  }
  return (await shell.openPath(item.savePath)) === "";
}

export async function showDownloadInFolder(id: string): Promise<boolean> {
  const item = store.getState().items.find((d) => d.id === id);
  return showDownloadRecordInFolder(item);
}

export async function showDownloadRecordInFolder(
  item: DownloadRecord | undefined,
): Promise<boolean> {
  if (!item || !fs.existsSync(item.savePath)) return false;
  shell.showItemInFolder(item.savePath);
  return true;
}
