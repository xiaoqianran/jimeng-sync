const express = require("express");
const { publicRecord } = require("../lib/record");
const hub = require("../lib/hub");

function isAllowedImageUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:") return false;
    return /(byteimg|bytetos|byteeffect|byteacctimg|dreamina|jianying|volccdn|bytedance|ibyteimg)/i.test(url.hostname);
  } catch (_) {
    return false;
  }
}

function create(sqlite, config, syncEngine, imageStore) {
  const router = express.Router();

  function upsertBatch(items) {
    return sqlite.importItems(items, config.deviceId);
  }

  function emitIngest(result) {
    if (!result || !result.upserted) return;
    const latest = (result.results || [])
      .filter((row) => row && row.ok && row.work_id)
      .slice(-16)
      .map((row) => publicRecord(sqlite.get(row.work_id), { includeDeleted: true }))
      .filter(Boolean);
    hub.emit("ingest", {
      upserted: result.upserted,
      ...sqlite.stats(),
      items: latest,
      at: Date.now(),
    });
  }

  function statsPayload() {
    const bound = sqlite.getMeta("bound_device_id");
    const previous = sqlite.getMeta("previous_device_id");
    return {
      ok: true,
      ...sqlite.stats(),
      dbPath: sqlite.path,
      deviceId: config.deviceId,
      boundDeviceId: bound,
      previousDeviceId: previous || null,
      restored: Boolean(previous && previous !== config.deviceId),
      sync: syncEngine ? syncEngine.snapshot() : null,
      images: imageStore ? imageStore.snapshot() : null,
    };
  }

  router.get("/v1/health", (req, res) => {
    res.json(statsPayload());
  });

  router.post("/v1/ingest", (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body && req.body.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, message: "items must be array" });
    }
    const result = upsertBatch(items);
    emitIngest(result);
    if (imageStore) {
      imageStore.enqueueMany((result.results || []).filter((row) => row.ok && !row.skipped).map((row) => row.work_id));
    }
    res.json({
      ok: result.failed === 0,
      received: items.length,
      ...result,
      ...sqlite.stats(),
    });
  });

  router.get("/v1/stats", (req, res) => res.json(statsPayload()));
  router.get("/v1/items", (req, res) => {
    const result = sqlite.list({
      q: String(req.query.q || ""),
      includeDeleted: req.query.include_deleted === "1",
      favorite: req.query.favorite === "1",
      limit: Number(req.query.limit || 48),
      offset: Number(req.query.offset || 0),
    });
    res.json({ ok: true, ...result });
  });
  router.get("/v1/events", (req, res) => {
    hub.subscribe(req, res);
    hub.emit("hello", { ...sqlite.stats(), viewers: hub.size(), at: Date.now() });
  });
  router.get("/v1/image", (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    res.redirect(302, "/local/image" + (q ? "?" + q : ""));
  });

  router.get("/v1/media/:workId", (req, res) => {
    const file = imageStore && imageStore.resolveFile(req.params.workId);
    if (!file) {
      const row = sqlite.get(req.params.workId);
      const url = row && (row.image_high || row.image_url);
      if (!url) return res.status(404).json({ ok: false, message: "no image" });
      return res.redirect(302, "/local/image?url=" + encodeURIComponent(url));
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(file);
  });

  router.get("/local/events", (req, res) => {
    hub.subscribe(req, res);
    hub.emit("hello", { ...sqlite.stats(), viewers: hub.size(), at: Date.now() });
  });

  router.get("/local/image", async (req, res) => {
    const raw = String(req.query.url || "");
    if (!isAllowedImageUrl(raw)) {
      return res.status(400).json({ ok: false, message: "invalid image url" });
    }
    try {
      const upstream = await fetch(raw, {
        headers: {
          Referer: "https://jimeng.jianying.com/",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!upstream.ok) {
        return res.status(upstream.status).end();
      }
      const type = upstream.headers.get("content-type") || "image/webp";
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(buf);
    } catch (err) {
      res.status(502).json({ ok: false, message: err.message });
    }
  });

  router.get("/local/stats", (req, res) => {
    const bound = sqlite.getMeta("bound_device_id");
    const previous = sqlite.getMeta("previous_device_id");
    res.json({
      ok: true,
      ...sqlite.stats(),
      dbPath: sqlite.path,
      deviceId: config.deviceId,
      boundDeviceId: bound,
      previousDeviceId: previous || null,
      restored: Boolean(previous && previous !== config.deviceId),
      sync: syncEngine ? syncEngine.snapshot() : null,
    });
  });

  router.post("/local/prompts", (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body && req.body.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, message: "items must be array" });
    }
    const result = upsertBatch(items);
    emitIngest(result);
    if (imageStore) {
      imageStore.enqueueMany((result.results || []).filter((row) => row.ok && !row.skipped).map((row) => row.work_id));
    }
    res.json({
      ok: result.failed === 0,
      received: items.length,
      ...result,
      ...sqlite.stats(),
    });
  });

  router.post("/local/import", (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body && req.body.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, message: "items must be array" });
    }
    const result = upsertBatch(items);
    emitIngest(result);
    res.json({
      ok: result.failed === 0,
      imported: result.upserted,
      ...result,
      ...sqlite.stats(),
    });
  });

  router.get("/local/prompts", (req, res) => {
    const result = sqlite.list({
      q: String(req.query.q || ""),
      includeDeleted: req.query.include_deleted === "1",
      favorite: req.query.favorite === "1",
      limit: Number(req.query.limit || 50),
      offset: Number(req.query.offset || 0),
    });
    res.json({ ok: true, ...result });
  });

  router.get("/local/prompts/:workId", (req, res) => {
    const row = sqlite.get(req.params.workId);
    if (!row) return res.status(404).json({ ok: false, message: "not found" });
    res.json({ ok: true, item: publicRecord(row, { includeDeleted: true }) });
  });

  router.patch("/local/prompts/:workId", (req, res) => {
    try {
      const patch = {};
      if (req.body.favorite !== undefined) patch.favorite = req.body.favorite;
      if (req.body.tags !== undefined) patch.tags = req.body.tags;
      if (req.body.notes !== undefined) patch.notes = req.body.notes;
      const row = sqlite.applyLocalMutation(req.params.workId, patch, config.deviceId);
      const item = publicRecord(row, { includeDeleted: true });
      hub.emit("update", { item, ...sqlite.stats() });
      res.json({ ok: true, item });
    } catch (err) {
      res.status(404).json({ ok: false, message: err.message });
    }
  });

  router.delete("/local/prompts/:workId", (req, res) => {
    try {
      const row = sqlite.softDelete(req.params.workId, config.deviceId);
      const item = publicRecord(row, { includeDeleted: true });
      hub.emit("update", { item, ...sqlite.stats() });
      res.json({ ok: true, item });
    } catch (err) {
      res.status(404).json({ ok: false, message: err.message });
    }
  });

  router.post("/local/prompts/:workId/undelete", (req, res) => {
    try {
      const row = sqlite.undelete(req.params.workId, config.deviceId);
      res.json({ ok: true, item: publicRecord(row, { includeDeleted: true }) });
    } catch (err) {
      res.status(404).json({ ok: false, message: err.message });
    }
  });

  router.get("/local/export.jsonl", (req, res) => {
    const rows = sqlite.exportRows({ includeDeleted: req.query.include_deleted === "1" });
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"jimeng-prompts.jsonl\"");
    res.send(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  });

  router.get("/local/backup.db", (req, res) => {
    sqlite.checkpoint();
    res.download(sqlite.path, "jimeng.db");
  });

  router.get("/local/config", (req, res) => {
    res.json({
      ok: true,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      remoteUrl: config.remoteUrl || "",
      hasRemoteToken: Boolean(config.remoteToken),
      autoSyncMs: config.autoSyncMs,
      tombstoneTtlDays: config.tombstoneTtlDays,
      dbPath: sqlite.path,
      boundDeviceId: sqlite.getMeta("bound_device_id"),
      previousDeviceId: sqlite.getMeta("previous_device_id"),
    });
  });

  router.post("/local/config", (req, res) => {
    const body = req.body || {};
    config.savePersisted({
      device_name: body.deviceName != null ? String(body.deviceName) : undefined,
      remote_url: body.remoteUrl != null ? String(body.remoteUrl).trim() : undefined,
      remote_token: body.remoteToken != null ? String(body.remoteToken) : undefined,
      auto_sync_ms: body.autoSyncMs != null ? Number(body.autoSyncMs) : undefined,
    });
    if (syncEngine) {
      syncEngine.stop();
      syncEngine.start();
    }
    res.json({
      ok: true,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      remoteUrl: config.remoteUrl || "",
      hasRemoteToken: Boolean(config.remoteToken),
      autoSyncMs: config.autoSyncMs,
    });
  });

  router.post("/local/device/reset", (req, res) => {
    const next = config.rotateDeviceId();
    sqlite.ensureDeviceBinding(next);
    sqlite.resetSyncCursor();
    if (syncEngine) {
      syncEngine.stop();
      syncEngine.start();
    }
    res.json({
      ok: true,
      deviceId: next,
      message: "已标记为新设备，下次同步会先拉远程快照",
    });
  });

  router.get("/local/cleanup/miscollected", (req, res) => {
    const items = sqlite.listMiscollected();
    res.json({ ok: true, count: items.length, items: items.slice(0, 30) });
  });

  router.post("/local/cleanup/miscollected", (req, res) => {
    const result = sqlite.tombstoneMiscollected(config.deviceId);
    hub.emit("update", { ...sqlite.stats(), cleaned: result.count });
    res.json({ ok: true, ...result, ...sqlite.stats() });
  });

  router.post("/local/sync", async (req, res) => {
    if (!syncEngine) return res.status(400).json({ ok: false, message: "sync engine unavailable" });
    const result = await syncEngine.runCycle();
    hub.emit("sync", { ...result, ...sqlite.stats() });
    res.json({ ok: result.lastOk !== false, ...result, ...sqlite.stats() });
  });

  router.get("/local/sync/status", (req, res) => {
    res.json({ ok: true, ...(syncEngine ? syncEngine.snapshot() : {}), ...sqlite.stats() });
  });

  router.post("/local/sync/test", async (req, res) => {
    if (!syncEngine) return res.status(400).json({ ok: false, message: "sync engine unavailable" });
    try {
      const remote = await syncEngine.testRemote();
      res.json({ ok: true, remote });
    } catch (err) {
      res.status(502).json({ ok: false, message: err.message });
    }
  });

  // 旧油猴接口：改为写入本地 SQLite，方便过渡。
  router.post("/api/jimeng/prompts/batch", (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body && req.body.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, message: "items must be array" });
    }
    const result = upsertBatch(items);
    res.json({
      ok: result.failed === 0,
      mode: "batch",
      received: items.length,
      insertedOrUpdated: result.upserted,
      failed: result.failed,
      results: result.results,
    });
  });

  router.post("/api/jimeng/prompts/existing", (req, res) => {
    const ids = Array.isArray(req.body) ? req.body : req.body && req.body.work_ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ ok: false, message: "work_ids must be array" });
    }
    const uniqueIds = Array.from(new Set(ids.map(String).filter(Boolean)));
    const existingWorkIds = uniqueIds.filter((id) => sqlite.get(id));
    const missingWorkIds = uniqueIds.filter((id) => !sqlite.get(id));
    res.json({
      ok: true,
      checked: uniqueIds.length,
      existing: existingWorkIds.length,
      missing: missingWorkIds.length,
      existingWorkIds,
      missingWorkIds,
    });
  });

  router.post("/api/jimeng/prompts/stream", express.text({ type: "*/*", limit: config.jsonLimit }), (req, res) => {
    const text = String(req.body || "");
    const items = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch (err) {
        items.push({ work_id: null, prompt: "", _parseError: err.message });
      }
    }
    const result = upsertBatch(items.filter((item) => item && item.work_id && item.prompt && !item._parseError));
    res.json({
      ok: result.failed === 0,
      mode: "stream",
      received: items.length,
      insertedOrUpdated: result.upserted,
      failed: result.failed,
      results: result.results,
    });
  });

  return router;
}

module.exports = { create };
