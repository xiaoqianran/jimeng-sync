// ==UserScript==
// @name         即梦AI 提示词批量收集器 · MySQL同步版
// @name:zh-CN   即梦AI 提示词批量收集器 · MySQL同步版
// @namespace    https://github.com/xiaoqianran/jimeng-prompt-collector-mysql-sync
// @version      1.3.2-maxitems-fix
// @description  图片+提示词视觉画廊 | 一键复制 | 强采集 | 自适应分页 | MySQL同步版 | 与纯本地版共用本地存储
// @description:zh-CN 即梦提示词批量收集工具 MySQL同步版：保留原本地存储 key，与纯本地版共用数据；支持图片与提示词视觉画廊、一键复制、多格式导出、Shadow 韧性采集、本地 API 同步、上传进度、断点续传、边采集边上传，并可先校准 MySQL 已存在数据，避免旧数据重复上传。
// @author       Multi-Agent Team
// @match        https://jimeng.jianying.com/*
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        window.onurlchange
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

/*
【使用说明 - 安装后即用】

1. 进入 https://jimeng.jianying.com/ 的「发现」或「探索」Feed 页。
2. 右下角 📝 悬浮球（可拖动此图标，点击展开完整面板。面板标题栏有 ⋮⋮ 拖动提示，也可直接拖动）。
3. 「开始/继续收集」：自动人类化滚动采集（已同时抓取图片URL）。
4. 新按钮：
   - 「视觉画廊」（紫色）：推荐！生成图片 + 提示词并列的精美自包含 HTML 画廊（支持一键快速复制提示词，完全绕过官方卡顿）。
   - 「清空」：清空当前已采集数据（有确认提示，建议先导出/画廊备份）。
5. 「查看已采」保留轻量分页模式。
6. 拖动：悬浮球和展开后的面板均支持拖拽，位置自动保存。

已根治所有历史痛点 + 支持清晰的图文对应 + 安全清空。
*/

