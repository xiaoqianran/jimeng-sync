const crypto = require("crypto");

const CONTENT_FIELDS = [
  "prompt",
  "author",
  "model",
  "create_time",
  "image_url",
  "image_high",
  "aspect_ratio",
  "raw_json",
];

function isEmpty(value) {
  return value == null || value === "";
}

function coerceEpochMs(n) {
  if (!Number.isFinite(n)) return null;
  if (n > 1e9 && n < 1e11) return Math.round(n * 1000);
  return Math.round(n);
}

function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return coerceEpochMs(value);
  const raw = String(value).trim();
  if (!raw) return null;
  if (!raw.includes("-") && !raw.includes("T") && !raw.includes(":")) {
    const n = Number(raw);
    if (Number.isFinite(n)) return coerceEpochMs(n);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function contentHash(row) {
  const parts = [
    row.work_id || "",
    row.prompt || "",
    row.author || "",
    row.model || "",
    row.image_url || "",
    row.image_high || "",
    row.aspect_ratio || "",
  ];
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((s) => s.trim()).filter(Boolean);
      }
    } catch (_) {
      return value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function normalizeRecord(input, defaults = {}) {
  if (!input || typeof input !== "object") {
    throw new Error("item must be object");
  }
  const workId = input.work_id != null ? String(input.work_id).trim() : "";
  if (!workId) throw new Error("missing work_id");
  const prompt = input.prompt != null ? String(input.prompt) : "";
  if (!prompt.trim() && !input.deleted_at) throw new Error("missing prompt");

  const tags = parseTags(input.tags);
  const updatedAt = toMs(input.updated_at) || defaults.updated_at || Date.now();
  const row = {
    work_id: workId,
    prompt,
    author: isEmpty(input.author) ? null : String(input.author),
    model: isEmpty(input.model) ? null : String(input.model),
    create_time: isEmpty(input.create_time) ? null : String(input.create_time),
    collected_at: toMs(input.collected_at) || defaults.collected_at || Date.now(),
    image_url: isEmpty(input.image_url) ? null : String(input.image_url),
    image_high: isEmpty(input.image_high) ? null : String(input.image_high),
    aspect_ratio: isEmpty(input.aspect_ratio) ? null : String(input.aspect_ratio),
    raw_json: input.raw_json
      ? typeof input.raw_json === "string"
        ? input.raw_json
        : JSON.stringify(input.raw_json)
      : JSON.stringify(input),
    favorite: input.favorite ? 1 : 0,
    tags: JSON.stringify(tags),
    notes: isEmpty(input.notes) ? null : String(input.notes),
    deleted_at: toMs(input.deleted_at),
    updated_at: updatedAt,
    device_id: String(input.device_id || defaults.device_id || "unknown"),
    content_hash: "",
    dirty: input.dirty ? 1 : 0,
    remote_rev: input.remote_rev != null ? Number(input.remote_rev) : null,
    base_rev: input.base_rev != null ? Number(input.base_rev) : null,
  };
  row.content_hash = contentHash(row);
  return row;
}

function publicRecord(row, { includeDeleted = true } = {}) {
  if (!row) return null;
  if (!includeDeleted && row.deleted_at) return null;
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
    favorite: Number(row.favorite) === 1,
    tags: parseTags(row.tags),
    notes: row.notes || "",
    deleted_at: row.deleted_at || null,
    updated_at: row.updated_at,
    device_id: row.device_id,
    content_hash: row.content_hash,
    dirty: Number(row.dirty) === 1,
    remote_rev: row.remote_rev,
    has_local: Boolean(row.local_image),
  };
}

function toChange(row) {
  const pub = publicRecord(row, { includeDeleted: true });
  const baseRev = Number(row.remote_rev || row.base_rev || 0);
  return {
    ...pub,
    op: pub.deleted_at ? "delete" : "upsert",
    raw_json: row.raw_json || null,
    base_rev: baseRev,
    remote_rev: undefined,
  };
}

module.exports = {
  CONTENT_FIELDS,
  isEmpty,
  toMs,
  contentHash,
  parseTags,
  normalizeRecord,
  publicRecord,
  toChange,
};
