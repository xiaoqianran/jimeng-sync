const fs = require("fs");
const path = require("path");
const { isMiscollected } = require("./junk");

function isAllowedImageUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:") return false;
    return /(byteimg|bytetos|byteeffect|byteacctimg|dreamina|jianying|volccdn|bytedance|ibyteimg)/i.test(url.hostname);
  } catch (_) {
    return false;
  }
}

function extFrom(contentType, url) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  const match = String(url || "").match(/\.(png|jpe?g|webp|gif)(?:$|\?)/i);
  if (!match) return "bin";
  return match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
}

function safeId(workId) {
  return String(workId || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function create(sqlite, config) {
  const dir = path.resolve(config.imageDir || path.join(config.dataDir, "images"));
  fs.mkdirSync(dir, { recursive: true });

  const delayMs = Math.max(1200, Number(config.imageDelayMs || 2800));
  const backfill = config.imageBackfill !== false;
  const queue = [];
  const queued = new Set();
  let timer = null;
  let running = false;
  let pausedUntil = 0;
  const state = { saved: 0, failed: 0, lastError: null, lastAt: null };

  function enqueue(workId) {
    const id = String(workId || "");
    if (!id || queued.has(id)) return;
    queued.add(id);
    queue.push(id);
    schedule(delayMs);
  }

  function enqueueMany(workIds) {
    for (const id of workIds || []) enqueue(id);
  }

  function schedule(ms) {
    if (timer || running) return;
    timer = setTimeout(() => {
      timer = null;
      tick().catch((err) => {
        state.lastError = err.message;
        console.warn("[image-store]", err.message);
      });
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function downloadOne(row) {
    if (!row || isMiscollected(row)) return { skipped: true };
    if (row.local_image) {
      const abs = path.join(dir, path.basename(row.local_image));
      if (fs.existsSync(abs)) return { exists: true, file: row.local_image };
    }
    const url = row.image_high || row.image_url;
    if (!isAllowedImageUrl(url)) return { skipped: true };

    const res = await fetch(url, {
      headers: {
        Referer: "https://jimeng.jianying.com/",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (res.status === 429 || res.status === 403) {
      pausedUntil = Date.now() + 5 * 60 * 1000;
      throw new Error("CDN " + res.status + "，已暂停 5 分钟");
    }
    if (!res.ok) throw new Error("HTTP " + res.status);

    const type = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) throw new Error("empty image");
    const ext = extFrom(type, url);
    const name = safeId(row.work_id) + "." + ext;
    fs.writeFileSync(path.join(dir, name), buf);
    sqlite.markLocalImage(row.work_id, name);
    state.saved += 1;
    state.lastAt = Date.now();
    return { file: name, bytes: buf.length, type };
  }

  async function tick() {
    if (running) return;
    if (Date.now() < pausedUntil) {
      schedule(pausedUntil - Date.now());
      return;
    }
    running = true;
    try {
      if (!queue.length && backfill) {
        for (const row of sqlite.listUnsavedImages(8)) enqueue(row.work_id);
      }
      const id = queue.shift();
      if (!id) return;
      queued.delete(id);
      await downloadOne(sqlite.get(id));
    } catch (err) {
      state.failed += 1;
      state.lastError = err.message;
      state.lastAt = Date.now();
    } finally {
      running = false;
      const more = queue.length || (backfill && sqlite.listUnsavedImages(1).length);
      if (more) schedule(delayMs + Math.floor(Math.random() * 900));
    }
  }

  function snapshot() {
    return {
      dir,
      queued: queue.length,
      saved: state.saved,
      failed: state.failed,
      lastError: state.lastError,
      lastAt: state.lastAt,
      delayMs,
      paused: Date.now() < pausedUntil,
    };
  }

  function resolveFile(workId) {
    const row = sqlite.get(workId);
    if (!row || !row.local_image) return null;
    const abs = path.join(dir, path.basename(row.local_image));
    return fs.existsSync(abs) ? abs : null;
  }

  function start() {
    if (backfill) schedule(5000);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { enqueue, enqueueMany, start, stop, snapshot, resolveFile, dir };
}

module.exports = { create, extFrom, isAllowedImageUrl };
