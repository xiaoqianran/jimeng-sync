const mysql = require("mysql2/promise");
const { normalizeRecord, publicRecord, parseTags, contentHash } = require("./record");
const { mergeRecords } = require("./merge");

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0].c) > 0;
}

async function ensureColumn(pool, table, column, ddl) {
  if (!(await columnExists(pool, table, column))) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  }
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jimeng_prompts (
      work_id VARCHAR(64) NOT NULL PRIMARY KEY,
      prompt MEDIUMTEXT NOT NULL,
      author VARCHAR(255) NULL,
      model VARCHAR(255) NULL,
      create_time VARCHAR(64) NULL,
      collected_at DATETIME NULL,
      image_url TEXT NULL,
      image_high TEXT NULL,
      aspect_ratio VARCHAR(32) NULL,
      raw_json JSON NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await ensureColumn(pool, "jimeng_prompts", "favorite", "favorite TINYINT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "jimeng_prompts", "tags", "tags JSON NULL");
  await ensureColumn(pool, "jimeng_prompts", "notes", "notes TEXT NULL");
  await ensureColumn(pool, "jimeng_prompts", "deleted_at", "deleted_at BIGINT NULL");
  await ensureColumn(pool, "jimeng_prompts", "updated_at_ms", "updated_at_ms BIGINT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "jimeng_prompts", "device_id", "device_id VARCHAR(64) NULL");
  await ensureColumn(pool, "jimeng_prompts", "content_hash", "content_hash VARCHAR(64) NULL");
  await ensureColumn(pool, "jimeng_prompts", "collected_at_ms", "collected_at_ms BIGINT NULL");
  await ensureColumn(pool, "jimeng_prompts", "remote_rev", "remote_rev BIGINT NOT NULL DEFAULT 0");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jimeng_sync_rev (
      k VARCHAR(16) NOT NULL PRIMARY KEY,
      v BIGINT NOT NULL
    ) CHARACTER SET utf8mb4
  `);
  await pool.query(`INSERT IGNORE INTO jimeng_sync_rev (k, v) VALUES ('rev', 0)`);

  await pool.query(`
    UPDATE jimeng_prompts
    SET updated_at_ms = UNIX_TIMESTAMP(updated_at) * 1000
    WHERE updated_at_ms = 0 AND updated_at IS NOT NULL
  `);
  await pool.query(`
    UPDATE jimeng_prompts
    SET device_id = 'legacy'
    WHERE device_id IS NULL OR device_id = ''
  `);
}

async function backfillRemoteRev(pool) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM jimeng_prompts WHERE remote_rev = 0`);
  if (!Number(rows[0].c)) return;
  await pool.query(`SET @r := (SELECT IFNULL(MAX(remote_rev), 0) FROM jimeng_prompts)`);
  await pool.query(`
    UPDATE jimeng_prompts
    SET remote_rev = (@r := @r + 1)
    WHERE remote_rev = 0
    ORDER BY updated_at_ms ASC, work_id ASC
  `);
  const [maxRows] = await pool.query(`SELECT IFNULL(MAX(remote_rev), 0) AS v FROM jimeng_prompts`);
  await pool.query(`UPDATE jimeng_sync_rev SET v = GREATEST(v, ?) WHERE k = 'rev'`, [Number(maxRows[0].v)]);
}

function fromMysql(row) {
  if (!row) return null;
  let rawJson = row.raw_json;
  if (rawJson && typeof rawJson !== "string") rawJson = JSON.stringify(rawJson);
  let tags = row.tags;
  if (tags && typeof tags !== "string") tags = JSON.stringify(tags);
  return {
    work_id: String(row.work_id),
    prompt: row.prompt,
    author: row.author,
    model: row.model,
    create_time: row.create_time,
    collected_at: row.collected_at_ms || null,
    image_url: row.image_url,
    image_high: row.image_high,
    aspect_ratio: row.aspect_ratio,
    raw_json: rawJson,
    favorite: Number(row.favorite) === 1 ? 1 : 0,
    tags: tags || "[]",
    notes: row.notes,
    deleted_at: row.deleted_at,
    updated_at: Number(row.updated_at_ms || 0),
    device_id: row.device_id || "legacy",
    content_hash: row.content_hash || "",
    remote_rev: Number(row.remote_rev || 0),
    dirty: 0,
  };
}

async function create(mysqlConfig) {
  const pool = mysql.createPool({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
    waitForConnections: true,
    connectionLimit: mysqlConfig.connectionLimit || 10,
    charset: "utf8mb4",
  });

  await migrate(pool);
  await backfillRemoteRev(pool);

  async function nextRev(conn) {
    await conn.query(`UPDATE jimeng_sync_rev SET v = v + 1 WHERE k = 'rev'`);
    const [rows] = await conn.query(`SELECT v FROM jimeng_sync_rev WHERE k = 'rev'`);
    return Number(rows[0].v);
  }

  async function get(workId) {
    const [rows] = await pool.query(`SELECT * FROM jimeng_prompts WHERE work_id = ?`, [String(workId)]);
    return fromMysql(rows[0]);
  }

  async function save(conn, row, rev) {
    const tags = parseTags(row.tags);
    const collected = row.collected_at ? new Date(Number(row.collected_at)) : null;
    const collectedSql = collected && !Number.isNaN(collected.getTime())
      ? collected.toISOString().slice(0, 19).replace("T", " ")
      : null;
    await conn.query(
      `INSERT INTO jimeng_prompts (
        work_id, prompt, author, model, create_time, collected_at, collected_at_ms,
        image_url, image_high, aspect_ratio, raw_json, favorite, tags, notes,
        deleted_at, updated_at_ms, device_id, content_hash, remote_rev
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        prompt = VALUES(prompt),
        author = VALUES(author),
        model = VALUES(model),
        create_time = VALUES(create_time),
        collected_at = VALUES(collected_at),
        collected_at_ms = VALUES(collected_at_ms),
        image_url = VALUES(image_url),
        image_high = VALUES(image_high),
        aspect_ratio = VALUES(aspect_ratio),
        raw_json = VALUES(raw_json),
        favorite = VALUES(favorite),
        tags = VALUES(tags),
        notes = VALUES(notes),
        deleted_at = VALUES(deleted_at),
        updated_at_ms = VALUES(updated_at_ms),
        device_id = VALUES(device_id),
        content_hash = VALUES(content_hash),
        remote_rev = VALUES(remote_rev)`,
      [
        row.work_id,
        row.prompt,
        row.author,
        row.model,
        row.create_time,
        collectedSql,
        row.collected_at,
        row.image_url,
        row.image_high,
        row.aspect_ratio,
        row.raw_json || null,
        row.favorite ? 1 : 0,
        JSON.stringify(tags),
        row.notes,
        row.deleted_at,
        row.updated_at,
        row.device_id,
        row.content_hash || contentHash(row),
        rev,
      ]
    );
  }

  return {
    pool,
    async ping() {
      const [rows] = await pool.query("SELECT 1 AS ok");
      return rows[0].ok === 1;
    },
    get,
    async applyPush(change) {
      const incoming = normalizeRecord(change, { device_id: change.device_id || "remote" });
      if (change.op === "delete" && !incoming.deleted_at) {
        incoming.deleted_at = incoming.updated_at || Date.now();
      }
      incoming.base_rev = Number(change.base_rev ?? incoming.base_rev ?? 0);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query(`SELECT * FROM jimeng_prompts WHERE work_id = ?`, [incoming.work_id]);
        const existing = fromMysql(rows[0]);
        const merged = mergeRecords(existing, incoming, {
          incomingIsRemote: false,
          markDirty: false,
          useBaseRev: true,
        });
        merged.dirty = 0;
        const rev = await nextRev(conn);
        merged.remote_rev = rev;
        if (!existing || Number(incoming.base_rev || 0) >= Number((existing && existing.remote_rev) || 0)) {
          merged.updated_at = Date.now();
        }
        await save(conn, merged, rev);
        await conn.commit();
        return { work_id: merged.work_id, ok: true, remote_rev: rev };
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },
    async pull(sinceRev, limit, { excludeDeviceId } = {}) {
      const since = Number(sinceRev || 0);
      const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const [rows] = await pool.query(
        `SELECT * FROM jimeng_prompts WHERE remote_rev > ? ORDER BY remote_rev ASC LIMIT ?`,
        [since, take + 1]
      );
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      const exclude = excludeDeviceId ? String(excludeDeviceId) : "";
      const changes = slice
        .filter((row) => !exclude || String(row.device_id || "") !== exclude)
        .map((row) => {
          const rec = fromMysql(row);
          return {
            ...publicRecord(rec, { includeDeleted: true }),
            op: rec.deleted_at ? "delete" : "upsert",
            raw_json: rec.raw_json,
            remote_rev: rec.remote_rev,
          };
        });
      const nextRev = slice.length ? Number(slice[slice.length - 1].remote_rev) : since;
      return { changes, next_rev: nextRev, has_more: hasMore };
    },
    async snapshot({ afterWorkId = "", limit = 200 } = {}) {
      const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
      const after = String(afterWorkId || "");
      const [rows] = await pool.query(
        `SELECT * FROM jimeng_prompts
         WHERE deleted_at IS NULL AND work_id > ?
         ORDER BY work_id ASC
         LIMIT ?`,
        [after, take + 1]
      );
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      const changes = slice.map((row) => {
        const rec = fromMysql(row);
        return {
          ...publicRecord(rec, { includeDeleted: true }),
          op: "upsert",
          raw_json: rec.raw_json,
          remote_rev: rec.remote_rev,
        };
      });
      return {
        changes,
        next_work_id: slice.length ? slice[slice.length - 1].work_id : after,
        has_more: hasMore,
      };
    },
    async purgeTombstones(ttlMs) {
      const ttl = Number(ttlMs || 0);
      if (!ttl || ttl <= 0) return 0;
      const cutoff = Date.now() - ttl;
      const [result] = await pool.query(
        `DELETE FROM jimeng_prompts WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
        [cutoff]
      );
      return Number(result.affectedRows || 0);
    },
    async status() {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(deleted_at IS NOT NULL) AS deleted,
                SUM(deleted_at IS NULL) AS active,
                IFNULL(MAX(remote_rev), 0) AS rev
         FROM jimeng_prompts`
      );
      return {
        total: Number(countRows[0].total || 0),
        active: Number(countRows[0].active || 0),
        deleted: Number(countRows[0].deleted || 0),
        rev: Number(countRows[0].rev || 0),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { create };
