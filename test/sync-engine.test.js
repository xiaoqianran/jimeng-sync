const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { create: createSqlite } = require("../lib/db-sqlite");
const { create: createEngine } = require("../lib/sync-engine");

function makeRemote() {
  const rows = new Map();
  let rev = 0;
  function toChange(row) {
    return { ...row, op: row.deleted_at ? "delete" : "upsert" };
  }
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/sync/push") {
        const accepted = [];
        for (const change of body.changes || []) {
          rev += 1;
          const prev = rows.get(change.work_id);
          const base = Number(change.base_rev || 0);
          const keepPrev = prev && base < Number(prev.remote_rev || 0);
          const next = keepPrev ? { ...prev, remote_rev: rev } : { ...change, remote_rev: rev, dirty: 0 };
          rows.set(change.work_id, next);
          accepted.push({ work_id: change.work_id, remote_rev: rev });
        }
        res.end(JSON.stringify({ ok: true, accepted, max_rev: rev }));
        return;
      }
      if (url.pathname === "/sync/pull") {
        const since = Number(url.searchParams.get("since_rev") || 0);
        const exclude = url.searchParams.get("exclude_device") || "";
        const all = [...rows.values()].filter((row) => Number(row.remote_rev) > since);
        all.sort((a, b) => a.remote_rev - b.remote_rev);
        const changes = all.filter((row) => !exclude || row.device_id !== exclude).map(toChange);
        const nextRev = all.length ? all[all.length - 1].remote_rev : since;
        res.end(JSON.stringify({ ok: true, changes, next_rev: nextRev, has_more: false }));
        return;
      }
      if (url.pathname === "/sync/snapshot") {
        const after = url.searchParams.get("after_work_id") || "";
        const live = [...rows.values()]
          .filter((row) => !row.deleted_at && row.work_id > after)
          .sort((a, b) => a.work_id.localeCompare(b.work_id));
        res.end(JSON.stringify({
          ok: true,
          changes: live.map(toChange),
          next_work_id: live.length ? live[live.length - 1].work_id : after,
          has_more: false,
        }));
        return;
      }
      if (url.pathname === "/sync/status") {
        res.end(JSON.stringify({ ok: true, rev, total: rows.size }));
        return;
      }
      if (url.pathname === "/sync/gc") {
        res.end(JSON.stringify({ ok: true, purged: 0 }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
  });
}

const dbPath = path.join(os.tmpdir(), "jimeng-engine-" + Date.now() + ".db");
const sqlite = createSqlite(dbPath);
const remote = makeRemote();

after(() => {
  sqlite.close();
  remote.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
  }
});

test("push does not echo own rows back as downloads", async () => {
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const { port } = remote.address();
  const config = {
    deviceId: "dev-engine",
    deviceName: "test",
    remoteUrl: `http://127.0.0.1:${port}`,
    remoteToken: "t",
    tombstoneTtlDays: 0,
  };
  sqlite.ensureDeviceBinding(config.deviceId);
  sqlite.upsertCollected({ work_id: "eng-1", prompt: "from local" }, config.deviceId);
  const engine = createEngine(sqlite, config);
  const result = await engine.runCycle();
  assert.equal(result.lastOk, true);
  assert.equal(result.lastPush, 1);
  assert.equal(result.lastPull, 0);
  assert.equal(sqlite.get("eng-1").dirty, 0);
  assert.ok(sqlite.get("eng-1").remote_rev > 0);
  engine.stop();
});
