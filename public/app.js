const state = {
  q: "",
  favorite: false,
  includeDeleted: false,
  offset: 0,
  limit: 48,
  total: 0,
  items: [],
  current: null,
  currentIndex: -1,
  pendingNew: 0,
};

function $(id) {
  return document.getElementById(id);
}

function imgSrc(item, high) {
  if (item && item.has_local && item.work_id) {
    return "/v1/media/" + encodeURIComponent(item.work_id);
  }
  const raw = high ? (item.image_high || item.image_url) : (item.image_url || item.image_high);
  if (!raw) return "";
  return "/v1/image?url=" + encodeURIComponent(raw);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || res.statusText);
  return json;
}

function toast(text) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pages() {
  return Math.max(1, Math.ceil((state.total || 0) / state.limit));
}

function pageNo() {
  return Math.floor(state.offset / state.limit) + 1;
}

function renderStats(s) {
  $("statActive").textContent = s.active ?? 0;
  if (s.upserted != null) $("statLive").textContent = s.upserted;
  $("statDirty").textContent = s.dirty ?? 0;
  $("statFav").textContent = s.favorites ?? 0;
  if (s.dbPath) $("dbPath").textContent = s.dbPath;
  if (s.sync) {
    $("syncMsg").textContent = s.sync.lastMessage || "";
    $("barSub").textContent = s.sync.configured ? "本地 + 远程同步" : "仅本地备份";
    $("liveDot").className = "dot " + (s.sync.lastOk === false ? "warn" : "on");
  }
  $("restoreBanner").style.display = s.restored ? "block" : "none";
}

function renderChips() {
  $("chipAll").classList.toggle("on", !state.favorite && !state.includeDeleted);
  $("btnFavOnly").classList.toggle("on", state.favorite);
  $("btnShowDeleted").classList.toggle("on", state.includeDeleted);
}

