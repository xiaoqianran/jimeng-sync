const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: process.env.JSON_LIMIT || "100mb" }));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "jimeng",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  charset: "utf8mb4",
});

function toMysqlDatetime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function normalizePromptItem(item) {
  if (!item || typeof item !== "object") {
    throw new Error("item must be object");
  }
  if (!item.work_id) {
    throw new Error("missing work_id");
  }
  if (!item.prompt) {
    throw new Error("missing prompt");
  }

  return {
    work_id: String(item.work_id),
    prompt: String(item.prompt),
    author: item.author || null,
    model: item.model || null,
    create_time: item.create_time || null,
    collected_at: toMysqlDatetime(item.collected_at) || toMysqlDatetime(Date.now()),
    image_url: item.image_url || null,
    image_high: item.image_high || null,
    aspect_ratio: item.aspect_ratio ? String(item.aspect_ratio) : null,
    raw_json: JSON.stringify(item),
  };
}

const UPSERT_SQL = `
  INSERT INTO jimeng_prompts
  (
    work_id,
    prompt,
    author,
    model,
    create_time,
    collected_at,
    image_url,
    image_high,
    aspect_ratio,
    raw_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))
  ON DUPLICATE KEY UPDATE
    prompt = VALUES(prompt),
    author = VALUES(author),
    model = VALUES(model),
    create_time = VALUES(create_time),
    collected_at = VALUES(collected_at),
    image_url = VALUES(image_url),
    image_high = VALUES(image_high),
    aspect_ratio = VALUES(aspect_ratio),
    raw_json = VALUES(raw_json),
    updated_at = CURRENT_TIMESTAMP
`;

async function insertPrompt(conn, item) {
  const row = normalizePromptItem(item);
  await conn.execute(UPSERT_SQL, [
    row.work_id,
    row.prompt,
    row.author,
    row.model,
    row.create_time,
    row.collected_at,
    row.image_url,
    row.image_high,
    row.aspect_ratio,
    row.raw_json,
  ]);
  return row.work_id;
}

app.get("/health", async (req, res) => {
  const [rows] = await pool.query("SELECT 1 AS ok");
  res.json({ ok: true, db: rows[0].ok });
});

// 普通 JSON 批量端点：逐条写入，不再因为一条失败导致整批回滚。
app.post("/api/jimeng/prompts/batch", async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body.items;

  if (!Array.isArray(items)) {
    return res.status(400).json({
      ok: false,
      message: "items must be array",
    });
  }

  let conn;
  const results = [];
  let insertedOrUpdated = 0;
  let failed = 0;

  try {
    conn = await pool.getConnection();

    for (const item of items) {
      const workId = item && item.work_id ? String(item.work_id) : null;
      try {
        const savedWorkId = await insertPrompt(conn, item);
        insertedOrUpdated++;
        results.push({ work_id: savedWorkId, ok: true });
      } catch (err) {
        failed++;
        results.push({
          work_id: workId,
          ok: false,
          message: err.message,
        });
      }
    }

    res.json({
      ok: failed === 0,
      mode: "batch",
      received: items.length,
      insertedOrUpdated,
      failed,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      message: err.message,
      received: items.length,
      insertedOrUpdated,
      failed: items.length - insertedOrUpdated,
      results,
    });
  } finally {
    if (conn) conn.release();
  }
});


// 查询 MySQL 中已经存在的 work_id，用于油猴端启动/手动同步前校准断点。
// 关键目的：旧版本已经上传过的数据，油猴端本地没有 ack 记录时，也不会被整批重新上传。
app.post("/api/jimeng/prompts/existing", async (req, res) => {
  const ids = Array.isArray(req.body) ? req.body : req.body.work_ids;

  if (!Array.isArray(ids)) {
    return res.status(400).json({
      ok: false,
      message: "work_ids must be array",
    });
  }

  const uniqueIds = Array.from(new Set(ids.map(String).filter(Boolean)));
  if (!uniqueIds.length) {
    return res.json({ ok: true, checked: 0, existing: 0, existingWorkIds: [], missingWorkIds: [] });
  }

  if (uniqueIds.length > 2000) {
    return res.status(400).json({
      ok: false,
      message: "too many work_ids in one request; please send <= 2000",
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const placeholders = uniqueIds.map(() => "?").join(",");
    const [rows] = await conn.query(
      `SELECT work_id FROM jimeng_prompts WHERE work_id IN (${placeholders})`,
      uniqueIds
    );

    const existingSet = new Set(rows.map(row => String(row.work_id)));
    const existingWorkIds = uniqueIds.filter(id => existingSet.has(id));
    const missingWorkIds = uniqueIds.filter(id => !existingSet.has(id));

    res.json({
      ok: true,
      checked: uniqueIds.length,
      existing: existingWorkIds.length,
      missing: missingWorkIds.length,
      existingWorkIds,
      missingWorkIds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      message: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

// NDJSON 流式端点：请求体按行发送，每收到一行 JSON 就立刻尝试写入 MySQL。
// 适合大量数据、断点续传和“边传边写”。
app.post("/api/jimeng/prompts/stream", async (req, res) => {
  let conn;
  const results = [];
  let buffer = "";
  let received = 0;
  let insertedOrUpdated = 0;
  let failed = 0;

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return;

    received++;
    let item;
    try {
      item = JSON.parse(text);
    } catch (err) {
      failed++;
      results.push({ work_id: null, ok: false, message: "invalid ndjson: " + err.message });
      return;
    }

    const workId = item && item.work_id ? String(item.work_id) : null;
    try {
      const savedWorkId = await insertPrompt(conn, item);
      insertedOrUpdated++;
      results.push({ work_id: savedWorkId, ok: true });
    } catch (err) {
      failed++;
      results.push({ work_id: workId, ok: false, message: err.message });
    }
  }

  try {
    conn = await pool.getConnection();
    req.setEncoding("utf8");

    for await (const chunk of req) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        await handleLine(line);
      }
    }

    if (buffer.trim()) {
      await handleLine(buffer);
    }

    res.json({
      ok: failed === 0,
      mode: "stream",
      received,
      insertedOrUpdated,
      failed,
      results,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      mode: "stream",
      message: err.message,
      received,
      insertedOrUpdated,
      failed: Math.max(failed, received - insertedOrUpdated),
      results,
    });
  } finally {
    if (conn) conn.release();
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, "0.0.0.0", () => {
  console.log(`Jimeng sync API running at http://127.0.0.1:${port}`);
  console.log("Batch endpoint:  POST /api/jimeng/prompts/batch");
  console.log("Stream endpoint: POST /api/jimeng/prompts/stream");
  console.log("Existing check:  POST /api/jimeng/prompts/existing");
});
