import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryDownloadStore } from "../src/main/network/download-manager";

function downloadInput(savePath: string, receivedBytes = 0) {
  return {
    filename: savePath.split("/").at(-1) || "download",
    savePath,
    totalBytes: 10,
    receivedBytes,
    state: "progressing" as const,
  };
}

test("in-memory download stores expose the records they own", () => {
  const store = createInMemoryDownloadStore();
  const first = store.upsert(downloadInput("/tmp/first.txt"));
  const second = store.upsert(downloadInput("/tmp/second.txt"));

  assert.equal(store.get(first.id)?.savePath, "/tmp/first.txt");
  assert.deepEqual(
    store.list().map((record) => record.id),
    [second.id, first.id],
  );

  store.clear();
  assert.deepEqual(store.list(), []);
});

test("in-memory download stores update an existing path without changing identity", () => {
  const store = createInMemoryDownloadStore();
  const started = store.upsert(downloadInput("/tmp/file.txt"));
  const updated = store.upsert(downloadInput("/tmp/file.txt", 7));

  assert.equal(updated.id, started.id);
  assert.equal(updated.receivedBytes, 7);
  assert.equal(store.list().length, 1);
});
