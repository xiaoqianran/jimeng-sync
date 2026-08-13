const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mergeRecords, mergeContent, lwwCompare, contentRicherThan } = require("../lib/merge");
const { normalizeRecord } = require("../lib/record");

function rec(overrides) {
  return normalizeRecord({
    work_id: "w1",
    prompt: "a cat",
    author: "alice",
    model: "v1",
    image_url: "http://img/a",
    collected_at: 1000,
    updated_at: 2000,
    device_id: "dev-a",
    favorite: false,
    tags: [],
    notes: "",
    ...overrides,
  });
}

test("content merge never overwrites with empty", () => {
  const local = rec({ image_high: "http://hi", notes: "keep" });
  const incoming = rec({ image_high: "", prompt: "a cat sitting", updated_at: 3000, device_id: "dev-b" });
  const merged = mergeContent(local, incoming);
  assert.equal(merged.image_high, "http://hi");
  assert.equal(merged.prompt, "a cat sitting");
});

test("annotation LWW: newer device wins notes/favorite/tags", () => {
  const local = rec({ notes: "old", favorite: 1, tags: ["a"], updated_at: 2000, device_id: "dev-a" });
  const incoming = rec({ notes: "new", favorite: 0, tags: ["b"], updated_at: 5000, device_id: "dev-b" });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.notes, "new");
  assert.equal(merged.favorite, 0);
  assert.equal(JSON.parse(merged.tags)[0], "b");
  assert.equal(merged.device_id, "dev-b");
  assert.equal(merged.dirty, 0);
});

test("older remote cannot overwrite newer local annotations", () => {
  const local = rec({ notes: "local-new", updated_at: 9000, device_id: "dev-a", dirty: 1 });
  const incoming = rec({ notes: "remote-old", updated_at: 1000, device_id: "dev-b" });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.notes, "local-new");
  assert.equal(merged.dirty, 1);
});

test("delete tombstone follows LWW", () => {
  const local = rec({ updated_at: 2000, device_id: "dev-a" });
  const incoming = rec({ deleted_at: 8000, updated_at: 8000, device_id: "dev-b" });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.deleted_at, 8000);
});

test("newer undelete resurrects tombstone", () => {
  const local = rec({ deleted_at: 3000, updated_at: 3000, device_id: "dev-a" });
  const incoming = rec({ deleted_at: null, notes: "restored", updated_at: 9000, device_id: "dev-b" });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.deleted_at, null);
  assert.equal(merged.notes, "restored");
});

test("applying remote to clean row does not mark dirty", () => {
  const local = rec({ dirty: 0, updated_at: 1000 });
  const incoming = rec({ notes: "from-remote", updated_at: 4000, device_id: "dev-b" });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.dirty, 0);
});

test("remote wins but local has richer content stays dirty", () => {
  const local = rec({
    image_high: "http://very-long-high-res-url/x",
    notes: "old",
    updated_at: 1000,
    dirty: 0,
  });
  const incoming = rec({
    image_high: "",
    notes: "remote-notes",
    updated_at: 8000,
    device_id: "dev-b",
  });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.notes, "remote-notes");
  assert.equal(merged.image_high, "http://very-long-high-res-url/x");
  assert.equal(merged.dirty, 1);
  assert.equal(contentRicherThan(merged, incoming), true);
});

test("tie on updated_at is broken by device_id deterministically", () => {
  const a = rec({ updated_at: 5000, device_id: "aaa", notes: "a" });
  const b = rec({ updated_at: 5000, device_id: "bbb", notes: "b" });
  assert.ok(lwwCompare(a, b) < 0);
  const merged = mergeRecords(a, b, { incomingIsRemote: true });
  assert.equal(merged.notes, "b");
});

test("higher remote_rev wins even if client clock is older", () => {
  const local = rec({ notes: "local", updated_at: 9000, device_id: "dev-a", remote_rev: 5 });
  const incoming = rec({ notes: "server", updated_at: 1000, device_id: "dev-b", remote_rev: 9 });
  const merged = mergeRecords(local, incoming, { incomingIsRemote: true });
  assert.equal(merged.notes, "server");
  assert.equal(merged.remote_rev, 9);
});

test("stale push loses when base_rev is behind server", () => {
  const server = rec({ notes: "server-new", remote_rev: 8, updated_at: 1000, device_id: "dev-b" });
  const incoming = rec({ notes: "stale-client", base_rev: 5, updated_at: 99999, device_id: "dev-a" });
  const merged = mergeRecords(server, incoming, { useBaseRev: true });
  assert.equal(merged.notes, "server-new");
});

test("up-to-date push wins when base_rev matches server", () => {
  const server = rec({ notes: "server-old", remote_rev: 8, updated_at: 1000, device_id: "dev-b" });
  const incoming = rec({ notes: "client-new", base_rev: 8, updated_at: 2000, device_id: "dev-a" });
  const merged = mergeRecords(server, incoming, { useBaseRev: true });
  assert.equal(merged.notes, "client-new");
});

test("new incoming without local is dirty only when not remote", () => {
  const incoming = rec();
  const localWrite = mergeRecords(null, incoming, { incomingIsRemote: false });
  const remoteWrite = mergeRecords(null, incoming, { incomingIsRemote: true });
  assert.equal(localWrite.dirty, 1);
  assert.equal(remoteWrite.dirty, 0);
});