(function () {
  'use strict';

  const CONFIG = {
    maxItems: 2000000,                 // 修复：原来 5000 条上限会导致已收集超过 5000 后点击开始立即结束
    scrollStepRatio: 0.72,           // 稍微激进一点，抓取更快
    baseWaitAfterScrollMs: 950,      // 核心：基础等待时间（追求速度）
    outputKey: 'jimeng_collected_prompts_v3',
    dedupBy: 'workId',
    schemaVersion: 3,
    storageKeyMeta: 'jimeng_collector_meta_v3',
    debounceSaveMs: 800,
    idbName: 'JimengPromptCollector',
    idbVersion: 1,
    idbStoreName: 'prompts',

    // === 速度与反检测平衡（按你的优先级：先不被封，再要速度） ===
    // 目标：在不被即梦明显当成机器人的前提下，尽量缩短总采集时间
    scrollJitterRatio: 0.32,         // 每次等待时间 ±32% 随机抖动（打破规律，成本很低）
    minWaitMs: 620,
    maxWaitMs: 1650,

    // === MySQL 同步配置：油猴脚本 -> 本地 API -> Docker MySQL ===
    syncApiUrl: 'http://127.0.0.1:3001/api/jimeng/prompts/batch',
    syncStreamApiUrl: 'http://127.0.0.1:3001/api/jimeng/prompts/stream',
    syncExistingApiUrl: 'http://127.0.0.1:3001/api/jimeng/prompts/existing',
    syncUseStreamEndpoint: true,          // true = NDJSON 流式端点；服务端边接收边写入
    syncBatchSize: 80,                    // 小批量持续上传，方便看进度 + 失败续传
    syncReconcileBatchSize: 500,          // 启动/手动同步前先向 MySQL 查询哪些 work_id 已存在，避免重复全量上传
    autoSyncToMysql: true,                // 采集到新数据后立即排队上传
    autoResumePendingSync: true,          // 刷新页面后自动续传未完成队列
    syncStateKey: 'jimeng_collector_sync_state_v4',
    syncPumpIntervalMs: 250,
    syncRetryDelayMs: 3500,
    syncMaxAutoRetries: 6,
  };

  // 存储元数据（schema + checkpoint + last export 等）
  let storageMeta = {
    schemaVersion: CONFIG.schemaVersion,
    lastCheckpoint: null,
    totalEverCollected: 0,
    lastExportAt: null,
  };

  // MySQL 同步状态（含上传进度、断点续传、队列状态）
  let syncState = {
    syncing: false,
    lastOk: false,
    lastMessage: '未同步',
    lastAt: null,
    lastCount: 0,
    queued: 0,
    synced: 0,
    failed: 0,
    runTotal: 0,
    runDone: 0,
    currentBatch: 0,
    currentBatchTotal: 0,
    uploadedBytes: 0,
    uploadTotalBytes: 0,
    progressPercent: 0,
    reconciled: false,
    reconcileChecked: 0,
    reconcileExisting: 0,
    retryTimer: null,
  };

  let syncAckedKeys = new Set();
  let syncPendingKeys = new Set();
  let syncFailedKeys = new Set();
  let syncRetryCountByKey = {};
  let syncItemIndex = new Map();
  let syncPumpPromise = null;
  let syncRetryTimer = null;

  let collected = [];
  let seen = new Set();
  let isRunning = false;
  let panel = null; // legacy (kept for compatibility during transition)

  // Phase 1 Shadow DOM + Defense state (from UI subagent)
  let shadowHost = null;
  let shadowRoot = null;
  let defenseIntervals = [];
  let defenseObserver = null;
  let historyPatched = false;

  // Persistence keys for position + collapsed state
  const POS_KEY = 'jc_position_v2';
  const COLLAPSED_KEY = 'jc_collapsed_v2';

  // Stealth / Resilience / Humanize state (Stealth/Resilience Agent deliverable)
  let isPaused = false;
  let pausedByHidden = false;
  let collectionErrors = 0;
  let recentAddedHistory = [];           // ring buffer for feed density estimation
  let checkpointTimer = null;
  let lastScrollContainer = null;        // ref for handlers
  let humanPaceFactor = 1.0;             // slow drift for session "fatigue"

  // ==================== 持久化 + 可靠去重 ====================

  function getDedupKey(item) {
    if (item.work_id) {
      return 'id:' + item.work_id;
    }
    if (item.prompt) {
      // 归一化 prompt 做兜底去重（去掉多余空格、大小写）
      const normalized = item.prompt.trim().toLowerCase().replace(/\s+/g, ' ');
      return 'prompt:' + normalized;
    }
    return null;
  }

  function loadData() {
    try {
      // 1. 加载元数据（schema 迁移准备）
      try {
        const metaRaw = GM_getValue(CONFIG.storageKeyMeta, '{}');
        const parsedMeta = JSON.parse(metaRaw);
        storageMeta = { ...storageMeta, ...parsedMeta };
        if (storageMeta.schemaVersion < CONFIG.schemaVersion) {
          console.log(`[即梦收集器] 检测到旧 schema v${storageMeta.schemaVersion}，准备迁移到 v${CONFIG.schemaVersion}`);
          // Phase 3 将在这里实现完整迁移逻辑（当前先接受并升级）
          storageMeta.schemaVersion = CONFIG.schemaVersion;
        }
      } catch (_) {}

      // 2. 主数据加载 + 强去重（v2 已有逻辑保留并强化）
      const saved = GM_getValue(CONFIG.outputKey, '[]');
      let loaded = JSON.parse(saved);

      const tempSeen = new Set();
      const deduped = [];
      for (const item of loaded) {
        const key = getDedupKey(item);
        if (key && !tempSeen.has(key)) {
          tempSeen.add(key);
          deduped.push(item);
        }
      }
      collected = deduped;
      seen = tempSeen;

      if (deduped.length !== loaded.length) {
        GM_setValue(CONFIG.outputKey, JSON.stringify(collected));
        console.log(`[即梦收集器] 加载时自动去重，清理了 ${loaded.length - deduped.length} 条重复`);
      }

      indexCollectedItems();
      loadSyncPersist();
      reconcileSyncQueueWithCollected(false);

      console.log(`[即梦收集器] 已加载 ${collected.length} 条历史数据（schema v${storageMeta.schemaVersion}，已去重）`);
    } catch (e) {
      collected = [];
      seen = new Set();
      console.warn('[即梦收集器] loadData 失败，已重置', e);
    }
  }

  function saveMeta() {
    try {
      GM_setValue(CONFIG.storageKeyMeta, JSON.stringify(storageMeta));
    } catch (e) {}
  }

  let saveDebounceTimer = null;

  function saveData(immediate = false) {
    const doSave = () => {
      try {
        // 保存前也做一次去重，保证文件永远是干净的
        const tempSeen = new Set();
        const clean = [];
        for (const item of collected) {
          const key = getDedupKey(item);
          if (key && !tempSeen.has(key)) {
            tempSeen.add(key);
            clean.push(item);
          }
        }
        collected = clean;
        seen = tempSeen;

        GM_setValue(CONFIG.outputKey, JSON.stringify(collected));

        // 更新 meta
        storageMeta.totalEverCollected = Math.max(storageMeta.totalEverCollected || 0, collected.length);
        storageMeta.lastCheckpoint = { ts: Date.now(), count: collected.length };
        saveMeta();
      } catch (e) {}
    };

    if (immediate) {
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      doSave();
    } else {
      if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
      saveDebounceTimer = setTimeout(doSave, CONFIG.debounceSaveMs);
    }
  }


  // ==================== MySQL 同步（进度 + 断点续传 + 边采集边上传） ====================

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function getSyncKey(item) {
    return getDedupKey(item);
  }

  function getSyncKeyFromWorkId(workId) {
    if (!workId) return null;
    return 'id:' + String(workId);
  }

  function getPendingItems() {
    indexCollectedItems();
    return Array.from(syncPendingKeys).map(key => syncItemIndex.get(key)).filter(Boolean);
  }

  function indexCollectedItems() {
    syncItemIndex = new Map();
    for (const item of collected) {
      const key = getSyncKey(item);
      if (key) syncItemIndex.set(key, item);
    }
  }

  function loadSyncPersist() {
    try {
      const raw = GM_getValue(CONFIG.syncStateKey, '{}');
      const data = JSON.parse(raw || '{}');
      syncAckedKeys = new Set(Array.isArray(data.ackedKeys) ? data.ackedKeys : []);
      syncPendingKeys = new Set(Array.isArray(data.pendingKeys) ? data.pendingKeys : []);
      syncFailedKeys = new Set(Array.isArray(data.failedKeys) ? data.failedKeys : []);
      syncRetryCountByKey = data.retryCountByKey && typeof data.retryCountByKey === 'object' ? data.retryCountByKey : {};
      syncState.lastAt = data.lastAt || null;
      syncState.lastCount = Number(data.lastCount || 0);
    } catch (e) {
      syncAckedKeys = new Set();
      syncPendingKeys = new Set();
      syncFailedKeys = new Set();
      syncRetryCountByKey = {};
    }
    updateSyncCounters();
  }

  function saveSyncPersist() {
    try {
      GM_setValue(CONFIG.syncStateKey, JSON.stringify({
        version: 4,
        ackedKeys: Array.from(syncAckedKeys),
        pendingKeys: Array.from(syncPendingKeys),
        failedKeys: Array.from(syncFailedKeys),
        retryCountByKey: syncRetryCountByKey,
        lastAt: syncState.lastAt,
        lastCount: syncState.lastCount,
        updatedAt: Date.now(),
      }));
    } catch (e) {}
  }

  function updateSyncCounters() {
    syncState.queued = syncPendingKeys.size;
    syncState.synced = syncAckedKeys.size;
    syncState.failed = syncFailedKeys.size;
  }

  function reconcileSyncQueueWithCollected(addUnsyncedToPending = false) {
    indexCollectedItems();

    for (const key of Array.from(syncPendingKeys)) {
      if (!syncItemIndex.has(key)) syncPendingKeys.delete(key);
    }
    for (const key of Array.from(syncFailedKeys)) {
      if (!syncItemIndex.has(key)) syncFailedKeys.delete(key);
    }

    if (addUnsyncedToPending) {
      for (const key of syncItemIndex.keys()) {
        if (!syncAckedKeys.has(key)) syncPendingKeys.add(key);
      }
    }

    updateSyncCounters();
    saveSyncPersist();
  }

  function resetSyncProgressForRun(source) {
    updateSyncCounters();
    syncState.runTotal = syncPendingKeys.size;
    syncState.runDone = 0;
    syncState.currentBatch = 0;
    syncState.currentBatchTotal = 0;
    syncState.uploadedBytes = 0;
    syncState.uploadTotalBytes = 0;
    syncState.progressPercent = syncState.runTotal ? 0 : 100;
    syncState.lastMessage = source === 'manual'
      ? `准备同步 ${syncState.runTotal} 条...`
      : `自动续传 ${syncState.runTotal} 条...`;
    updatePanel();
  }

  function buildSyncBatch() {
    const batch = [];
    for (const key of Array.from(syncPendingKeys)) {
      const item = syncItemIndex.get(key);
      if (!item) {
        syncPendingKeys.delete(key);
        continue;
      }
      batch.push(item);
      if (batch.length >= CONFIG.syncBatchSize) break;
    }
    return batch;
  }

  function applyUploadProgress(loaded, total, batchLength) {
    syncState.uploadedBytes = Number(loaded || 0);
    syncState.uploadTotalBytes = Number(total || 0);
    const batchRatio = syncState.uploadTotalBytes > 0
      ? Math.max(0, Math.min(1, syncState.uploadedBytes / syncState.uploadTotalBytes))
      : 0;
    const virtualDone = syncState.runDone + batchRatio * Math.max(1, batchLength || 1);
    syncState.progressPercent = syncState.runTotal > 0
      ? Math.max(0, Math.min(99.5, (virtualDone / syncState.runTotal) * 100))
      : 100;
    syncState.lastMessage = `上传中 ${syncState.progressPercent.toFixed(1)}% · ${formatBytes(syncState.uploadedBytes)}/${formatBytes(syncState.uploadTotalBytes)}`;
    updatePanel();
  }

  function gmPostJson(url, body, onUploadProgress) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: 60000,
        upload: {
          onprogress: function (ev) {
            if (onUploadProgress) onUploadProgress(ev.loaded, ev.total || payload.length);
          }
        },
        onprogress: function (ev) {
          if (onUploadProgress && ev.lengthComputable) onUploadProgress(ev.loaded, ev.total || payload.length);
        },
        onload: function (res) {
          let json = null;
          try {
            json = JSON.parse(res.responseText || '{}');
          } catch (_) {
            json = { ok: res.status >= 200 && res.status < 300, raw: res.responseText };
          }

          if (res.status >= 200 && res.status < 300) {
            resolve(json);
          } else {
            reject(new Error(`HTTP ${res.status}: ${res.responseText || '同步失败'}`));
          }
        },
        onerror: function (err) {
          reject(err || new Error('网络错误'));
        },
        ontimeout: function () {
          reject(new Error('同步超时'));
        }
      });
    });
  }

  function gmPostNdjson(url, items, onUploadProgress) {
    const payload = items.map(item => JSON.stringify(item)).join('\n') + '\n';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        data: payload,
        timeout: 60000,
        upload: {
          onprogress: function (ev) {
            if (onUploadProgress) onUploadProgress(ev.loaded, ev.total || payload.length);
          }
        },
        onprogress: function (ev) {
          if (onUploadProgress && ev.lengthComputable) onUploadProgress(ev.loaded, ev.total || payload.length);
        },
        onload: function (res) {
          let json = null;
          try {
            json = JSON.parse(res.responseText || '{}');
          } catch (_) {
            json = { ok: res.status >= 200 && res.status < 300, raw: res.responseText };
          }

          if (res.status >= 200 && res.status < 300) {
            resolve(json);
          } else {
            reject(new Error(`HTTP ${res.status}: ${res.responseText || '流式同步失败'}`));
          }
        },
        onerror: function (err) {
          reject(err || new Error('网络错误'));
        },
        ontimeout: function () {
          reject(new Error('同步超时'));
        }
      });
    });
  }

  async function reconcileExistingWithMysql(items, source = 'manual') {
    const list = Array.isArray(items) ? items : [];
    const workIds = [];
    const seenIds = new Set();

    for (const item of list) {
      if (!item || !item.work_id) continue;
      const id = String(item.work_id);
      const key = getSyncKeyFromWorkId(id);
      if (!key || syncAckedKeys.has(key) || seenIds.has(id)) continue;
      seenIds.add(id);
      workIds.push(id);
    }

    if (!workIds.length) {
      syncState.reconciled = true;
      syncState.reconcileChecked = 0;
      syncState.reconcileExisting = 0;
      updateSyncCounters();
      saveSyncPersist();
      return { ok: true, checked: 0, existing: 0 };
    }

    syncState.syncing = true;
    syncState.lastMessage = `先校准 MySQL 已存在数据：0/${workIds.length}`;
    syncState.progressPercent = 0;
    updatePanel();

    let checked = 0;
    let existing = 0;

    try {
      for (let i = 0; i < workIds.length; i += CONFIG.syncReconcileBatchSize) {
        const chunk = workIds.slice(i, i + CONFIG.syncReconcileBatchSize);
        const res = await gmPostJson(CONFIG.syncExistingApiUrl, { work_ids: chunk });
        const existingWorkIds = Array.isArray(res?.existingWorkIds) ? res.existingWorkIds : [];

        for (const id of existingWorkIds) {
          const key = getSyncKeyFromWorkId(id);
          if (!key) continue;
          syncAckedKeys.add(key);
          syncPendingKeys.delete(key);
          syncFailedKeys.delete(key);
          delete syncRetryCountByKey[key];
        }

        checked += chunk.length;
        existing += existingWorkIds.length;
        syncState.reconcileChecked = checked;
        syncState.reconcileExisting = existing;
        syncState.progressPercent = workIds.length ? Math.min(99, (checked / workIds.length) * 100) : 100;
        syncState.lastMessage = `校准中：MySQL 已有 ${existing} 条，已检查 ${checked}/${workIds.length}`;
        updateSyncCounters();
        saveSyncPersist();
        updatePanel();
      }

      syncState.reconciled = true;
      syncState.lastOk = true;
      syncState.lastAt = Date.now();
      syncState.progressPercent = 100;
      syncState.lastMessage = existing
        ? `校准完成：MySQL 已有 ${existing} 条，只上传剩余未存在数据`
        : `校准完成：MySQL 暂未发现已存在数据`;
      updateSyncCounters();
      saveSyncPersist();
      updatePanel();
      return { ok: true, checked, existing };
    } catch (e) {
      syncState.lastOk = false;
      syncState.reconciled = false;
      syncState.lastMessage = `校准失败，已停止上传以避免全量重传：${e.message || e}`;
      updateSyncCounters();
      saveSyncPersist();
      updatePanel();
      throw e;
    } finally {
      syncState.syncing = false;
    }
  }

  async function postSyncBatch(batch) {
    const onUploadProgress = (loaded, total) => applyUploadProgress(loaded, total, batch.length);
    if (CONFIG.syncUseStreamEndpoint) {
      return gmPostNdjson(CONFIG.syncStreamApiUrl, batch, onUploadProgress);
    }
    return gmPostJson(CONFIG.syncApiUrl, { items: batch }, onUploadProgress);
  }

  function markBatchResult(batch, res) {
    const batchKeys = batch.map(getSyncKey).filter(Boolean);
    let okKeys = new Set();
    let failedKeys = new Set();

    if (Array.isArray(res?.results)) {
      for (const r of res.results) {
        const item = r && r.work_id ? batch.find(x => String(x.work_id) === String(r.work_id)) : null;
        const key = item ? getSyncKey(item) : null;
        if (!key) continue;
        if (r.ok) okKeys.add(key);
        else failedKeys.add(key);
      }
    } else if (res?.ok !== false) {
      okKeys = new Set(batchKeys);
    }

    for (const key of okKeys) {
      syncPendingKeys.delete(key);
      syncFailedKeys.delete(key);
      syncAckedKeys.add(key);
      delete syncRetryCountByKey[key];
    }

    for (const key of failedKeys) {
      syncPendingKeys.delete(key);
      syncFailedKeys.add(key);
    }

    // 老服务端没有逐条 results 时，认为整批成功；新服务端逐条返回时，只确认 ok 的行。
    const confirmed = okKeys.size || (res?.insertedOrUpdated || 0);
    syncState.runDone += Math.max(confirmed, okKeys.size);
    syncState.lastCount += okKeys.size;
    syncState.lastAt = Date.now();
    syncState.lastOk = failedKeys.size === 0;
    updateSyncCounters();
    saveSyncPersist();
  }

  function scheduleSyncRetry(reason) {
    if (!CONFIG.autoSyncToMysql || !syncPendingKeys.size) return;
    if (syncRetryTimer) clearTimeout(syncRetryTimer);

    let maxRetry = 0;
    for (const key of syncPendingKeys) {
      maxRetry = Math.max(maxRetry, Number(syncRetryCountByKey[key] || 0));
    }
    if (maxRetry >= CONFIG.syncMaxAutoRetries) {
      syncState.lastMessage = `已暂停自动续传：${reason || '连续失败'}，可点“同步MySQL”重试`;
      updatePanel();
      return;
    }

    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = null;
      startSyncPump('auto-retry');
    }, CONFIG.syncRetryDelayMs);
  }

  function enqueueItemsForSync(items, source = 'auto', options = {}) {
    if (!Array.isArray(items) || !items.length) return 0;
    indexCollectedItems();

    let added = 0;
    for (const item of items) {
      if (!item || !item.work_id || !item.prompt) continue;
      const key = getSyncKey(item);
      if (!key) continue;
      syncItemIndex.set(key, item);
      if (!options.force && syncAckedKeys.has(key)) continue;
      syncPendingKeys.add(key);
      syncFailedKeys.delete(key);
      added++;
    }

    if (added > 0) {
      if (syncState.syncing) {
        // 正在上传时采集到的新数据直接并入本轮进度，真正做到边采集边传。
        syncState.runTotal += added;
      }
      updateSyncCounters();
      saveSyncPersist();
      syncState.lastMessage = source === 'manual'
        ? `已加入同步队列 ${added} 条`
        : `边采集边排队 ${added} 条`;
      updatePanel();
    }
    return added;
  }

  async function processSyncQueue(source = 'auto') {
    if (syncState.syncing) return syncPumpPromise;
    if (!syncPendingKeys.size) {
      updateSyncCounters();
      syncState.progressPercent = 100;
      syncState.lastOk = true;
      syncState.lastMessage = syncFailedKeys.size ? `无待传；失败 ${syncFailedKeys.size} 条` : '已全部同步';
      updatePanel();
      return;
    }

    syncState.syncing = true;
    resetSyncProgressForRun(source);

    try {
      while (syncPendingKeys.size) {
        const batch = buildSyncBatch();
        if (!batch.length) break;

        syncState.currentBatch = batch.length;
        syncState.currentBatchTotal = syncPendingKeys.size;
        syncState.lastMessage = `准备上传 ${batch.length} 条，剩余 ${syncPendingKeys.size} 条`;
        updatePanel();

        const res = await postSyncBatch(batch);
        markBatchResult(batch, res);

        syncState.progressPercent = syncState.runTotal > 0
          ? Math.min(100, (syncState.runDone / syncState.runTotal) * 100)
          : 100;
        syncState.lastMessage = syncPendingKeys.size
          ? `已写入 ${syncState.runDone}/${syncState.runTotal}，继续上传...`
          : `同步完成 ${syncState.runDone}/${syncState.runTotal}`;
        updatePanel();

        await new Promise(r => setTimeout(r, CONFIG.syncPumpIntervalMs));
      }

      syncState.lastOk = syncFailedKeys.size === 0;
      syncState.progressPercent = syncPendingKeys.size ? syncState.progressPercent : 100;
      syncState.lastMessage = syncPendingKeys.size
        ? `待续传 ${syncPendingKeys.size} 条`
        : (syncFailedKeys.size ? `完成；失败 ${syncFailedKeys.size} 条` : `全部同步完成，共确认 ${syncAckedKeys.size} 条`);
      updateSyncCounters();
      saveSyncPersist();
    } catch (e) {
      for (const key of syncPendingKeys) {
        syncRetryCountByKey[key] = Number(syncRetryCountByKey[key] || 0) + 1;
      }
      syncState.lastOk = false;
      syncState.lastMessage = `中断，保留断点：剩余 ${syncPendingKeys.size} 条；${e.message || e}`;
      updateSyncCounters();
      saveSyncPersist();
      console.warn('[即梦收集器] MySQL 同步中断，已保留断点:', e);
      scheduleSyncRetry(e.message || String(e));
    } finally {
      syncState.syncing = false;
      syncState.currentBatch = 0;
      syncState.uploadedBytes = 0;
      syncState.uploadTotalBytes = 0;
      updatePanel();
    }
  }

  function startSyncPump(source = 'auto') {
    if (syncPumpPromise && syncState.syncing) return syncPumpPromise;
    syncPumpPromise = processSyncQueue(source).finally(() => {
      syncPumpPromise = null;
    });
    return syncPumpPromise;
  }

  async function syncItemsToMysql(items, source = 'auto') {
    const added = enqueueItemsForSync(items, source);
    if (!added && !syncPendingKeys.size) {
      syncState.lastOk = true;
      syncState.progressPercent = 100;
      syncState.lastMessage = '这些数据已同步，无需重复上传';
      updatePanel();
      return;
    }
    return startSyncPump(source);
  }

  async function syncAllToMysql() {
    if (!collected.length) {
      alert('当前没有可同步数据');
      return;
    }

    try {
      // 关键修复：旧版本上传过的数据没有本地 ack 记录。
      // 因此手动同步前必须先问 MySQL 哪些 work_id 已存在，确认后只上传缺失项。
      await reconcileExistingWithMysql(collected, 'manual');
    } catch (e) {
      alert(`为了避免把旧数据全部重新上传，本次同步已停止。

请确认你已经启动新版 server.resumable.js，且包含 /api/jimeng/prompts/existing 接口。

错误：${e.message || e}`);
      return;
    }

    const added = enqueueItemsForSync(collected, 'manual', { force: false });
    if (!added && !syncPendingKeys.size) {
      syncState.lastOk = true;
      syncState.progressPercent = 100;
      syncState.lastMessage = `MySQL 已有全部数据，无需重复上传（已确认 ${syncAckedKeys.size} 条）`;
      updatePanel();
      return;
    }
    await startSyncPump('manual');
  }

  async function resumePendingSync() {
    reconcileSyncQueueWithCollected(false);
    if (!CONFIG.autoResumePendingSync || !syncPendingKeys.size) return;

    try {
      // 关键修复：如果 v1.3.0 曾把历史数据全部塞入 pending，先用 MySQL 反查剔除已存在项。
      await reconcileExistingWithMysql(getPendingItems(), 'resume');
    } catch (e) {
      syncState.lastMessage = `发现待续传 ${syncPendingKeys.size} 条，但无法校准 MySQL，已暂停以避免重复上传`;
      updatePanel();
      return;
    }

    if (syncPendingKeys.size) {
      syncState.lastMessage = `发现未完成同步 ${syncPendingKeys.size} 条，准备断点续传`;
      updatePanel();
      startSyncPump('resume');
    } else {
      syncState.lastOk = true;
      syncState.progressPercent = 100;
      syncState.lastMessage = `MySQL 已有这些数据，无需续传（已确认 ${syncAckedKeys.size} 条）`;
      updatePanel();
    }
  }

  async function testSyncApi() {
    syncState.syncing = true;
    syncState.lastMessage = '测试连接中...';
    updatePanel();

    try {
      const testItem = {
        work_id: 'test_' + Date.now(),
        prompt: '这是一条即梦收集器 MySQL 同步测试数据，可删除。',
        author: 'sync-test',
        model: 'test',
        create_time: null,
        collected_at: new Date().toISOString(),
        image_url: '',
        image_high: '',
        aspect_ratio: ''
      };

      const res = CONFIG.syncUseStreamEndpoint
        ? await gmPostNdjson(CONFIG.syncStreamApiUrl, [testItem], (loaded, total) => applyUploadProgress(loaded, total, 1))
        : await gmPostJson(CONFIG.syncApiUrl, { items: [testItem] }, (loaded, total) => applyUploadProgress(loaded, total, 1));

      syncState.lastOk = res?.ok !== false;
      syncState.lastAt = Date.now();
      syncState.progressPercent = 100;
      syncState.lastMessage = CONFIG.syncUseStreamEndpoint ? '流式API连接正常' : 'API连接正常';
      alert('连接成功：本地 API 可以写入 MySQL。');
    } catch (e) {
      syncState.lastOk = false;
      syncState.lastMessage = `连接失败：${e.message || e}`;
      alert('连接失败：请确认本地同步 API 已启动，地址是：\n' + (CONFIG.syncUseStreamEndpoint ? CONFIG.syncStreamApiUrl : CONFIG.syncApiUrl) + '\n\n错误：' + (e.message || e));
    } finally {
      syncState.syncing = false;
      updatePanel();
    }
  }

  // ==================== 工具函数 ====================
  function findScrollContainer() {
    const masonry = document.querySelector('.masonry-layout');
    if (masonry) {
      const cand = masonry.closest('[class*="scroll-container"]');
      if (cand) return cand;
    }
    const cands = Array.from(document.querySelectorAll('[class*="scroll-container-"]'));
    return cands.find(c => c.scrollHeight > c.clientHeight + 100 && c.querySelector('.masonry-layout')) || null;
  }

  // ==================== Phase 1: Shadow DOM + 自适应 + 多层防御 (UI Agent 完整产出，已集成) ====================
  // Production throttle + idle helper (from subagent)
  function throttle(fn, delay) {
    let last = 0, timer = null;
    return function(...args) {
      const now = Date.now();
      if (now - last >= delay) {
        last = now;
        fn.apply(this, args);
      } else {
        clearTimeout(timer);
        timer = setTimeout(() => {
          last = Date.now();
          fn.apply(this, args);
        }, delay - (now - last));
      }
    };
  }

  function requestIdleOrTimeout(cb, timeout = 200) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(cb, { timeout });
    } else {
      setTimeout(cb, timeout);
    }
  }

  // --- 核心 Phase 1 函数集（直接来自 UI 子 Agent 生产级设计） ---

  function detectGenerateBarHeight() {
    // Multi-strategy detection (text-stable on jimeng React SPA)
    let candidates = [];

    // 1. Direct placeholder / value match (most reliable per snapshots)
    const ta = document.querySelector('textarea[placeholder*="输入想法"]') ||
               document.querySelector('textarea[value*="输入想法"]') ||
               document.querySelector('[contenteditable][aria-placeholder*="输入想法"]') ||
               document.querySelector('textarea');
    if (ta) candidates.push(ta);

    // 2. "Agent 模式" text + nearby controls (second most stable)
    const agentEls = Array.from(document.querySelectorAll('*')).filter(el =>
      el.textContent && (el.textContent.includes('Agent 模式') || el.textContent.includes('输入想法'))
    );
    candidates.push(...agentEls);

    // 3. Bottom toolbar / generate-related class heuristics
    const barLikes = document.querySelectorAll('[class*="bottom"], [class*="generate"], [class*="input"], [class*="toolbar"], [style*="position:fixed"]');
    candidates.push(...Array.from(barLikes));

    for (const el of candidates) {
      if (!el || !el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      // Must be near bottom of viewport and reasonably tall
      if (rect.bottom > window.innerHeight - 120 && rect.height > 20 && rect.width > 200) {
        const h = Math.ceil(rect.height);
        return Math.min(Math.max(h + 14, 48), 220); // safe margin + clamp
      }
    }

    // 4. Fallback: any fixed bottom large container
    const fixedBottoms = Array.from(document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]'))
      .filter(d => {
        const r = d.getBoundingClientRect();
        return r.bottom > window.innerHeight * 0.7 && r.height > 30;
      });
    if (fixedBottoms.length) {
      const tallest = fixedBottoms.sort((a,b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      return Math.ceil(tallest.getBoundingClientRect().height) + 16;
    }

    return 92; // Conservative default matching current jimeng bar + margin
  }

  function adaptivePositionPanel() {
    if (!shadowHost) return;
    const barH = detectGenerateBarHeight();
    const saved = GM_getValue(POS_KEY, { right: '16px', bottom: '16px' });

    let targetBottom = barH + 14;
    if (saved.bottom) {
      const savedPx = parseInt(saved.bottom, 10) || 16;
      targetBottom = Math.max(savedPx, targetBottom);
    }

    // Anti-collision + viewport clamp
    const maxBottom = window.innerHeight - 80;
    targetBottom = Math.min(targetBottom, maxBottom);

    shadowHost.style.right = saved.right || '16px';
    shadowHost.style.bottom = targetBottom + 'px';
    shadowHost.style.left = 'auto';
  }

  function savePosition() {
    if (!shadowHost) return;
    const pos = {
      right: shadowHost.style.right || '16px',
      bottom: shadowHost.style.bottom || '16px'
    };
    GM_setValue(POS_KEY, pos);
  }

  function makeDraggable(element) {
    let isDragging = false;
    let startX, startY, startRight, startBottom;

    const onPointerDown = (e) => {
      const target = e.target;
      if (!target.closest('.jc-drag-handle') && !target.closest('.jc-fab')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseInt(element.style.right, 10) || 16;
      startBottom = parseInt(element.style.bottom, 10) || 16;
      element.style.transition = 'none';
      document.body.style.userSelect = 'none';
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      const dx = startX - e.clientX;
      const dy = startY - e.clientY;

      let newRight = Math.max(4, Math.min(startRight + dx, window.innerWidth - 60));
      let newBottom = Math.max(4, Math.min(startBottom + dy, window.innerHeight - 60));

      element.style.right = newRight + 'px';
      element.style.bottom = newBottom + 'px';
      element.style.left = 'auto';
    };

    const onPointerUp = () => {
      if (!isDragging) return;
      isDragging = false;
      element.style.transition = '';
      document.body.style.userSelect = '';
      savePosition();
      setTimeout(adaptivePositionPanel, 50);
    };

    element.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    element.addEventListener('mousedown', onPointerDown);
  }

  function attachShadowEvents() {
    if (!shadowRoot) return;
    const root = shadowRoot;

    const collapseBtn = root.querySelector('#jc-collapse');
    if (collapseBtn) {
      collapseBtn.onclick = () => {
        const cur = GM_getValue(COLLAPSED_KEY, false);
        GM_setValue(COLLAPSED_KEY, !cur);
        renderPanelContent();
        setTimeout(adaptivePositionPanel, 30);
      };
    }

    const toggleBtn = root.querySelector('#jc-toggle');
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        if (isRunning) isRunning = false;
        else startCollection();
        updateShadowPanel();
      };
    }
    const viewBtn = root.querySelector('#jc-view');
    if (viewBtn) viewBtn.onclick = showCollectedModal;
    const exportBtn = root.querySelector('#jc-export');
    if (exportBtn) exportBtn.onclick = exportData;

    const syncBtn = root.querySelector('#jc-sync');
    if (syncBtn) syncBtn.onclick = syncAllToMysql;

    const testSyncBtn = root.querySelector('#jc-test-sync');
    if (testSyncBtn) testSyncBtn.onclick = testSyncApi;

    const galleryBtn = root.querySelector('#jc-gallery');
    if (galleryBtn) {
      galleryBtn.onclick = () => {
        if (!collected.length) { alert('还没有采集到数据'); return; }
        const html = generateSelfContainedHTMLReport(collected);
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `jimeng_visual_gallery_${new Date().toISOString().slice(0,10)}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 800);
      };
    }

    const clearBtn = root.querySelector('#jc-clear');
    if (clearBtn) {
      clearBtn.onclick = () => {
        pruneCollected(true);   // 内部已有 confirm 提示，建议先导出
        updateShadowPanel();
      };
    }

    const fab = root.querySelector('.jc-fab');
    if (fab) {
      fab.onclick = (e) => {
        if (e.target.closest('#jc-collapse')) return;
        GM_setValue(COLLAPSED_KEY, false);
        renderPanelContent();
        setTimeout(adaptivePositionPanel, 30);
      };
    }
  }

  function renderPanelContent() {
    if (!shadowRoot) return;

    const isCollapsed = GM_getValue(COLLAPSED_KEY, false);
    const count = collected.length;

    const oldContent = shadowRoot.querySelector('.jc-root');
    if (oldContent) oldContent.remove();

    const container = document.createElement('div');
    container.className = 'jc-root';

    if (isCollapsed) {
      container.innerHTML = `
        <div class="jc-fab" title="即梦收集器（可拖动此图标，点击展开完整面板）">
          <span style="font-size:18px;">📝</span>
          <div class="jc-badge" id="jc-badge">${count > 99 ? '99+' : count}</div>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="jc-panel">
          <div class="jc-header jc-drag-handle" style="padding:6px 10px; background:#1e2937; display:flex; justify-content:space-between; align-items:center; cursor:move; border-bottom:1px solid #334155;">
            <div style="font-weight:600; color:#60a5fa; font-size:12px; display:flex; align-items:center; gap:4px;">
              <span style="opacity:0.6; font-size:13px;">⋮⋮</span> 即梦收集器
            </div>
            <button id="jc-collapse" style="background:transparent; border:none; color:#94a3b8; font-size:14px; cursor:pointer; padding:1px 6px;">_</button>
          </div>
          <div style="padding:8px 10px;">
            <div style="margin-bottom:6px; font-size:12px; display:flex; align-items:center; justify-content:space-between;">
              <span>已收集：<span id="jc-count" style="color:#22c55e; font-weight:600;">${count}</span><span id="jc-rate" style="margin-left:4px;font-size:10px;color:#64748b;"></span></span>
              <button id="jc-clear" style="font-size:10px; padding:1px 6px; background:#450a0a; color:#fda4af; border:none; border-radius:4px; cursor:pointer;">清空</button>
            </div>
            <div style="margin-bottom:4px; font-size:10px; color:#94a3b8;">
              MySQL：<span id="jc-sync-status" style="color:#64748b;">${syncState.lastMessage || '未同步'}</span>
            </div>
            <div style="margin-bottom:6px; font-size:10px; color:#64748b; display:flex; justify-content:space-between; gap:6px;">
              <span>队列 <span id="jc-sync-queue">${syncState.queued || 0}</span></span>
              <span>已确认 <span id="jc-sync-done">${syncState.synced || 0}</span></span>
              <span>失败 <span id="jc-sync-failed">${syncState.failed || 0}</span></span>
            </div>
            <div style="height:5px; background:#1e2937; border-radius:999px; overflow:hidden; margin-bottom:7px;">
              <div id="jc-sync-bar" style="height:100%; width:${Math.round(syncState.progressPercent || 0)}%; background:#22c55e; transition:width .18s ease;"></div>
            </div>
            <div style="display:flex; gap:5px; flex-wrap:wrap;">
              <button id="jc-toggle" style="flex:1; padding:4px 8px; background:#166534; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:11px;">开始/继续</button>
              <button id="jc-view" style="flex:1; padding:4px 8px; background:#334155; color:#e2e8f0; border:none; border-radius:5px; cursor:pointer; font-size:11px;">查看已采</button>
              <button id="jc-gallery" style="flex:1; padding:4px 8px; background:#7c3aed; color:white; border:none; border-radius:5px; cursor:pointer; font-size:11px;">视觉画廊</button>
              <button id="jc-export" style="flex:1; padding:4px 8px; background:#1e40af; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:11px;">导出</button>
              <button id="jc-sync" style="flex:1; padding:4px 8px; background:#0f766e; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:11px;">同步MySQL</button>
              <button id="jc-test-sync" style="flex:1; padding:4px 8px; background:#475569; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:11px;">测试API</button>
            </div>
            <div style="font-size:9px; color:#64748b; margin-top:5px; text-align:center; opacity:0.85;">速度优先模式 + MySQL 自动同步</div>
          </div>
        </div>
      `;
    }

    shadowRoot.appendChild(container);
    attachShadowEvents();
    updateShadowPanel();
  }

  function createShadowPanel() {
    if (shadowHost && shadowHost.isConnected && shadowRoot) return;

    if (shadowHost) shadowHost.remove();

    shadowHost = document.createElement('div');
    shadowHost.id = 'jimeng-collector-shadow-host';
    shadowHost.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      pointer-events: auto;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .jc-root { font-size: 13px; line-height: 1.4; color: #e2e8f0; }
      .jc-fab {
        width: 46px; height: 46px; border-radius: 9999px;
        background: #1e2937; border: 1px solid #475569;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45);
        position: relative; cursor: pointer;
      }
      .jc-badge {
        position: absolute; top: -3px; right: -3px;
        background: #22c55e; color: #0f172a; font-size: 10px; font-weight: 700;
        padding: 0 5px; min-width: 16px; height: 16px; line-height: 16px;
        border-radius: 999px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      }
      .jc-panel {
        background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.5);
        min-width: 248px; overflow: hidden;
      }
      .jc-panel button { transition: filter .1s; }
      .jc-panel button:hover { filter: brightness(1.1); }
      .jc-header { user-select: none; }
    `;
    shadowRoot.appendChild(style);

    renderPanelContent();
    document.body.appendChild(shadowHost);

    makeDraggable(shadowHost);
    adaptivePositionPanel();
  }

  // 简单采集速率统计（只在运行时有效）
  let collectionStartTs = 0;
  let lastCountForRate = 0;

  function updateShadowPanel() {
    if (!shadowRoot) return;

    const count = collected.length;
    const countEl = shadowRoot.querySelector('#jc-count');
    if (countEl) countEl.textContent = count;

    const badge = shadowRoot.querySelector('#jc-badge');
    if (badge) badge.textContent = count > 99 ? '99+' : count;

    const toggleBtn = shadowRoot.querySelector('#jc-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = isRunning ? '停止收集' : '开始/继续收集';
      toggleBtn.style.background = isRunning ? '#450a0a' : '#166534';
    }

    const syncStatusEl = shadowRoot.querySelector('#jc-sync-status');
    if (syncStatusEl) {
      syncStatusEl.textContent = syncState.lastMessage || '未同步';
      syncStatusEl.style.color = syncState.syncing ? '#facc15' : (syncState.lastOk ? '#22c55e' : '#f87171');
    }

    const queueEl = shadowRoot.querySelector('#jc-sync-queue');
    if (queueEl) queueEl.textContent = String(syncState.queued || syncPendingKeys.size || 0);

    const doneEl = shadowRoot.querySelector('#jc-sync-done');
    if (doneEl) doneEl.textContent = String(syncState.synced || syncAckedKeys.size || 0);

    const failedEl = shadowRoot.querySelector('#jc-sync-failed');
    if (failedEl) failedEl.textContent = String(syncState.failed || syncFailedKeys.size || 0);

    const barEl = shadowRoot.querySelector('#jc-sync-bar');
    if (barEl) {
      const pct = Math.max(0, Math.min(100, Number(syncState.progressPercent || 0)));
      barEl.style.width = pct.toFixed(1) + '%';
      barEl.style.background = syncState.lastOk === false ? '#f87171' : (syncState.syncing ? '#facc15' : '#22c55e');
    }

    const syncBtn = shadowRoot.querySelector('#jc-sync');
    if (syncBtn) {
      syncBtn.textContent = syncState.syncing ? `${Math.round(syncState.progressPercent || 0)}%` : '同步MySQL';
      syncBtn.disabled = !!syncState.syncing;
      syncBtn.style.opacity = syncState.syncing ? '0.65' : '1';
    }

    // 显示当前采集速率（items/min），方便你直接看到速度效果
    const rateEl = shadowRoot.querySelector('#jc-rate');
    if (rateEl) {
      if (isRunning && collectionStartTs) {
        const elapsedMin = Math.max(0.1, (Date.now() - collectionStartTs) / 1000 / 60);
        const added = count - lastCountForRate;
        const rate = Math.round(added / elapsedMin);
        rateEl.textContent = `(${rate}/min)`;
        rateEl.style.color = rate > 35 ? '#4ade80' : '#facc15';
      } else {
        rateEl.textContent = '';
      }
    }
  }

  function ensurePanelWithDefense() {
    const isTargetPage = location.pathname.includes('/ai-tool/home') ||
                         !!document.querySelector('.masonry-layout');

    if (!isTargetPage) {
      if (shadowHost) {
        shadowHost.remove();
        shadowHost = null;
        shadowRoot = null;
      }
      return;
    }

    const needsCreate = !shadowHost || !shadowHost.isConnected || !shadowRoot;

    if (needsCreate) {
      createShadowPanel();
    } else {
      adaptivePositionPanel();
      updateShadowPanel();
    }
  }

  const throttledEnsure = throttle(() => {
    requestIdleOrTimeout(ensurePanelWithDefense, 180);
  }, 220);

  function onSPAChange() {
    setTimeout(throttledEnsure, 120);
    setTimeout(() => { adaptivePositionPanel(); updateShadowPanel(); }, 650);
    setTimeout(throttledEnsure, 1400);
  }

  function patchHistoryForSPA() {
    if (historyPatched) return;
    try {
      const win = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
      const h = win.history;

      const origPush = h.pushState;
      h.pushState = function(state, title, url) {
        const r = origPush.apply(this, arguments);
        onSPAChange();
        return r;
      };

      const origReplace = h.replaceState;
      h.replaceState = function(state, title, url) {
        const r = origReplace.apply(this, arguments);
        onSPAChange();
        return r;
      };

      win.addEventListener('popstate', onSPAChange);
      historyPatched = true;
    } catch (e) { console.warn('[jc] history patch failed', e); }
  }

  function startMultiLayerDefense() {
    // 1. Throttled MutationObserver
    if (defenseObserver) defenseObserver.disconnect();
    defenseObserver = new MutationObserver((mutations) => {
      let relevant = !shadowHost || !shadowHost.isConnected;
      if (!relevant) {
        for (const m of mutations) {
          if (m.addedNodes.length) {
            relevant = true; break;
          }
        }
      }
      if (relevant) throttledEnsure();
    });
    defenseObserver.observe(document.documentElement, { childList: true, subtree: true });

    // 2. History patch (unsafeWindow)
    patchHistoryForSPA();

    // 3. Tampermonkey onurlchange (primary for TM)
    try {
      if (typeof window.onurlchange !== 'undefined') {
        if (window.onurlchange === null || typeof window.onurlchange === 'function') {
          window.onurlchange = (info) => onSPAChange();
        }
      }
      window.addEventListener('urlchange', onSPAChange);
    } catch (e) {}

    // 4. Lightweight existence poll (every ~2.6s)
    const pollId = setInterval(() => {
      if (!shadowHost || !shadowHost.isConnected) {
        ensurePanelWithDefense();
      } else {
        adaptivePositionPanel();
      }
    }, 2600);
    defenseIntervals.push(pollId);

    // 5. Visibility + focus + resize
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) throttledEnsure();
    });
    window.addEventListener('focus', throttledEnsure);
    window.addEventListener('resize', throttle(() => {
      adaptivePositionPanel();
    }, 280));

    // Initial kick
    setTimeout(ensurePanelWithDefense, 280);
    setTimeout(ensurePanelWithDefense, 1200);
    setTimeout(ensurePanelWithDefense, 2800);
  }

  // 旧占位注释已由 Phase 1 完整实现替换。后续其他 Agent 模块将继续在此区域或独立位置集成。

  function extractImageHash(src) {
    if (!src) return null;
    let m = src.match(/tos-[^/]+\/([a-f0-9]{16,})/i);
    if (m) return m[1];
    m = src.match(/\/([a-f0-9]{20,})[~-]/i);
    if (m) return m[1];
    return src.split('/').pop().split(/[?~]/)[0].substring(0, 40);
  }

  // ==================== 网络拦截（核心） ====================
  let capturedResponses = [];

  function hookNetwork() {
    const origFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
      if (url.includes('/mweb/v1/get_explore')) {
        try {
          const clone = res.clone();
          const json = await clone.json();
          if (json?.data?.item_list?.length) {
            capturedResponses.push(json.data);
          }
        } catch (e) {}
      }
      return res;
    };

    const origOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._url = url;
      return origOpen.apply(this, [method, url, ...rest]);
    };

    const origSend = unsafeWindow.XMLHttpRequest.prototype.send;
    unsafeWindow.XMLHttpRequest.prototype.send = function (body) {
      this.addEventListener('load', function () {
        if (this._url && this._url.includes('/mweb/v1/get_explore')) {
          try {
            const json = JSON.parse(this.responseText);
            if (json?.data?.item_list?.length) {
              capturedResponses.push(json.data);
            }
          } catch (e) {}
        }
      });
      return origSend.apply(this, [body]);
    };
  }

  // ==================== 数据处理（带可靠去重） ====================
  function processCapturedData() {
    let added = 0;
    const newItems = [];
    while (capturedResponses.length > 0) {
      const data = capturedResponses.shift();
      if (!data.item_list) continue;

      for (const item of data.item_list) {
        const workId = item.common_attr?.id;
        const prompt = item.aigc_image_params?.text2image_params?.prompt;
        if (!prompt) continue;

        // 提取图片 URL（优先 cover_url_map 中的合适尺寸，用于视觉画廊）
        const cover = item.common_attr?.cover_url || '';
        const urlMap = item.common_attr?.cover_url_map || {};
        // 画廊优先使用 720 或 1080（清晰但体积可控），兜底 cover
        const galleryUrl = urlMap['720'] || urlMap['1080'] || urlMap['480'] || urlMap['360'] || cover;
        const highResUrl = urlMap['2048'] || urlMap['1080'] || cover;

        const record = {
          work_id: workId,
          prompt: prompt.trim(),
          author: item.author?.name || '',
          create_time: item.common_attr?.create_time,
          model: item.aigc_image_params?.text2image_params?.model_name || '',
          collected_at: new Date().toISOString(),
          // 新增：图片 + 提示词对应关系所需字段
          image_url: galleryUrl,      // 用于画廊展示（推荐尺寸）
          image_high: highResUrl,     // 高清原图（如果需要）
          aspect_ratio: item.common_attr?.aspect_ratio || null
        };

        const key = getDedupKey(record);
        if (!key || seen.has(key)) continue;

        collected.push(record);
        seen.add(key);
        newItems.push(record);
        added++;
      }
    }
    if (added > 0) {
      saveData();
      if (CONFIG.autoSyncToMysql) syncItemsToMysql(newItems, 'auto');
      updatePanel();
    }
    return added;
  }

  // ==================== 滚动 ====================
  // ==================== Phase 4: 人类化滚动 + 基础韧性（Stealth/Resilience 方向落地） ====================
  async function smartScroll(container, steps = 2) {
    const baseStep = Math.floor(container.clientHeight * CONFIG.scrollStepRatio);

    for (let i = 0; i < steps; i++) {
      // 速度优先策略（你明确表示只在乎抓取时间，同时不被判定为违规）
      // 核心思路：保持较高平均速度，但用廉价的随机抖动打破完美规律（这是最有效的低成本反检测手段）

      const jitter = (Math.random() - 0.5) * (baseStep * CONFIG.scrollJitterRatio);
      const thisStep = Math.max(180, Math.floor(baseStep * (0.85 + Math.random() * 0.38) + jitter));

      container.scrollTop += thisStep;

      // 只在必要时做极小的反向（大幅降低概率和时长，减少时间浪费）
      if (Math.random() < 0.035) {
        await new Promise(r => setTimeout(r, 90 + Math.random() * 160));
        container.scrollTop -= Math.floor(thisStep * 0.18);
      }

      // 关键：等待时间以 CONFIG.baseWaitAfterScrollMs 为中心，做有意义的随机抖动
      // 这比固定长等待或长时间“思考停顿”更安全，同时速度更快
      const baseWait = CONFIG.baseWaitAfterScrollMs;
      const jitterWait = (Math.random() - 0.5) * (baseWait * CONFIG.scrollJitterRatio);
      let wait = baseWait + jitterWait;

      // 硬性边界
      wait = Math.max(CONFIG.minWaitMs, Math.min(CONFIG.maxWaitMs, wait));

      await new Promise(r => setTimeout(r, wait));
    }
  }

  // 简单 IDB 占位 + Export+Prune 辅助（Phase 3 文化）
  async function initIDBIfAvailable() { return null; }

  function pruneCollected(confirmFirst = true) {
    if (confirmFirst && !confirm(`确定清空当前已采集的 ${collected.length} 条数据？（建议先导出 HTML 报告）`)) return;
    collected = [];
    seen = new Set();
    syncItemIndex = new Map();
    syncAckedKeys = new Set();
    syncPendingKeys = new Set();
    syncFailedKeys = new Set();
    syncRetryCountByKey = {};
    try {
      GM_setValue(CONFIG.outputKey, '[]');
      GM_setValue(CONFIG.syncStateKey, '{}');
      storageMeta.lastCheckpoint = { ts: Date.now(), count: 0 };
      storageMeta.lastSyncAt = null;
      storageMeta.lastSyncCount = 0;
      saveMeta();
    } catch (e) {}
    updateSyncCounters();
    updatePanel();
    console.log('[即梦收集器] 已清理本地采集数据');
  }

  // ==================== 主循环（速度优先 + 低成本反检测） ====================
  // 按照你的要求：只在意抓取总时间，只要不被即梦明显判定为违规即可
  async function startCollection() {
    if (isRunning) return;
    isRunning = true;
    collectionStartTs = Date.now();
    lastCountForRate = collected.length;
    updatePanel();

    const container = findScrollContainer();
    if (!container) {
      alert('未找到作品列表滚动区域，请确认在「发现」页');
      isRunning = false;
      updatePanel();
      return;
    }

    hookNetwork();

    let noNew = 0;
    const MAX_NO_NEW = 9;                    // 稍微宽容一点，减少过早停止
    let lastAddedTime = Date.now();
    let totalAddedSinceStart = 0;
    const startTime = Date.now();

    const visHandler = () => {
      if (document.hidden && isRunning) {
        // 后台时稍微降低速度（降低被注意的风险）
      }
    };
    document.addEventListener('visibilitychange', visHandler, { once: true });

    while (isRunning && collected.length < CONFIG.maxItems) {
      if (document.hidden) {
        await new Promise(r => setTimeout(r, 650));
        continue;
      }

      const before = collected.length;

      // 动态决定每次滚动的步数：
      // 数据在持续进来时，多滚几步，减少等待开销，提升整体速度
      const dynamicSteps = noNew === 0 ? 3 : (noNew <= 2 ? 2 : 1);

      await smartScroll(container, dynamicSteps);

      const added = processCapturedData();
      totalAddedSinceStart += added;

      if (added > 0) {
        noNew = 0;
        lastAddedTime = Date.now();
      } else {
        noNew++;
      }

      updatePanel();

      // 自适应策略：
      // 当连续没有新内容时，逐步增加等待（这是真正有效的反检测点）
      if (noNew >= 4) {
        await new Promise(r => setTimeout(r, 800 + noNew * 180));
      }

      if (noNew >= MAX_NO_NEW) break;
    }

    isRunning = false;
    updatePanel();
    document.removeEventListener('visibilitychange', visHandler);

    const durationMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[即梦收集器] 本次采集结束：共新增 ${totalAddedSinceStart} 条，耗时约 ${durationMin} 分钟`);
  }

  // ==================== Phase 2: 规模 UX - 自包含 HTML 报告 + 多格式导出 + 轻量分页查看 (DataUX 方向完整落地) ====================

  function exportData(format = 'jsonl') {
    if (!collected.length) {
      alert('还没有采集到数据');
      return;
    }
    const date = new Date().toISOString().slice(0,10);
    let blob, filename;

    if (format === 'html' || format === 'report') {
      const html = generateSelfContainedHTMLReport(collected);
      blob = new Blob([html], { type: 'text/html' });
      filename = `jimeng_prompts_report_${date}.html`;
    } else if (format === 'csv') {
      const headers = ['work_id','prompt','author','model','create_time','collected_at'];
      const rows = collected.map(r => headers.map(h => {
        let v = r[h] || '';
        if (typeof v === 'string') v = v.replace(/"/g, '""');
        return `"${v}"`;
      }).join(','));
      const csv = [headers.join(','), ...rows].join('\n');
      blob = new Blob([csv], { type: 'text/csv' });
      filename = `jimeng_prompts_${date}.csv`;
    } else {
      // jsonl default
      const jsonl = collected.map(item => JSON.stringify(item)).join('\n');
      blob = new Blob([jsonl], { type: 'text/plain' });
      filename = `jimeng_prompts_${date}.jsonl`;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function generateSelfContainedHTMLReport(items) {
    const date = new Date().toISOString().slice(0,10);
    const dataJson = JSON.stringify(items).replace(/</g, '\\u003c');

    // ========== 全新视觉画廊版（图片 + 提示词鲜明对应） ==========
    // 完全绕过官方任何复制/详情流程，所有复制都是直接 clipboard.writeText（极快，无卡顿）
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>即梦 图片+提示词画廊 - ${date} (${items.length} 条)</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<style>
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .gallery-card { transition: transform .15s cubic-bezier(0.2, 0, 0, 1), box-shadow .15s ease; display: flex; flex-direction: column; }
  .gallery-card:hover { transform: translateY(-3px); box-shadow: 0 25px 35px -8px rgb(0 0 0 / 0.18), 0 10px 12px -6px rgb(0 0 0 / 0.12); }
  .gallery-img {
    transition: opacity .35s ease, transform .25s cubic-bezier(0.2, 0, 0, 1);
    opacity: 0;
  }
  .gallery-img.loaded { opacity: 1; }
  .gallery-card:hover .gallery-img { transform: scale(1.012); }
  .prompt-text { font-size: 13.5px; line-height: 1.45; }
  .image-area { background: #0f172a; overflow: hidden; display: flex; align-items: center; justify-content: center; }
</style>
</head>
<body class="bg-slate-950 text-slate-200">
<div class="max-w-[1600px] mx-auto p-5">
  <div class="flex items-center justify-between mb-5">
    <div>
      <h1 class="text-3xl font-semibold tracking-tight">即梦 · 图片 + 提示词 视觉画廊</h1>
      <p class="text-slate-400 mt-1">${date} · 共 <span class="font-mono text-emerald-400 text-lg">${items.length}</span> 条 · 图片与提示词一一对应</p>
      <p style="font-size:11px; color:#475569; margin-top:2px;">主画廊已显示完整图片 · 已启用分页（防止大量数据导致浏览器卡死） · 建议每页 80 张以内</p>
    </div>
    <div class="flex gap-2 flex-wrap">
      <button onclick="copyAllFiltered()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-sm flex items-center gap-2">📋 复制所有筛选提示词</button>
      <button onclick="exportFiltered('jsonl')" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-xl text-sm">JSONL</button>
      <button onclick="exportFiltered('csv')" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-sm">CSV</button>
      <button onclick="downloadAllImages()" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm">打包图片链接</button>
    </div>
  </div>

  <div class="flex gap-3 mb-4 flex-wrap items-center bg-slate-900/70 p-4 rounded-3xl backdrop-blur">
    <input id="search" type="text" placeholder="搜索提示词、作者..."
           class="flex-1 min-w-[280px] bg-slate-800 border border-slate-700 focus:border-blue-500 rounded-2xl px-4 py-2.5 text-sm outline-none" oninput="filterAndRender()">

    <select id="modelFilter" class="bg-slate-800 border border-slate-700 rounded-2xl px-4 py-2.5 text-sm" onchange="filterAndRender()">
      <option value="">所有模型</option>
    </select>

    <select id="sortBy" class="bg-slate-800 border border-slate-700 rounded-2xl px-4 py-2.5 text-sm" onchange="filterAndRender()">
      <option value="collected_desc">最近采集</option>
      <option value="collected_asc">最早采集</option>
      <option value="author">作者</option>
    </select>

    <button onclick="clearFilters()" class="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded-2xl">重置筛选</button>

    <!-- 分页控件 -->
    <div style="display:flex; align-items:center; gap:8px; margin-left:12px;">
      <select id="pageSizeSelect" onchange="changePageSize(this.value)" style="background:#1e2937; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:4px 8px; font-size:12px;">
        <option value="50">每页 50</option>
        <option value="80" selected>每页 80</option>
        <option value="120">每页 120</option>
        <option value="200">每页 200</option>
      </select>
      <button id="pagePrev" onclick="changePage(-1)" style="padding:4px 10px; background:#334155; color:#e2e8f0; border:none; border-radius:6px; cursor:pointer; font-size:12px;">← 上一页</button>
      <span id="pageInfo" style="color:#94a3b8; font-size:12px; min-width:70px; text-align:center;">第 1 / 1 页</span>
      <button id="pageNext" onclick="changePage(1)" style="padding:4px 10px; background:#334155; color:#e2e8f0; border:none; border-radius:6px; cursor:pointer; font-size:12px;">下一页 →</button>
    </div>

    <span id="resultCount" class="ml-auto text-emerald-400 text-sm font-mono px-3"></span>
  </div>

  <div id="gallery" class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"></div>

  <!-- 底部分页控件（方便翻到底部时切换页面） -->
  <div style="margin-top: 20px; padding: 12px 0; border-top: 1px solid #334155; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
    <div style="display:flex; align-items:center; gap:8px;">
      <select id="pageSizeSelectBottom" onchange="changePageSize(this.value)" style="background:#1e2937; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:4px 8px; font-size:12px;">
        <option value="50">每页 50</option>
        <option value="80" selected>每页 80</option>
        <option value="120">每页 120</option>
        <option value="200">每页 200</option>
      </select>
      <button id="pagePrevBottom" onclick="changePage(-1)" style="padding:4px 10px; background:#334155; color:#e2e8f0; border:none; border-radius:6px; cursor:pointer; font-size:12px;">← 上一页</button>
      <span id="pageInfoBottom" style="color:#94a3b8; font-size:12px; min-width:70px; text-align:center;">第 1 / 1 页</span>
      <button id="pageNextBottom" onclick="changePage(1)" style="padding:4px 10px; background:#334155; color:#e2e8f0; border:none; border-radius:6px; cursor:pointer; font-size:12px;">下一页 →</button>
    </div>
    <span style="color:#64748b; font-size:11px; margin-left: auto;">翻到底部也可以切换页面</span>
  </div>

  <div class="mt-8 text-xs text-slate-500 flex justify-between items-center border-t border-slate-800 pt-4">
    <div>此报告完全自包含，可离线打开 · 所有「复制提示词」均为直接剪贴板操作，<strong class="text-emerald-400">完全绕过官方复制流程，无任何卡顿</strong></div>
    <div>由 即梦提示词收集器 v1.0+ 生成</div>
  </div>
</div>

<script>
const DATA = ${dataJson};
let filtered = [...DATA];
let currentPage = 1;
let pageSize = 80;   // 默认每页 80 张，防止电脑卡死

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function filterAndRender(resetPage = true) {
  const q = (document.getElementById('search').value || '').toLowerCase().trim();
  const model = document.getElementById('modelFilter').value;
  const sort = document.getElementById('sortBy').value;

  filtered = DATA.filter(it => {
    const textHit = !q || (it.prompt && it.prompt.toLowerCase().includes(q)) || (it.author && it.author.toLowerCase().includes(q));
    const mHit = !model || it.model === model;
    return textHit && mHit;
  });

  if (sort === 'collected_desc') filtered.sort((a,b) => (b.collected_at||'').localeCompare(a.collected_at||''));
  else if (sort === 'collected_asc') filtered.sort((a,b) => (a.collected_at||'').localeCompare(b.collected_at||''));
  else if (sort === 'author') filtered.sort((a,b) => (a.author||'').localeCompare(b.author||''));

  if (resetPage) currentPage = 1;

  renderPaginatedGallery();
  updatePaginationUI();
  document.getElementById('resultCount').textContent = filtered.length + ' / ' + DATA.length + ' 条';
}

function renderPaginatedGallery() {
  const container = document.getElementById('gallery');
  container.innerHTML = '';

  if (!filtered.length) {
    container.innerHTML = '<div class="col-span-full text-center py-16 text-slate-500 text-lg">没有匹配的图片/提示词</div>';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filtered.length);
  const pageItems = filtered.slice(startIndex, endIndex);

  pageItems.forEach((item, localIndex) => {
    const globalIndex = startIndex + localIndex; // 对应 filtered 数组中的真实索引
    const card = document.createElement('div');
    card.className = 'gallery-card bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden flex flex-col';

    const imgSrc = item.image_url || item.image_high || '';

    card.innerHTML = \`
      <div class="image-area">
        \${imgSrc ?
          \`<img
            src="\${imgSrc}"
            class="gallery-img"
            style="width:100%; height:auto; max-height:460px; object-fit:contain; display:block;"
            loading="lazy"
            decoding="async"
            onerror="this.style.display='none'"
          >\` :
          '<div style="padding:60px 20px; color:#475569; font-size:13px; text-align:center;">无预览图</div>'}
      </div>

      <div style="padding:10px 12px; flex:1; display:flex; flex-direction:column;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
          <div style="font-size:10px; color:#64748b; display:flex; align-items:center; gap:6px;">
            <span>#\${globalIndex + 1}</span>
            <span class="truncate" style="max-width:110px;">\${escapeHtml(item.author || '未知作者')}</span>
          </div>
          <div style="font-size:10px; background:#1e2937; padding:1px 6px; border-radius:999px; color:#94a3b8; font-family:monospace;">\${item.model || ''}</div>
        </div>

        <div class="prompt-text text-slate-200 flex-1" style="overflow:hidden; display:-webkit-box; -webkit-line-clamp:5; -webkit-box-orient:vertical;">\${escapeHtml(item.prompt)}</div>

        <div style="margin-top:8px; padding-top:8px; border-top:1px solid #1e2937; display:flex; gap:6px;">
          <button onclick="copyPrompt(\${globalIndex}, event)"
                  style="flex:1; font-size:11px; padding:6px 0; background:#166534; color:white; border:none; border-radius:999px; cursor:pointer; font-weight:500;">
            复制提示词
          </button>
          <button onclick="copyImageUrl(\${globalIndex}, event)"
                  style="font-size:11px; padding:6px 10px; background:#334155; color:#e2e8f0; border:none; border-radius:999px; cursor:pointer;">图链</button>
          <button onclick="showLarge(\${globalIndex}, event)"
                  style="font-size:11px; padding:6px 10px; background:#334155; color:#e2e8f0; border:none; border-radius:999px; cursor:pointer;" title="进入大图模式仔细查看细节">放大查看</button>
        </div>
      </div>
    \`;
    container.appendChild(card);

    const imgEl = card.querySelector('.gallery-img');
    if (imgEl) {
      imgEl.addEventListener('load', () => imgEl.classList.add('loaded'), { once: true });
      if (imgEl.complete) imgEl.classList.add('loaded');
    }
  });
}

function updatePaginationUI() {
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  // 顶部控件
  const infoTop = document.getElementById('pageInfo');
  if (infoTop) infoTop.textContent = \`第 \${currentPage} / \${totalPages} 页\`;

  const prevTop = document.getElementById('pagePrev');
  const nextTop = document.getElementById('pageNext');
  if (prevTop) prevTop.disabled = currentPage <= 1;
  if (nextTop) nextTop.disabled = currentPage >= totalPages;

  // 底部分页控件（解决翻到底部切换不便的问题）
  const infoBottom = document.getElementById('pageInfoBottom');
  if (infoBottom) infoBottom.textContent = \`第 \${currentPage} / \${totalPages} 页\`;

  const prevBottom = document.getElementById('pagePrevBottom');
  const nextBottom = document.getElementById('pageNextBottom');
  if (prevBottom) prevBottom.disabled = currentPage <= 1;
  if (nextBottom) nextBottom.disabled = currentPage >= totalPages;

  // 同步两个 pageSize 下拉框
  const sizeTop = document.getElementById('pageSizeSelect');
  const sizeBottom = document.getElementById('pageSizeSelectBottom');
  if (sizeTop) sizeTop.value = pageSize;
  if (sizeBottom) sizeBottom.value = pageSize;
}

function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const newPage = currentPage + delta;
  if (newPage < 1 || newPage > totalPages) return;
  currentPage = newPage;
  renderPaginatedGallery();
  updatePaginationUI();
}

function changePageSize(newSize) {
  pageSize = parseInt(newSize);
  currentPage = 1;
  renderPaginatedGallery();
  updatePaginationUI();
}

function copyPrompt(localIdx, e) {
  e?.stopImmediatePropagation?.();
  const item = filtered[localIdx];
  if (!item || !item.prompt) return;

  // 关键：直接使用我们采集的数据，彻底绕过官方任何复制按钮 / 详情抽屉流程（零卡顿）
  navigator.clipboard.writeText(item.prompt).then(() => {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 bg-emerald-600 text-white px-5 py-2 rounded-3xl text-sm shadow-xl flex items-center gap-2 z-[99999]';
    toast.innerHTML = \`✅ 已复制提示词 <span class="opacity-75">(\${item.prompt.length} 字)</span>\`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 1600);
  }).catch(() => {
    // 兜底
    const ta = document.createElement('textarea');
    ta.value = item.prompt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    alert('已复制（兼容模式）');
  });
}

function copyImageUrl(localIdx, e) {
  e?.stopImmediatePropagation?.();
  const item = filtered[localIdx];
  const url = item.image_high || item.image_url;
  if (!url) return alert('无图片链接');
  navigator.clipboard.writeText(url).then(() => {
    const t = document.createElement('div');
    t.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 bg-violet-600 px-4 py-1.5 rounded-3xl text-sm';
    t.textContent = '图片链接已复制';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1200);
  });
}

function showLarge(localIdx, e) {
  e?.stopImmediatePropagation?.();
  const item = filtered[localIdx];
  const url = item.image_high || item.image_url;
  if (!url) return;

  // 大图模式 = 专门用来放大仔细观看 / 检查细节
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/95 z-[999999] flex items-center justify-center p-6';
  overlay.style.transition = 'opacity .2s ease';
  overlay.style.opacity = '0';

  overlay.innerHTML = \`
    <div style="max-width:98vw; max-height:96vh; display:flex; flex-direction:column; align-items:center;">
      <div style="position:relative;">
        <img src="\${url}" style="max-width:96vw; max-height:82vh; object-fit:contain; box-shadow:0 30px 70px -20px rgb(0 0 0 / 0.9); border-radius:6px;" />
      </div>

      <div style="margin-top:16px; max-width:820px; width:100%; text-align:center;">
        <div style="display:flex; gap:10px; justify-content:center; margin-bottom:10px;">
          <button onclick="this.closest('.fixed').remove()"
                  style="padding:8px 22px; background:#1f2937; color:#e2e8f0; border:none; border-radius:999px; font-size:13px; cursor:pointer;">
            关闭
          </button>
          <button onclick="navigator.clipboard.writeText('\${url.replace(/'/g, "\\'")}'); this.textContent='已复制原图链接'"
                  style="padding:8px 18px; background:#4c1d95; color:white; border:none; border-radius:999px; font-size:13px; cursor:pointer;">
            复制高清链接
          </button>
        </div>
        <div style="color:#64748b; font-size:12px; line-height:1.5; max-height:4.2em; overflow:hidden; text-align:left; padding:0 12px;">
          \${escapeHtml(item.prompt)}
        </div>
      </div>
    </div>
  \`;

  // 更自然的进入动画
  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
  });

  // 关闭逻辑
  overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };

  // 键盘操作（左右切换 + Esc），让大图查看感觉更像人类在认真翻看
  const handleKey = (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', handleKey);
    }
    // 简单支持左右（后续可扩展成真正的画廊切换）
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // 当前版本先保留提示，未来可以做真正的前后切换
      const hint = document.createElement('div');
      hint.style.cssText = 'position:absolute;bottom:30px;left:50%;transform:translateX(-50%);background:#1e2937;color:#64748b;padding:4px 12px;border-radius:999px;font-size:12px;';
      hint.textContent = '提示：左右键切换功能后续版本会加入';
      overlay.appendChild(hint);
      setTimeout(() => hint.remove(), 1600);
    }
  };
  document.addEventListener('keydown', handleKey, { once: true });
}

function copyAllFiltered() {
  const text = filtered.map(it => it.prompt).filter(Boolean).join('\\n\\n---\\n\\n');
  navigator.clipboard.writeText(text).then(() => {
    const t = document.createElement('div');
    t.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-6 py-2.5 rounded-3xl shadow-xl text-sm';
    t.textContent = \`已复制 \${filtered.length} 条提示词\`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  });
}

function exportFiltered(fmt) {
  const d = new Date().toISOString().slice(0,10);
  let content, name, type = 'text/plain';
  if (fmt === 'csv') {
    const headers = ['work_id','prompt','author','model','image_url','collected_at'];
    const rows = filtered.map(r => headers.map(h => {
      let v = r[h] || ''; if (typeof v === 'string') v = v.replace(/"/g, '""');
      return '"' + v + '"';
    }).join(','));
    content = [headers.join(','), ...rows].join('\\n');
    name = 'jimeng_gallery_' + d + '.csv';
    type = 'text/csv';
  } else {
    content = filtered.map(it => JSON.stringify(it)).join('\\n');
    name = 'jimeng_gallery_' + d + '.jsonl';
  }
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 600);
}

function downloadAllImages() {
  const urls = filtered.map(it => it.image_high || it.image_url).filter(Boolean);
  if (!urls.length) return alert('没有图片链接');
  const txt = urls.join('\\n');
  const blob = new Blob([txt], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'jimeng_image_urls_' + new Date().toISOString().slice(0,10) + '.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 600);
}

function populateModelFilter() {
  const sel = document.getElementById('modelFilter');
  const models = [...new Set(DATA.map(d => d.model).filter(Boolean))].sort();
  models.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    sel.appendChild(o);
  });
}

function clearFilters() {
  document.getElementById('search').value = '';
  document.getElementById('modelFilter').value = '';
  document.getElementById('sortBy').value = 'collected_desc';
  filterAndRender();
}

function initGallery() {
  populateModelFilter();
  document.getElementById('sortBy').value = 'collected_desc';

  // 初始化分页大小（顶部 + 底部同步）
  const sizeTop = document.getElementById('pageSizeSelect');
  const sizeBottom = document.getElementById('pageSizeSelectBottom');
  if (sizeTop) sizeTop.value = pageSize;
  if (sizeBottom) sizeBottom.value = pageSize;

  filterAndRender(true);

  // 按 / 聚焦搜索
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement.tagName === 'BODY') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });
}

window.onload = initGallery;
<\/script>
</body>
</html>`;
  }

  function showCollectedModal() {
    if (document.getElementById('jimeng-modal')) return;

    if (!collected.length) {
      alert('还没有采集到数据');
      return;
    }

    const PAGE = 50;
    let page = 0;
    let query = '';

    const modal = document.createElement('div');
    modal.id = 'jimeng-modal';
    modal.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,0.92);z-index:10000001;display:flex;align-items:center;justify-content:center;`;

    function renderPage() {
      const filtered = collected.filter(it => !query || (it.prompt && it.prompt.toLowerCase().includes(query)) || (it.author && it.author.toLowerCase().includes(query)));
      const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
      if (page >= totalPages) page = totalPages - 1;

      const slice = filtered.slice(page * PAGE, (page + 1) * PAGE);

      modal.innerHTML = `
        <div style="background:#0f172a;color:#e2e8f0;width:94%;max-width:980px;max-height:88vh;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 25px 70px -15px rgb(0 0 0 / 0.6);">
          <div style="padding:12px 18px;background:#1e2937;display:flex;align-items:center;gap:12px;border-bottom:1px solid #334155;">
            <div style="font-weight:600;font-size:15px;">已采集（${collected.length} 条）<span style="color:#64748b;font-size:12px;margin-left:8px;">筛选 ${filtered.length}</span></div>
            <input id="jm-search" placeholder="搜索提示词或作者..." style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 12px;border-radius:8px;font-size:13px;" value="${query}">
            <button id="jm-report" style="background:#1e40af;color:white;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;">导出完整交互 HTML 报告</button>
            <button id="jm-close" style="background:#334155;color:#e2e8f0;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;">关闭</button>
          </div>

          <div style="padding:16px 18px;overflow:auto;flex:1;font-size:13.5px;line-height:1.55;">
            ${slice.length ? slice.map((item, i) => `
              <div style="padding:10px 0;border-bottom:1px solid #1e2937;">
                <div style="color:#64748b;font-size:11px;margin-bottom:3px;">#${page*PAGE + i + 1} · ${item.author || '未知'} · ${item.model || ''}</div>
                <div style="white-space:pre-wrap;color:#cbd5e1;">${item.prompt.replace(/</g,'&lt;')}</div>
              </div>
            `).join('') : '<div style="color:#64748b;padding:40px 0;text-align:center;">无匹配</div>'}
          </div>

          <div style="padding:10px 18px;background:#1e2937;border-top:1px solid #334155;display:flex;align-items:center;gap:8px;font-size:13px;">
            <button id="jm-prev" style="padding:4px 10px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;">← 上一页</button>
            <div style="color:#94a3b8;">${page+1} / ${totalPages}</div>
            <button id="jm-next" style="padding:4px 10px;background:#334155;color:#e2e8f0;border:none;border-radius:6px;cursor:pointer;">下一页 →</button>
            <div style="flex:1"></div>
            <button id="jm-copy-page" style="padding:4px 12px;background:#1e40af;color:white;border:none;border-radius:6px;cursor:pointer;">复制本页</button>
          </div>
        </div>
      `;

      // wire events
      const close = () => modal.remove();
      modal.querySelector('#jm-close').onclick = close;
      modal.onclick = e => { if (e.target === modal) close(); };

      const search = modal.querySelector('#jm-search');
      search.oninput = () => { query = search.value.trim().toLowerCase(); page = 0; renderPage(); };

      modal.querySelector('#jm-report').onclick = () => {
        const html = generateSelfContainedHTMLReport(collected);
        const blob = new Blob([html], {type:'text/html'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `jimeng_prompts_report_${new Date().toISOString().slice(0,10)}.html`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 800);
      };

      modal.querySelector('#jm-prev').onclick = () => { if (page > 0) { page--; renderPage(); } };
      modal.querySelector('#jm-next').onclick = () => { const t = Math.ceil(filtered.length / PAGE); if (page < t-1) { page++; renderPage(); } };

      modal.querySelector('#jm-copy-page').onclick = () => {
        const text = slice.map(it => it.prompt).join('\n\n---\n\n');
        navigator.clipboard.writeText(text).then(() => {
          const b = modal.querySelector('#jm-copy-page'); const old = b.textContent;
          b.textContent = '已复制'; setTimeout(() => { b.textContent = old; }, 1400);
        });
      };
    }

    document.body.appendChild(modal);
    renderPage();
  }

  // ==================== 面板更新 / 创建（Phase 1 已完全替换为 Shadow 系统） ====================
  // 兼容 shim：旧代码调用 updatePanel() 仍能工作
  function updatePanel() {
    updateShadowPanel();
  }

  // 旧 createPanel / tryCreatePanel 完全移除，由 Shadow + ensurePanelWithDefense 接管
  function tryCreatePanel() {
    ensurePanelWithDefense();
  }

  // ==================== 初始化（Phase 1 Shadow + 多层防御 已激活） ====================
  function init() {
    loadData();

    // Phase 1 硬化注入系统（Shadow + 自适应底部 + 5 层哨兵）
    ensurePanelWithDefense();
    startMultiLayerDefense();

    // 自动恢复上次中断的同步队列：刷新页面/断网/本地 API 重启后都能续传
    setTimeout(resumePendingSync, 1200);

    console.log('%c[即梦提示词收集器] 脚本已加载 v1.3.1-resumable-sync-db-reconcile（先校准 MySQL，避免旧数据重复上传）', 'color:#22c55e');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('load', () => setTimeout(ensurePanelWithDefense, 2000));

})();