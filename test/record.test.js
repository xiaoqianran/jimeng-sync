const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRecord, publicRecord, toChange } = require("../lib/record");

test("normalize -> public -> normalize keeps content and annotations", () => {
  const first = normalizeRecord({
    work_id: "w-rt",
    prompt: "round trip",
    author: "ann",
    model: "m1",
    image_url: "http://a",
    image_high: "http://b",
    aspect_ratio: "1:1",
    favorite: true,
    tags: ["x", "y"],
    notes: "hello",
    collected_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_100,
    device_id: "dev-1",
  });
  const pub = publicRecord(first);
  const second = normalizeRecord(pub, { device_id: "dev-1" });
  assert.equal(second.work_id, first.work_id);
  assert.equal(second.prompt, first.prompt);
  assert.equal(second.author, first.author);
  assert.equal(second.image_high, first.image_high);
  assert.equal(second.favorite, 1);
  assert.deepEqual(JSON.parse(second.tags), ["x", "y"]);
  assert.equal(second.notes, first.notes);
  assert.equal(second.content_hash, first.content_hash);
});

test("toChange sends base_rev and does not claim a server rev", () => {
  const row = normalizeRecord({
    work_id: "w-base",
    prompt: "p",
    remote_rev: 12,
    device_id: "dev-1",
  });
  row.remote_rev = 12;
  const change = toChange(row);
  assert.equal(change.base_rev, 12);
  assert.equal(change.remote_rev, undefined);
  assert.equal(change.op, "upsert");
});
