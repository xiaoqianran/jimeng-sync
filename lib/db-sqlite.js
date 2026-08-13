const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { normalizeRecord, publicRecord, toChange, parseTags, contentHash } = require("./record");
const { mergeRecords } = require("./merge");
const { isMiscollected } = require("./junk");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompts (
  work_id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  author TEXT,
  model TEXT,
  create_time TEXT,
  collected_at INTEGER,
  image_url TEXT,
  image_high TEXT,
  aspect_ratio TEXT,
  raw_json TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  notes TEXT,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  content_hash TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  remote_rev INTEGER,
  local_image TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompts_dirty ON prompts(dirty);
CREATE INDEX IF NOT EXISTS idx_prompts_updated ON prompts(updated_at);
CREATE INDEX IF NOT EXISTS idx_prompts_deleted ON prompts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_prompts_favorite ON prompts(favorite);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

function rowFromDb(row) {
  if (!row) return null;
  return { ...row };
}

function create(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(prompts)").all();
  if (!columns.some((col) => col.name === "remote_rev")) {
    db.exec("ALTER TABLE prompts ADD COLUMN remote_rev INTEGER");
  }
  if (!columns.some((col) => col.name === "local_image")) {
    db.exec("ALTER TABLE prompts ADD COLUMN local_image TEXT");
  }

  const stmts = {
    get: db.prepare("SELECT * FROM prompts WHERE work_id = ?"),
    insert: db.prepare(`
      INSERT INTO prompts (
        work_id, prompt, author, model, create_time, collected_at,
        image_url, image_high, aspect_ratio, raw_json,
        favorite, tags, notes, deleted_at, updated_at, device_id, content_hash, dirty, remote_rev, local_image
      ) VALUES (
        @work_id, @prompt, @author, @model, @create_time, @collected_at,
        @image_url, @image_high, @aspect_ratio, @raw_json,
        @favorite, @tags, @notes, @deleted_at, @updated_at, @device_id, @content_hash, @dirty, @remote_rev, @local_image
      )
    `),
    update: db.prepare(`
      UPDATE prompts SET
        prompt=@prompt, author=@author, model=@model, create_time=@create_time,
        collected_at=@collected_at, image_url=@image_url, image_high=@image_high,
        aspect_ratio=@aspect_ratio, raw_json=@raw_json, favorite=@favorite, tags=@tags,
        notes=@notes, deleted_at=@deleted_at, updated_at=@updated_at, device_id=@device_id,
        content_hash=@content_hash, dirty=@dirty, remote_rev=@remote_rev, local_image=@local_image
      WHERE work_id=@work_id
    `),
    dirty: db.prepare("SELECT * FROM prompts WHERE dirty = 1 ORDER BY updated_at ASC LIMIT ?"),
    clearDirty: db.prepare("UPDATE prompts SET dirty = 0 WHERE work_id = ?"),
    markPushed: db.prepare("UPDATE prompts SET dirty = 0, remote_rev = ? WHERE work_id = ?"),
    markLocalImage: db.prepare("UPDATE prompts SET local_image = ? WHERE work_id = ?"),
    unsavedImages: db.prepare(`
      SELECT work_id, image_url, image_high FROM prompts
      WHERE deleted_at IS NULL
        AND (local_image IS NULL OR local_image = '')
        AND (image_high IS NOT NULL OR image_url IS NOT NULL)
      ORDER BY collected_at DESC
      LIMIT ?
    `),
    purgeTombstones: db.prepare("DELETE FROM prompts WHERE deleted_at IS NOT NULL AND deleted_at < ?"),
    getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
    setMeta: db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    stats: db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
        SUM(CASE WHEN dirty = 1 THEN 1 ELSE 0 END) AS dirty,
        SUM(CASE WHEN favorite = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS favorites
      FROM prompts
    `),
  };

  function bindRow(row) {
    return {
      work_id: row.work_id,
      prompt: row.prompt,
      author: row.author,
      model: row.model,
      create_time: row.create_time,
      collected_at: row.collected_at,
      image_url: row.image_url,
      image_high: row.image_high,
      aspect_ratio: row.aspect_ratio,
      raw_json: row.raw_json,
      favorite: row.favorite ? 1 : 0,
      tags: typeof row.tags === "string" ? row.tags : JSON.stringify(parseTags(row.tags)),
      notes: row.notes,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
      device_id: row.device_id,
      content_hash: row.content_hash || contentHash(row),
      dirty: row.dirty ? 1 : 0,
      remote_rev: row.remote_rev == null ? null : Number(row.remote_rev),
      local_image: row.local_image || null,
    };
  }

  function saveRow(row) {
    const existing = stmts.get.get(row.work_id);
    if (existing && !row.local_image) row.local_image = existing.local_image;
    const bound = bindRow(row);
    if (existing) stmts.update.run(bound);
    else stmts.insert.run(bound);
    return stmts.get.get(row.work_id);
  }

  function upsertCollected(item, deviceId) {
    const incoming = normalizeRecord(item, {
      device_id: deviceId,
      updated_at: Date.now(),
      collected_at: Date.now(),
    });
    const existing = rowFromDb(stmts.get.get(incoming.work_id));
    if (!existing) {
      incoming.dirty = 1;
      incoming.device_id = deviceId;
      return rowFromDb(saveRow(incoming));
    }
    const merged = mergeRecords(existing, incoming, { incomingIsRemote: false });
    const contentChanged = existing.content_hash !== merged.content_hash;
    merged.updated_at = existing.updated_at;
    merged.device_id = existing.device_id;
    merged.favorite = existing.favorite;
    merged.tags = existing.tags;
    merged.notes = existing.notes;
    merged.deleted_at = existing.deleted_at;
    merged.dirty = existing.dirty || contentChanged ? 1 : 0;
    merged.remote_rev = existing.remote_rev;
    return rowFromDb(saveRow(merged));
  }

  function applyLocalMutation(workId, patch, deviceId) {
    const existing = rowFromDb(stmts.get.get(workId));
    if (!existing) throw new Error("not found: " + workId);
    const next = {
      ...existing,
      ...patch,
      updated_at: Date.now(),
      device_id: deviceId,
      dirty: 1,
    };
    if (patch.tags !== undefined) next.tags = JSON.stringify(parseTags(patch.tags));
    if (patch.favorite !== undefined) next.favorite = patch.favorite ? 1 : 0;
    next.content_hash = contentHash(next);
    return rowFromDb(saveRow(next));
  }

  function applyRemoteChange(change, deviceId) {
    const incoming = normalizeRecord(change, { device_id: change.device_id || "remote" });
    if (change.op === "delete" && !incoming.deleted_at) {
      incoming.deleted_at = incoming.updated_at || Date.now();
    }
    incoming.dirty = 0;
    incoming.remote_rev = change.remote_rev != null ? Number(change.remote_rev) : incoming.remote_rev;
    const existing = rowFromDb(stmts.get.get(incoming.work_id));
    if (existing && incoming.remote_rev != null && Number(existing.remote_rev || 0) >= incoming.remote_rev) {
      return existing;
    }
    const merged = mergeRecords(existing, incoming, { incomingIsRemote: true });
    if (!existing && !merged.device_id) merged.device_id = deviceId;
    return rowFromDb(saveRow(merged));
  }

  function list({
    q = "",
    includeDeleted = false,
    favorite = false,
    limit = 50,
    offset = 0,
  } = {}) {
    const where = [];
    const params = {};
    if (!includeDeleted) where.push("deleted_at IS NULL");
    if (favorite) where.push("favorite = 1");
    if (q) {
      where.push("(prompt LIKE @q OR author LIKE @q OR notes LIKE @q OR work_id LIKE @q OR IFNULL(tags,'') LIKE @q)");
      params.q = `%${q}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS c FROM prompts ${whereSql}`).get(params).c;
    const rows = db.prepare(
      `SELECT * FROM prompts ${whereSql} ORDER BY collected_at DESC, updated_at DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit: Number(limit) || 50, offset: Number(offset) || 0 });
    return {
      total,
      items: rows.map((row) => publicRecord(row, { includeDeleted: true })),
    };
  }

  return {
    path: dbPath,
    close() {
      db.close();
    },
    checkpoint() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    get(workId) {
      return rowFromDb(stmts.get.get(String(workId)));
    },
    upsertCollected,
    importItems(items, deviceId) {
      const listItems = Array.isArray(items) ? items : [];
      let upserted = 0;
      let failed = 0;
      const results = [];
      db.exec("BEGIN");
      try {
        for (const item of listItems) {
          try {
            if (isMiscollected(item)) {
              results.push({
                work_id: item && item.work_id ? String(item.work_id) : null,
                ok: true,
                skipped: true,
              });
              continue;
            }
            const row = upsertCollected(item, deviceId);
            upserted++;
            results.push({ work_id: row.work_id, ok: true });
          } catch (err) {
            failed++;
            results.push({
              work_id: item && item.work_id ? String(item.work_id) : null,
              ok: false,
              message: err.message,
            });
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { upserted, failed, results };
    },
    applyLocalMutation,
    softDelete(workId, deviceId) {
      return applyLocalMutation(workId, { deleted_at: Date.now() }, deviceId);
    },
    undelete(workId, deviceId) {
      return applyLocalMutation(workId, { deleted_at: null }, deviceId);
    },
    applyRemoteChange,
    getDirty(limit = 200) {
      return stmts.dirty.all(Number(limit) || 200).map(rowFromDb);
    },
    clearDirty(workIds) {
      db.exec("BEGIN");
      try {
        for (const id of workIds || []) stmts.clearDirty.run(String(id));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    acknowledgePush(accepted) {
      const items = Array.isArray(accepted) ? accepted : [];
      db.exec("BEGIN");
      try {
        for (const item of items) {
          if (item && typeof item === "object") {
            const id = item.work_id;
            if (!id) continue;
            if (item.remote_rev != null) stmts.markPushed.run(Number(item.remote_rev), String(id));
            else stmts.clearDirty.run(String(id));
          } else if (item) {
            stmts.clearDirty.run(String(item));
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    ensureDeviceBinding(deviceId) {
      const bound = this.getMeta("bound_device_id");
      if (!bound) {
        this.setMeta("bound_device_id", deviceId);
        return { rebound: false, deviceId };
      }
      if (bound !== deviceId) {
        this.setMeta("previous_device_id", bound);
        this.setMeta("bound_device_id", deviceId);
        this.setMeta("last_pull_rev", "0");
        this.setMeta("snapshot_done", "");
        return { rebound: true, previous: bound, deviceId };
      }
      return { rebound: false, deviceId };
    },
    resetSyncCursor() {
      this.setMeta("last_pull_rev", "0");
      this.setMeta("snapshot_done", "");
    },
    listMiscollected() {
      return db.prepare("SELECT * FROM prompts WHERE deleted_at IS NULL").all()
        .filter((row) => isMiscollected(row))
        .map((row) => publicRecord(row, { includeDeleted: true }));
    },
    tombstoneMiscollected(deviceId) {
      const rows = db.prepare("SELECT * FROM prompts WHERE deleted_at IS NULL").all()
        .filter((row) => isMiscollected(row));
      let count = 0;
      for (const row of rows) {
        this.softDelete(row.work_id, deviceId);
        count++;
      }
      return { count, workIds: rows.map((row) => row.work_id) };
    },
    purgeTombstones(ttlMs) {
      const ttl = Number(ttlMs || 0);
      if (!ttl || ttl <= 0) return 0;
      const cutoff = Date.now() - ttl;
      const before = this.stats().deleted;
      stmts.purgeTombstones.run(cutoff);
      return Math.max(0, before - this.stats().deleted);
    },
    list,
    markLocalImage(workId, fileName) {
      stmts.markLocalImage.run(String(fileName), String(workId));
    },
    listUnsavedImages(limit = 8) {
      return stmts.unsavedImages.all(Number(limit) || 8);
    },
    stats() {
      const row = stmts.stats.get();
      const pending = db.prepare(`
        SELECT COUNT(*) AS c FROM prompts
        WHERE deleted_at IS NULL
          AND (local_image IS NULL OR local_image = '')
          AND (image_high IS NOT NULL OR image_url IS NOT NULL)
      `).get();
      const saved = db.prepare(`
        SELECT COUNT(*) AS c FROM prompts
        WHERE deleted_at IS NULL AND local_image IS NOT NULL AND local_image != ''
      `).get();
      return {
        total: Number(row.total || 0),
        active: Number(row.active || 0),
        deleted: Number(row.deleted || 0),
        dirty: Number(row.dirty || 0),
        favorites: Number(row.favorites || 0),
        imagesSaved: Number(saved.c || 0),
        imagesPending: Number(pending.c || 0),
      };
    },
    getMeta(key, fallback = null) {
      const row = stmts.getMeta.get(key);
      return row ? row.v : fallback;
    },
    setMeta(key, value) {
      stmts.setMeta.run(key, value == null ? "" : String(value));
    },
    exportRows({ includeDeleted = true } = {}) {
      const sql = includeDeleted
        ? "SELECT * FROM prompts ORDER BY collected_at ASC"
        : "SELECT * FROM prompts WHERE deleted_at IS NULL ORDER BY collected_at ASC";
      return db.prepare(sql).all().map((row) => publicRecord(row, { includeDeleted: true }));
    },
    toChange,
    publicRecord,
  };
}

module.exports = { create };
