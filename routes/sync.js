const express = require("express");

function create(mysqlDb, config) {
  const router = express.Router();

  function requireToken(req, res, next) {
    if (!config.syncToken) {
      return res.status(503).json({ ok: false, message: "server SYNC_TOKEN is not configured" });
    }
    const header = String(req.headers.authorization || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const token = bearer || String(req.headers["x-sync-token"] || "");
    if (token !== config.syncToken) {
      return res.status(401).json({ ok: false, message: "unauthorized" });
    }
    next();
  }

  router.use("/sync", requireToken);

  router.get("/sync/pull", async (req, res) => {
    try {
      const page = await mysqlDb.pull(req.query.since_rev, req.query.limit, {
        excludeDeviceId: req.query.exclude_device,
      });
      res.json({ ok: true, ...page });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.get("/sync/snapshot", async (req, res) => {
    try {
      const page = await mysqlDb.snapshot({
        afterWorkId: req.query.after_work_id,
        limit: req.query.limit,
      });
      res.json({ ok: true, ...page });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post("/sync/push", async (req, res) => {
    const changes = req.body && Array.isArray(req.body.changes) ? req.body.changes : [];
    if (!Array.isArray(changes)) {
      return res.status(400).json({ ok: false, message: "changes must be array" });
    }
    const accepted = [];
    const rejected = [];
    let maxRev = 0;
    for (const change of changes) {
      try {
        const result = await mysqlDb.applyPush(change);
        accepted.push({ work_id: result.work_id, remote_rev: result.remote_rev });
        if (result.remote_rev > maxRev) maxRev = result.remote_rev;
      } catch (err) {
        rejected.push({
          work_id: change && change.work_id ? String(change.work_id) : null,
          message: err.message,
        });
      }
    }
    res.json({
      ok: rejected.length === 0,
      accepted,
      rejected,
      max_rev: maxRev,
      device_id: req.body && req.body.device_id,
    });
  });

  router.post("/sync/gc", async (req, res) => {
    try {
      const ttlDays = Number(config.tombstoneTtlDays || 0);
      const purged = ttlDays > 0
        ? await mysqlDb.purgeTombstones(ttlDays * 24 * 60 * 60 * 1000)
        : 0;
      res.json({ ok: true, purged, ttlDays });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.get("/sync/status", async (req, res) => {
    try {
      const status = await mysqlDb.status();
      res.json({ ok: true, ...status });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  return router;
}

module.exports = { create };
