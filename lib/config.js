const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function load() {
  loadDotEnv(path.join(ROOT, ".env"));

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
  fs.mkdirSync(dataDir, { recursive: true });

  const persistedPath = path.join(dataDir, "config.json");
  const persisted = readJson(persistedPath, {});

  if (!persisted.device_id) {
    persisted.device_id = crypto.randomUUID();
    persisted.device_name = persisted.device_name || os.hostname() || "jimeng-local";
    persisted.created_at = new Date().toISOString();
    writeJson(persistedPath, persisted);
  }

  const mode = String(process.env.MODE || persisted.mode || "local").toLowerCase();
  const port = Number(process.env.PORT || 3001);

  return {
    root: ROOT,
    mode: mode === "remote" ? "remote" : "local",
    port,
    bind: process.env.BIND || (mode === "remote" ? "0.0.0.0" : "127.0.0.1"),
    jsonLimit: process.env.JSON_LIMIT || "100mb",
    dataDir,
    dbPath: path.resolve(process.env.SQLITE_PATH || path.join(dataDir, "jimeng.db")),
    persistedPath,
    deviceId: process.env.DEVICE_ID || persisted.device_id,
    deviceName: process.env.DEVICE_NAME || persisted.device_name || os.hostname() || "jimeng-local",
    remoteUrl: String(process.env.REMOTE_URL || persisted.remote_url || "").replace(/\/$/, ""),
    remoteToken: process.env.REMOTE_TOKEN || persisted.remote_token || "",
    syncToken: process.env.SYNC_TOKEN || persisted.sync_token || "",
    autoSyncMs: Number(process.env.AUTO_SYNC_MS || persisted.auto_sync_ms || 30000),
    tombstoneTtlDays: Number(process.env.TOMBSTONE_TTL_DAYS || persisted.tombstone_ttl_days || 90),
    imageDir: process.env.IMAGE_DIR || path.join(dataDir, "images"),
    imageDelayMs: Number(process.env.IMAGE_DELAY_MS || 2800),
    imageBackfill: String(process.env.IMAGE_BACKFILL || "1") !== "0",
    mysql: {
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "jimeng",
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    },
    savePersisted(patch) {
      const next = { ...readJson(persistedPath, {}), ...patch };
      writeJson(persistedPath, next);
      if (patch.remote_url !== undefined) this.remoteUrl = String(patch.remote_url || "").replace(/\/$/, "");
      if (patch.remote_token !== undefined) this.remoteToken = patch.remote_token || "";
      if (patch.sync_token !== undefined) this.syncToken = patch.sync_token || "";
      if (patch.device_name !== undefined) this.deviceName = patch.device_name || this.deviceName;
      if (patch.auto_sync_ms !== undefined) this.autoSyncMs = Number(patch.auto_sync_ms || 30000);
      if (patch.device_id !== undefined) this.deviceId = patch.device_id;
      if (patch.tombstone_ttl_days !== undefined) this.tombstoneTtlDays = Number(patch.tombstone_ttl_days || 90);
    },
    rotateDeviceId() {
      const next = crypto.randomUUID();
      this.savePersisted({ device_id: next });
      return next;
    },
  };
}

module.exports = { load, ROOT };
