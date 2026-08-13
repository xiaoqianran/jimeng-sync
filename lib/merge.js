const { CONTENT_FIELDS, isEmpty, contentHash, parseTags } = require("./record");

function richer(a, b) {
  if (isEmpty(a)) return isEmpty(b) ? null : b;
  if (isEmpty(b)) return a;
  return String(a).length >= String(b).length ? a : b;
}

function mergeCollectedAt(a, b) {
  const an = Number(a || 0);
  const bn = Number(b || 0);
  if (!an) return bn || null;
  if (!bn) return an;
  return Math.min(an, bn);
}

function mergeContent(local, incoming) {
  const out = {};
  for (const field of CONTENT_FIELDS) {
    out[field] = richer(local && local[field], incoming && incoming[field]);
  }
  out.collected_at = mergeCollectedAt(local && local.collected_at, incoming && incoming.collected_at);
  return out;
}

function contentRicherThan(merged, other) {
  if (!other) return true;
  for (const field of CONTENT_FIELDS) {
    if (field === "raw_json") continue;
    if (isEmpty(other[field]) && !isEmpty(merged[field])) return true;
    if (!isEmpty(merged[field]) && !isEmpty(other[field]) && String(merged[field]) !== String(other[field])) {
      if (String(merged[field]).length > String(other[field]).length) return true;
    }
  }
  return false;
}

function lwwCompare(a, b) {
  const at = Number((a && a.updated_at) || 0);
  const bt = Number((b && b.updated_at) || 0);
  if (at !== bt) return at - bt;
  const ad = String((a && a.device_id) || "");
  const bd = String((b && b.device_id) || "");
  if (ad === bd) return 0;
  return ad < bd ? -1 : 1;
}

function incomingWinsAnnotations(local, incoming, options = {}) {
  if (!local) return true;
  if (!incoming) return false;

  if (options.useBaseRev) {
    const base = Number(incoming.base_rev ?? 0);
    const serverRev = Number(local.remote_rev || 0);
    if (base >= serverRev) return true;
    return false;
  }

  const localRev = Number(local.remote_rev || 0);
  const incomingRev = Number(incoming.remote_rev || 0);
  if (incomingRev && localRev && incomingRev !== localRev) {
    return incomingRev > localRev;
  }
  return lwwCompare(local, incoming) < 0;
}

function pickAnnotations(row) {
  return {
    favorite: row && Number(row.favorite) === 1 ? 1 : 0,
    tags: JSON.stringify(parseTags(row && row.tags)),
    notes: row && !isEmpty(row.notes) ? String(row.notes) : null,
    deleted_at: row && row.deleted_at ? Number(row.deleted_at) : null,
    updated_at: Number((row && row.updated_at) || 0),
    device_id: String((row && row.device_id) || "unknown"),
  };
}

function mergeRecords(local, incoming, options = {}) {
  if (!local && !incoming) return null;
  if (!local) {
    const row = { ...incoming, dirty: options.incomingIsRemote ? 0 : 1 };
    row.content_hash = contentHash(row);
    return row;
  }
  if (!incoming) {
    return { ...local, content_hash: contentHash(local) };
  }

  const content = mergeContent(local, incoming);
  const incomingWins = incomingWinsAnnotations(local, incoming, options);
  const winner = incomingWins ? incoming : local;
  const annotations = pickAnnotations(winner);

  let dirty = Number(local.dirty) === 1 ? 1 : 0;
  if (options.incomingIsRemote) {
    if (incomingWins) {
      dirty = contentRicherThan(content, incoming) ? 1 : 0;
    } else {
      dirty = Number(local.dirty) === 1 ? 1 : 0;
    }
  } else if (options.markDirty) {
    dirty = 1;
  }

  const row = {
    ...local,
    ...content,
    ...annotations,
    work_id: local.work_id || incoming.work_id,
    dirty,
    remote_rev: incomingWins && incoming.remote_rev != null ? incoming.remote_rev : local.remote_rev,
    base_rev: incoming.base_rev != null ? incoming.base_rev : local.base_rev,
  };
  row.content_hash = contentHash(row);
  return row;
}

module.exports = {
  richer,
  mergeContent,
  contentRicherThan,
  lwwCompare,
  incomingWinsAnnotations,
  pickAnnotations,
  mergeRecords,
};