function renderGrid() {
  const grid = $("grid");
  grid.innerHTML = "";
  $("empty").style.display = state.items.length ? "none" : "block";
  const info = state.total ? `共 ${state.total} 条 · 第 ${pageNo()} / ${pages()} 页` : "尚未入库";
  $("pageInfo").textContent = info;
  $("pagerText").textContent = `${pageNo()} / ${pages()}`;
  $("pagerText2").textContent = `${pageNo()} / ${pages()}`;

  for (const [index, item] of state.items.entries()) {
    const card = document.createElement("article");
    card.className = "card";
    const src = imgSrc(item);
    card.innerHTML = `
      ${src ? `<img src="${src}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ""}
      <div class="acts">
        <button data-copy>复制</button>
        <button data-fav>${item.favorite ? "已收藏" : "收藏"}</button>
      </div>
      <div class="cap">
        <div class="who">${escapeHtml(item.author || "未知作者")} · ${escapeHtml(item.model || "")}${item.favorite ? " · ★" : ""}</div>
        <div class="txt">${escapeHtml(item.prompt || "")}</div>
      </div>
    `;
    card.onclick = () => openLightbox(index);
    card.querySelector("[data-copy]").onclick = async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(item.prompt || "");
      toast("已复制提示词");
    };
    card.querySelector("[data-fav]").onclick = async (e) => {
      e.stopPropagation();
      await toggleFav(item);
    };
    grid.appendChild(card);
  }
}

async function loadList() {
  const params = new URLSearchParams({
    q: state.q,
    limit: String(state.limit),
    offset: String(state.offset),
    favorite: state.favorite ? "1" : "0",
    include_deleted: state.includeDeleted ? "1" : "0",
  });
  const data = await api("/v1/items?" + params);
  state.total = data.total || 0;
  state.items = data.items || [];
  renderGrid();
}

async function refreshStats() {
  const s = await api("/v1/stats");
  renderStats(s);
  return s;
}

async function reload() {
  renderChips();
  await Promise.all([refreshStats(), loadList()]);
}

function openLightbox(index) {
  const item = state.items[index];
  if (!item) return;
  state.currentIndex = index;
  state.current = item;
  $("lightbox").hidden = false;
  $("lbImg").src = imgSrc(item, true);
  $("lbMeta").textContent = `${item.author || "未知"} · ${item.model || ""} · ${item.work_id}`;
  $("lbPrompt").textContent = item.prompt || "";
  $("lbNotes").value = item.notes || "";
  $("lbTags").value = (item.tags || []).join(", ");
  $("lbFav").textContent = item.favorite ? "取消收藏" : "收藏";
}

function closeLightbox() {
  $("lightbox").hidden = true;
  state.current = null;
  state.currentIndex = -1;
}

function stepLightbox(delta) {
  const next = state.currentIndex + delta;
  if (next < 0) {
    if (state.offset === 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    loadList().then(() => openLightbox(state.items.length - 1));
    return;
  }
  if (next >= state.items.length) {
    if (state.offset + state.limit >= state.total) return;
    state.offset += state.limit;
    loadList().then(() => openLightbox(0));
    return;
  }
  openLightbox(next);
}

async function toggleFav(item) {
  const res = await api("/local/prompts/" + encodeURIComponent(item.work_id), {
    method: "PATCH",
    body: JSON.stringify({ favorite: !item.favorite }),
  });
  Object.assign(item, res.item || {});
  if (state.current && state.current.work_id === item.work_id) {
    state.current = item;
    $("lbFav").textContent = item.favorite ? "取消收藏" : "收藏";
  }
  await reload();
}

async function loadConfig() {
  const c = await api("/local/config");
  $("deviceName").value = c.deviceName || "";
  $("remoteUrl").value = c.remoteUrl || "";
  $("autoSyncMs").value = c.autoSyncMs || 30000;
  $("deviceId").textContent = "device_id: " + c.deviceId;
}

function connectEvents() {
  const es = new EventSource("/v1/events");
  es.addEventListener("hello", () => { $("liveDot").className = "dot on"; });
  es.addEventListener("ingest", (ev) => {
    const data = JSON.parse(ev.data || "{}");
    renderStats(data);
    const n = data.upserted || 0;
    if (!n) return;
    toast(`刚刚入库 ${n} 条`);
    const onLatest = state.offset === 0 && !state.q && !state.favorite && !state.includeDeleted;
    if (onLatest) loadList();
    else {
      state.pendingNew += n;
      $("newBanner").hidden = false;
      $("newBanner").firstChild.textContent = `有 ${state.pendingNew} 条新图不在当前页。`;
    }
  });
  es.addEventListener("update", () => reload());
  es.addEventListener("sync", (ev) => {
    const data = JSON.parse(ev.data || "{}");
    renderStats(data);
    toast(data.lastMessage || "同步完成");
  });
  es.onerror = () => { $("liveDot").className = "dot warn"; };
}

let searchTimer = null;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = $("q").value.trim();
    state.offset = 0;
    loadList();
  }, 280);
});

$("chipAll").onclick = () => {
  state.favorite = false;
  state.includeDeleted = false;
  state.offset = 0;
  reload();
};
$("btnFavOnly").onclick = () => {
  state.favorite = !state.favorite;
  if (state.favorite) state.includeDeleted = false;
  state.offset = 0;
  reload();
};
$("btnShowDeleted").onclick = () => {
  state.includeDeleted = !state.includeDeleted;
  if (state.includeDeleted) state.favorite = false;
  state.offset = 0;
  reload();
};
$("pageSize").onchange = () => {
  state.limit = Number($("pageSize").value || 48);
  state.offset = 0;
  loadList();
};

function goPrev() {
  state.offset = Math.max(0, state.offset - state.limit);
  loadList();
}
function goNext() {
  if (state.offset + state.limit < state.total) state.offset += state.limit;
  loadList();
}
$("btnPrev").onclick = goPrev;
$("btnNext").onclick = goNext;
$("btnPrev2").onclick = goPrev;
$("btnNext2").onclick = goNext;

$("btnJumpNew").onclick = () => {
  state.q = "";
  $("q").value = "";
  state.favorite = false;
  state.includeDeleted = false;
  state.offset = 0;
  state.pendingNew = 0;
  $("newBanner").hidden = true;
  reload();
};

$("btnSync").onclick = async () => {
  const r = await api("/local/sync", { method: "POST" });
  toast(r.lastMessage || "已同步");
  await reload();
};
$("btnSettings").onclick = async () => {
  await loadConfig();
  $("drawer").hidden = false;
};
$("btnCloseDrawer").onclick = () => { $("drawer").hidden = true; };
$("btnSaveCfg").onclick = async () => {
  await api("/local/config", {
    method: "POST",
    body: JSON.stringify({
      deviceName: $("deviceName").value,
      remoteUrl: $("remoteUrl").value,
      remoteToken: $("remoteToken").value,
      autoSyncMs: Number($("autoSyncMs").value || 30000),
    }),
  });
  $("remoteToken").value = "";
  toast("配置已保存");
  $("drawer").hidden = true;
};
$("btnNewDevice").onclick = async () => {
  if (!confirm("把这台电脑标成新设备？下次同步会先拉远程快照。")) return;
  const r = await api("/local/device/reset", { method: "POST" });
  toast(r.message);
  await loadConfig();
};
$("btnTest").onclick = async () => {
  try {
    await api("/local/sync/test", { method: "POST" });
    toast("远程正常");
  } catch (e) {
    toast("远程失败：" + e.message);
  }
};
$("btnExport").onclick = () => { location.href = "/local/export.jsonl"; };
$("btnBackup").onclick = () => { location.href = "/local/backup.db"; };
$("btnCleanJunk").onclick = async () => {
  const preview = await api("/local/cleanup/miscollected");
  if (!preview.count) {
    toast("没有发现误收的配音角色");
    return;
  }
  if (!confirm(`发现 ${preview.count} 条配音/角色素材。确认清理？`)) return;
  const r = await api("/local/cleanup/miscollected", { method: "POST" });
  toast(`已清理 ${r.count} 条`);
  state.offset = 0;
  await reload();
};

$("lbClose").onclick = closeLightbox;
$("lbPrev").onclick = () => stepLightbox(-1);
$("lbNext").onclick = () => stepLightbox(1);
$("lightbox").addEventListener("click", (e) => {
  if (e.target.id === "lightbox") closeLightbox();
});
$("lbCopy").onclick = async () => {
  if (!state.current) return;
  await navigator.clipboard.writeText(state.current.prompt || "");
  toast("已复制提示词");
};
$("lbFav").onclick = async () => {
  if (!state.current) return;
  await toggleFav(state.current);
};
$("lbSave").onclick = async () => {
  if (!state.current) return;
  await api("/local/prompts/" + encodeURIComponent(state.current.work_id), {
    method: "PATCH",
    body: JSON.stringify({ notes: $("lbNotes").value, tags: $("lbTags").value }),
  });
  toast("标注已保存");
  await reload();
};
$("lbDel").onclick = async () => {
  if (!state.current) return;
  if (!confirm("删除后会同步到远程，确认？")) return;
  await api("/local/prompts/" + encodeURIComponent(state.current.work_id), { method: "DELETE" });
  closeLightbox();
  await reload();
};

document.addEventListener("keydown", (e) => {
  if ($("drawer").hidden === false && e.key === "Escape") {
    $("drawer").hidden = true;
    return;
  }
  if ($("lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") stepLightbox(-1);
  if (e.key === "ArrowRight") stepLightbox(1);
  if (e.key === "c" || e.key === "C") $("lbCopy").click();
});

connectEvents();
reload().catch((err) => {
  $("syncMsg").textContent = err.message;
});
