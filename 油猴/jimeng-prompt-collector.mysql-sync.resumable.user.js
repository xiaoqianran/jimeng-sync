// ==UserScript==
// @name         即梦收集器 · 本地画廊
// @namespace    https://github.com/xiaoqianran/jimeng-sync
// @version      3.1.0
// @description  发现页持续采集文生图，写入本机收集台；不点停止就不会中断。
// @match        https://jimeng.jianying.com/*
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        window.onurlchange
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const HELPER = 'http://127.0.0.1:3001';
  const SEEN_KEY = 'jc_seen_v5';
  const QUEUE_KEY = 'jc_queue_v5';
  const RUN_KEY = 'jc_continuous_v1';

  const capturedLists = [];
  const seen = new Set(loadJson(SEEN_KEY, []));
  let queue = loadJson(QUEUE_KEY, []);
  let running = false;
  let pumping = false;
  let helperOk = false;
  let sessionAdded = 0;
  let runStart = 0;
  let addedAt = [];
  let lastMsg = '等待助手';
  let host = null;
  let root = null;

  hookNetworkNow();

  function loadJson(key, fallback) {
    try {
      const raw = GM_getValue(key, '');
      const val = raw ? JSON.parse(raw) : fallback;
      return val || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try { GM_setValue(key, JSON.stringify(val)); } catch (_) {}
  }

  function isExploreUrl(url) {
    return String(url || '').indexOf('/mweb/v1/get_explore') !== -1;
  }

  function takeExplorePayload(json) {
    const list = json && json.data && json.data.item_list;
    if (Array.isArray(list) && list.length) capturedLists.push(list);
  }

  function hookNetworkNow() {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (!win || !win.fetch || !win.XMLHttpRequest) return;

    const origFetch = win.fetch;
    win.fetch = function () {
      const req = arguments[0];
      const url = typeof req === 'string' ? req : (req && req.url);
      const pending = origFetch.apply(this, arguments);
      if (isExploreUrl(url)) {
        pending.then(function (res) {
          return res.clone().json();
        }).then(takeExplorePayload).catch(function () {});
      }
      return pending;
    };

    const origOpen = win.XMLHttpRequest.prototype.open;
    const origSend = win.XMLHttpRequest.prototype.send;
    win.XMLHttpRequest.prototype.open = function (method, url) {
      this.__jcExplore = url;
      return origOpen.apply(this, arguments);
    };
    win.XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', function () {
        if (!isExploreUrl(this.__jcExplore)) return;
        try { takeExplorePayload(JSON.parse(this.responseText)); } catch (_) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  function toWork(item) {
    if (!item || !item.common_attr || !item.common_attr.id) return null;
    const params = item.aigc_image_params && item.aigc_image_params.text2image_params;
    const prompt = params && params.prompt;
    if (!prompt || String(prompt).trim().length < 8) return null;
    const cover = item.common_attr.cover_url || '';
    if (/byteeffect|ies\.fe\.effect/i.test(cover)) return null;
    const map = item.common_attr.cover_url_map || {};
    const model = params.model_name
      || (params.model_config && params.model_config.model_name)
      || '';
    return {
      work_id: String(item.common_attr.id),
      prompt: String(prompt).trim(),
      author: (item.author && item.author.name) || '',
      model: model,
      create_time: item.common_attr.create_time || null,
      collected_at: new Date().toISOString(),
      image_url: map['720'] || map['1080'] || map['480'] || cover,
      image_high: map['2048'] || map['1080'] || cover,
      aspect_ratio: item.common_attr.aspect_ratio == null ? null : String(item.common_attr.aspect_ratio),
    };
  }

  function harvest() {
    let added = 0;
    const fresh = [];
    while (capturedLists.length) {
      const list = capturedLists.shift() || [];
      for (let i = 0; i < list.length; i++) {
        const rec = toWork(list[i]);
        if (!rec || seen.has(rec.work_id)) continue;
        seen.add(rec.work_id);
        queue.push(rec);
        fresh.push(rec);
        added++;
        sessionAdded++;
      }
    }
    if (added) {
      const now = Date.now();
      for (let i = 0; i < added; i++) addedAt.push(now);
      addedAt = addedAt.filter(function (t) { return now - t < 120000; });
      saveJson(SEEN_KEY, Array.from(seen).slice(-20000));
      saveJson(QUEUE_KEY, queue);
      lastMsg = '持续采集中 · 待写入 ' + queue.length;
      paint();
      pump();
    }
    return added;
  }

  function speedText() {
    const now = Date.now();
    const lastMin = addedAt.filter(function (t) { return now - t < 60000; }).length;
    const elapsed = runStart ? (now - runStart) / 60000 : 0;
    const avg = elapsed > 0.05 ? Math.round(sessionAdded / elapsed) : lastMin;
    if (!running && !sessionAdded) return '速度会在开始后显示';
    return '本轮 ' + sessionAdded + ' 张 · 近1分钟 ' + lastMin + ' 张 · 均速 ' + avg + ' 张/分钟';
  }

  function gm(method, path, body) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: HELPER + path,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 20000,
        onload: function (res) {
          let json = {};
          try { json = JSON.parse(res.responseText || '{}'); } catch (_) {}
          if (res.status >= 200 && res.status < 300) resolve(json);
          else reject(new Error('HTTP ' + res.status));
        },
        onerror: function () { reject(new Error('助手未连接')); },
        ontimeout: function () { reject(new Error('助手超时')); },
      });
    });
  }

  async function ping() {
    try {
      const res = await gm('GET', '/v1/health');
      helperOk = !!(res && res.ok);
      if (helperOk && res.active != null) {
        lastMsg = helperOk ? ('助手在线 · 库内 ' + (res.active || 0)) : '助手未启动';
      } else {
        lastMsg = helperOk ? '助手在线' : '助手未启动';
      }
    } catch (_) {
      helperOk = false;
      lastMsg = '请先打开 JimengSync.exe';
    }
    paint();
    return helperOk;
  }

  async function pump() {
    if (pumping) return;
    if (!queue.length) return;
    pumping = true;
    if (!(await ping())) {
      pumping = false;
      return;
    }
    while (queue.length) {
      const batch = queue.slice(0, 40);
      try {
        const res = await gm('POST', '/v1/ingest', { items: batch });
        queue = queue.slice(batch.length);
        saveJson(QUEUE_KEY, queue);
        lastMsg = '已写入本地 · 库内 ' + (res.active != null ? res.active : '?') + ' · 队列 ' + queue.length;
        paint();
      } catch (err) {
        lastMsg = '写入失败：' + (err.message || err);
        paint();
        setTimeout(pump, 4000);
        break;
      }
    }
    pumping = false;
  }

  function findScroller() {
    const masonry = document.querySelector('.masonry-layout');
    if (masonry) {
      const near = masonry.closest('[class*="scroll-container"]');
      if (near) return near;
    }
    const nodes = document.querySelectorAll('[class*="scroll-container"]');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].scrollHeight > nodes[i].clientHeight + 80) return nodes[i];
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function humanScroll(box) {
    const step = Math.floor(box.clientHeight * (0.5 + Math.random() * 0.28));
    const slices = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < slices; i++) {
      box.scrollTop += Math.floor(step / slices);
      await sleep(30 + Math.random() * 50);
    }
    if (Math.random() < 0.04) {
      await sleep(80);
      box.scrollTop -= Math.floor(step * 0.1);
    }
    let wait = 640 + (Math.random() - 0.5) * 420;
    if (Math.random() < 0.05) wait += 500 + Math.random() * 400;
    await sleep(Math.max(340, Math.min(1200, wait)));
  }

  async function start() {
    if (running) {
      running = false;
      GM_setValue(RUN_KEY, false);
      lastMsg = '已停止 · 本轮 ' + sessionAdded + ' 张';
      paint();
      return;
    }
    let box = findScroller();
    if (!box) {
      lastMsg = '未找到作品流，稍后自动再试';
      paint();
      GM_setValue(RUN_KEY, true);
      setTimeout(function () { if (!running && GM_getValue(RUN_KEY, false)) start(); }, 2000);
      return;
    }
    running = true;
    GM_setValue(RUN_KEY, true);
    sessionAdded = 0;
    addedAt = [];
    runStart = Date.now();
    lastMsg = '持续采集中';
    paint();
    await ping();
    harvest();
    let empty = 0;
    while (running) {
      if (document.hidden) {
        await sleep(800);
        harvest();
        continue;
      }
      box = findScroller() || box;
      await humanScroll(box);
      const n = harvest();
      if (n) {
        empty = 0;
      } else {
        empty++;
        if (empty === 6) {
          lastMsg = '暂时没有新图，继续往下探';
          paint();
          await sleep(1800 + Math.random() * 1200);
        } else if (empty >= 14) {
          lastMsg = '可能到流末尾，歇一下再继续';
          paint();
          await sleep(6000 + Math.random() * 4000);
          empty = 8;
        }
      }
      paint();
    }
    lastMsg = '已停止 · 本轮 ' + sessionAdded + ' 张';
    paint();
    pump();
  }

  function css() {
    return ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,sans-serif}' +
      '.fab{width:46px;height:46px;border-radius:99px;background:#12121a;border:1px solid #3a3a46;color:#eee;display:grid;place-items:center;cursor:pointer;box-shadow:0 8px 24px #0008}' +
      '.panel{width:250px;background:#12121a;color:#eee;border:1px solid #333;border-radius:14px;overflow:hidden;box-shadow:0 12px 32px #0007}' +
      '.hd{padding:8px 10px;background:#1b1b24;font-size:12px;display:flex;justify-content:space-between;cursor:move}' +
      '.bd{padding:10px}' +
      '.msg{font-size:11px;color:#aaa;min-height:18px;margin-bottom:4px}' +
      '.spd{font-size:11px;color:#7ec8c3;min-height:18px;margin-bottom:8px;line-height:1.4}' +
      'button{border:0;border-radius:8px;padding:6px 8px;cursor:pointer;background:#2a2a36;color:#eee;font-size:12px}' +
      '.go{background:#1b3d3a;color:#d7f3f0}' +
      '.row{display:flex;gap:6px;flex-wrap:wrap}';
  }

  function html() {
    if (!GM_getValue('jc_open', true)) {
      return '<div class="fab" id="fab">即</div>';
    }
    return '<div class="panel">' +
      '<div class="hd" id="drag"><span>即梦收集器 3.0</span><button id="min">_</button></div>' +
      '<div class="bd">' +
      '<div class="msg" id="msg"></div>' +
      '<div class="spd" id="spd"></div>' +
      '<div class="row">' +
      '<button class="go" id="run">持续采集</button>' +
      '<button id="gallery">打开画廊</button>' +
      '</div></div></div>';
  }

  function paint() {
    if (!root) return;
    const msg = root.querySelector('#msg');
    const spd = root.querySelector('#spd');
    const run = root.querySelector('#run');
    if (msg) msg.textContent = lastMsg;
    if (spd) spd.textContent = speedText();
    if (run) run.textContent = running ? '停止' : '持续采集';
  }

  function mount() {
    const onHome = location.pathname.indexOf('/ai-tool/home') !== -1 || document.querySelector('.masonry-layout');
    if (!onHome) {
      if (host) { host.remove(); host = null; root = null; }
      return;
    }
    if (host && host.isConnected && root) {
      paint();
      return;
    }
    if (host) host.remove();
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:120px;';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css();
    root.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = html();
    root.appendChild(wrap);
    document.documentElement.appendChild(host);
    bind();
    paint();
    drag(host);
  }

  function bind() {
    const fab = root.querySelector('#fab');
    if (fab) fab.onclick = function () { GM_setValue('jc_open', true); remount(); };
    const min = root.querySelector('#min');
    if (min) min.onclick = function () { GM_setValue('jc_open', false); remount(); };
    const run = root.querySelector('#run');
    if (run) run.onclick = start;
    const gal = root.querySelector('#gallery');
    if (gal) gal.onclick = function () { window.open(HELPER + '/', '_blank'); };
  }

  function remount() {
    if (host) host.remove();
    host = null;
    root = null;
    mount();
  }

  function drag(el) {
    let ox = 0, oy = 0, on = false;
    const handle = root && root.querySelector('#drag');
    if (!handle) return;
    handle.addEventListener('mousedown', function (e) {
      on = true;
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!on) return;
      el.style.left = (e.clientX - ox) + 'px';
      el.style.right = 'auto';
      el.style.top = (e.clientY - oy) + 'px';
      el.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', function () { on = false; });
  }

  function boot() {
    mount();
    ping().then(function () {
      pump();
      if (GM_getValue(RUN_KEY, false) && !running) start();
    });
    setInterval(mount, 2500);
    setInterval(function () { if (queue.length) pump(); }, 8000);
    setInterval(function () { if (running) paint(); }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.addEventListener('load', function () { setTimeout(mount, 800); });
})();
