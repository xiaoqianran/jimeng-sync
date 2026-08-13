const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { create } = require("../lib/db-sqlite");

const dbPath = path.join(os.tmpdir(), "jimeng-test-" + Date.now() + ".db");
const db = create(dbPath);

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
  }
});

test("collect then annotate then remote LWW", () => {
  db.upsertCollected({ work_id: "w1", prompt: "cat", author: "a" }, "dev-local");
  db.applyLocalMutation("w1", { notes: "mine", favorite: 1 }, "dev-local");
  db.applyRemoteChange({
    work_id: "w1",
    prompt: "cat",
    author: "a",
    notes: "theirs",
    favorite: 0,
    updated_at: Date.now() + 10_000,
    device_id: "dev-remote",
  }, "dev-local");
  const row = db.get("w1");
  assert.equal(row.notes, "theirs");
  assert.equal(row.favorite, 0);
  assert.equal(row.dirty, 0);
});

test("acknowledgePush stores remote_rev and echo apply is skipped", () => {
  db.upsertCollected({ work_id: "w-echo", prompt: "echo" }, "dev-local");
  db.acknowledgePush([{ work_id: "w-echo", remote_rev: 7 }]);
  const afterAck = db.get("w-echo");
  assert.equal(afterAck.dirty, 0);
  assert.equal(afterAck.remote_rev, 7);
  db.applyRemoteChange({
    work_id: "w-echo",
    prompt: "echo",
    notes: "should-not-apply",
    remote_rev: 7,
    device_id: "dev-local",
    updated_at: Date.now(),
  }, "dev-local");
  assert.equal(db.get("w-echo").notes, afterAck.notes);
});

test("copying db onto a new device resets pull cursor", () => {
  db.setMeta("last_pull_rev", "42");
  db.setMeta("snapshot_done", "1");
  db.ensureDeviceBinding("device-a");
  const rebound = db.ensureDeviceBinding("device-b");
  assert.equal(rebound.rebound, true);
  assert.equal(db.getMeta("last_pull_rev"), "0");
  assert.equal(db.getMeta("snapshot_done"), "");
});

test("expired tombstones can be purged", () => {
  db.upsertCollected({ work_id: "w-old-del", prompt: "gone" }, "dev-local");
  const row = db.get("w-old-del");
  db.applyLocalMutation("w-old-del", { deleted_at: Date.now() - 10_000 }, "dev-local");
  const purged = db.purgeTombstones(1000);
  assert.ok(purged >= 1);
  assert.equal(db.get("w-old-del"), null);
  assert.ok(row);
});

test("soft delete is dirty tombstone", () => {
  db.upsertCollected({ work_id: "w2", prompt: "dog" }, "dev-local");
  db.softDelete("w2", "dev-local");
  const row = db.get("w2");
  assert.ok(row.deleted_at);
  assert.equal(row.dirty, 1);
  const listed = db.list({ includeDeleted: false });
  assert.equal(listed.items.some((i) => i.work_id === "w2"), false);
});
