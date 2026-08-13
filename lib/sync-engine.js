function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function remoteFetch(config, method, pathname, body) {
  if (!config.remoteUrl) throw new Error("未配置 REMOTE_URL");
  if (!config.remoteToken) throw new Error("未配置 REMOTE_TOKEN");
  const url = `${config.remoteUrl}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(config.remoteToken),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text || "{}");
  } catch (_) {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(json.message || `远程 ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

function create(sqlite, config) {
  const state = {
    running: false,
    lastOk: null,
    lastMessage: config.remoteUrl ? "尚未同步" : "未配置远程，仅本地备份",
    lastAt: null,
    lastError: null,
    lastPush: 0,
    lastPull: 0,
    lastSnapshot: 0,
    rebound: false,
    timer: null,
  };

  function bindDevice() {
    const result = sqlite.ensureDeviceBinding(config.deviceId);
    state.rebound = !!result.rebound;
    return result;
  }

  async function pullSnapshot() {
    let after = "";
    let applied = 0;
    for (let i = 0; i < 200; i++) {
      const qs = new URLSearchParams({
        limit: "200",
        after_work_id: after,
      });
      const page = await remoteFetch(config, "GET", `/sync/snapshot?${qs.toString()}`);
      const changes = Array.isArray(page.changes) ? page.changes : [];
      for (const change of changes) {
        sqlite.applyRemoteChange(change, config.deviceId);
        applied++;
      }
      after = page.next_work_id || after;
      if (!page.has_more) break;
    }
    const status = await remoteFetch(config, "GET", "/sync/status");
    sqlite.setMeta("last_pull_rev", String(status.rev || 0));
    sqlite.setMeta("snapshot_done", "1");
    state.lastSnapshot = applied;
    return applied;
  }

  async function pullIncremental() {
    let pulled = 0;
    let since = Number(sqlite.getMeta("last_pull_rev", "0") || 0);
    const exclude = encodeURIComponent(config.deviceId);
    for (let i = 0; i < 50; i++) {
      const page = await remoteFetch(
        config,
        "GET",
        `/sync/pull?since_rev=${since}&limit=200&exclude_device=${exclude}`
      );
      const changes = Array.isArray(page.changes) ? page.changes : [];
      for (const change of changes) {
        sqlite.applyRemoteChange(change, config.deviceId);
        pulled++;
      }
      since = Number(page.next_rev != null ? page.next_rev : since);
      sqlite.setMeta("last_pull_rev", String(since));
      if (!page.has_more) break;
    }
    return pulled;
  }

  async function runCycle() {
    if (state.running) return { ...state, skipped: true, reason: "already-running" };
    if (!config.remoteUrl || !config.remoteToken) {
      state.lastMessage = "未配置远程，仅本地备份";
      return snapshot();
    }

    state.running = true;
    state.lastError = null;
    try {
      bindDevice();
      const dirty = sqlite.getDirty(200);
      if (dirty.length) {
        const payload = {
          device_id: config.deviceId,
          device_name: config.deviceName,
          changes: dirty.map((row) => sqlite.toChange(row)),
        };
        const pushed = await remoteFetch(config, "POST", "/sync/push", payload);
        const accepted = Array.isArray(pushed.accepted) ? pushed.accepted : dirty.map((r) => ({ work_id: r.work_id }));
        sqlite.acknowledgePush(accepted);
        state.lastPush = accepted.length;
      } else {
        state.lastPush = 0;
      }

      const needsSnapshot = sqlite.getMeta("snapshot_done") !== "1"
        && Number(sqlite.getMeta("last_pull_rev", "0") || 0) === 0;
      if (needsSnapshot) {
        await pullSnapshot();
      } else {
        state.lastSnapshot = 0;
      }

      state.lastPull = await pullIncremental();

      try {
        await remoteFetch(config, "POST", "/sync/gc", {});
      } catch (_) {}

      const ttlDays = Number(config.tombstoneTtlDays || 0);
      if (ttlDays > 0) {
        sqlite.purgeTombstones(ttlDays * 24 * 60 * 60 * 1000);
      }

      state.lastOk = true;
      state.lastAt = Date.now();
      const snapPart = state.lastSnapshot ? `，快照 ${state.lastSnapshot}` : "";
      const reboundPart = state.rebound ? "；已按新设备重新绑定" : "";
      state.lastMessage = `同步完成：上传 ${state.lastPush}，下载 ${state.lastPull}${snapPart}${reboundPart}`;
    } catch (err) {
      state.lastOk = false;
      state.lastError = err.message;
      state.lastAt = Date.now();
      state.lastMessage = `同步失败：${err.message}`;
    } finally {
      state.running = false;
    }
    return snapshot();
  }

  function snapshot() {
    return {
      running: state.running,
      lastOk: state.lastOk,
      lastMessage: state.lastMessage,
      lastAt: state.lastAt,
      lastError: state.lastError,
      lastPush: state.lastPush,
      lastPull: state.lastPull,
      lastSnapshot: state.lastSnapshot,
      rebound: state.rebound,
      configured: Boolean(config.remoteUrl && config.remoteToken),
      remoteUrl: config.remoteUrl || "",
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      autoSyncMs: config.autoSyncMs,
    };
  }

  async function testRemote() {
    return remoteFetch(config, "GET", "/sync/status");
  }

  function start() {
    stop();
    if (!config.remoteUrl || !config.remoteToken) return;
    const delay = Math.max(5000, Number(config.autoSyncMs) || 30000);
    state.timer = setInterval(() => {
      runCycle().catch((err) => {
        console.warn("[sync]", err.message);
      });
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
    setTimeout(() => {
      runCycle().catch((err) => console.warn("[sync]", err.message));
    }, 1500).unref?.();
  }

  function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  return { runCycle, snapshot, testRemote, start, stop };
}

module.exports = { create, remoteFetch };
