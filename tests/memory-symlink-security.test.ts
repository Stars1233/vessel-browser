import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSettings, setSetting } from "../src/main/config/settings";
import { appendToMemoryNote, listMemoryNotes, writeMemoryNote } from "../src/main/memory/obsidian";

test("Obsidian writes and appends reject symlink escapes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-vault-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-outside-"));
  const originalVault = loadSettings().obsidianVaultPath;
  t.after(async () => {
    setSetting("obsidianVaultPath", originalVault);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  setSetting("obsidianVaultPath", root);
  await fs.symlink(outside, path.join(root, "linked"));
  await assert.rejects(
    () => writeMemoryNote({ title: "escape", body: "no", folder: "linked" }),
    /Symbolic links/,
  );

  const outsideNote = path.join(outside, "secret.md");
  await fs.writeFile(outsideNote, "unchanged");
  await fs.symlink(outsideNote, path.join(root, "secret.md"));
  await assert.rejects(
    () => appendToMemoryNote({ notePath: "secret.md", content: "changed" }),
    /Symbolic links/,
  );
  assert.equal(await fs.readFile(outsideNote, "utf8"), "unchanged");
  await assert.rejects(() => listMemoryNotes({ folder: "linked" }), /Symbolic links/);
});

test("Obsidian legitimate nested note operations remain functional", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vessel-vault-ok-"));
  const originalVault = loadSettings().obsidianVaultPath;
  t.after(async () => {
    setSetting("obsidianVaultPath", originalVault);
    await fs.rm(root, { recursive: true, force: true });
  });
  setSetting("obsidianVaultPath", root);
  const note = await writeMemoryNote({ title: "Safe Note", body: "first", folder: "nested" });
  await appendToMemoryNote({ notePath: note.relativePath, content: "second" });
  const notes = await listMemoryNotes({ folder: "nested" });
  assert.equal(notes.length, 1);
  assert.match(await fs.readFile(note.absolutePath, "utf8"), /second/);
});
