/* GitHub Gist 云同步（可选）。
 * 静态站点没有服务器，这是最轻的跨设备方案：浏览器直连 GitHub REST API。
 * 只同步学习数据（进度/笔记/复盘），绝不上传任何 API Key。
 */
(function () {
  "use strict";

  const STORE = "algo-roadmap.sync.v1";   // { token, gistId, auto }
  const FILE = "algo-roadmap-progress.json";
  const API = "https://api.github.com";

  let cfg = { token: "", gistId: "", auto: false };
  let syncing = false;      // 防止「拉取后写回」触发上传
  let timer = null;
  let lastError = "";
  let remoteInfo = null;    // { updatedAt, htmlUrl, when }
  let localNote = "";

  const $ = (s) => document.querySelector(s);

  /* ---------------------------------------------------------- 配置 */
  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw) || {});
    } catch (e) { /* 忽略 */ }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
  }
  const enabled = () => !!(cfg.token && cfg.gistId);

  /* ---------------------------------------------------------- API */
  function headers() {
    return {
      Authorization: "Bearer " + cfg.token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async function api(path, options) {
    let res;
    try {
      res = await fetch(API + path, Object.assign({ headers: headers() }, options));
    } catch (e) {
      throw new Error("网络不可达（GitHub API 可能被网络环境拦截）");
    }
    if (res.status === 401) throw new Error("Token 无效或已过期");
    if (res.status === 404) throw new Error("Gist 不存在（ID 写错了？或被删除了）");
    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      if (/rate limit/i.test(body)) throw new Error("触发 GitHub 频率限制，稍后再试");
      throw new Error("权限不足：Token 需要勾选 Gists 的读写权限");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("HTTP " + res.status + " " + body.slice(0, 120));
    }
    return res.json();
  }

  async function upload(manual) {
    // 只要求 token：首次上传时 gistId 为空，需要走「创建」分支
    if (!cfg.token) return false;
    if (syncing) return false;
    const S = window.__getState ? window.__getState() : null;
    if (!S) return false;

    const payload = {
      app: "algo-roadmap",
      version: 1,
      updatedAt: S.updatedAt || new Date().toISOString(),
      data: S,
    };
    const content = JSON.stringify(payload, null, 1);

    try {
      if (!cfg.gistId) {
        const created = await api("/gists", {
          method: "POST",
          body: JSON.stringify({
            description: "机试训练路线图 · 学习进度（自动同步）",
            public: false,
            files: { [FILE]: { content } },
          }),
        });
        cfg.gistId = created.id;
        save();
        remoteInfo = { updatedAt: payload.updatedAt, htmlUrl: created.html_url };
        if (manual) window.toast("已创建 Gist 并上传");
      } else {
        const updated = await api("/gists/" + cfg.gistId, {
          method: "PATCH",
          body: JSON.stringify({ files: { [FILE]: { content } } }),
        });
        remoteInfo = { updatedAt: payload.updatedAt, htmlUrl: updated.html_url };
        if (manual) window.toast("已上传到云端");
      }
      lastError = "";
      render();
      return true;
    } catch (e) {
      lastError = e.message;
      if (manual) window.toast("上传失败：" + e.message);
      render();
      return false;
    }
  }

  async function fetchRemote() {
    if (!enabled()) return null;
    const gist = await api("/gists/" + cfg.gistId);
    const file = gist.files && gist.files[FILE];
    if (!file) return { empty: true, htmlUrl: gist.html_url };
    let content = file.content;
    if (file.truncated && file.raw_url) {
      content = await fetch(file.raw_url).then((r) => r.text());
    }
    const payload = JSON.parse(content);
    return { data: payload.data, updatedAt: payload.updatedAt, htmlUrl: gist.html_url };
  }

  async function download(manual) {
    if (!enabled()) return false;
    try {
      const remote = await fetchRemote();
      if (!remote || remote.empty) throw new Error("云端还没有数据，先点一次「立即上传」");
      syncing = true;
      if (window.__setState) window.__setState(remote.data);
      syncing = false;
      lastError = "";
      remoteInfo = { updatedAt: remote.updatedAt, htmlUrl: remote.htmlUrl };
      render();
      if (window.__rerender) window.__rerender();
      if (manual) window.toast("已从云端恢复");
      return true;
    } catch (e) {
      syncing = false;
      lastError = e.message;
      if (manual) window.toast("恢复失败：" + e.message);
      render();
      return false;
    }
  }

  /* ---------------------------------------------------------- 自动同步 */
  function onLocalChange() {
    if (!enabled() || !cfg.auto || syncing) return;
    clearTimeout(timer);
    timer = setTimeout(() => { upload(false); }, 2500);
  }

  async function startupCheck() {
    if (!enabled()) return;
    try {
      const remote = await fetchRemote();
      if (!remote || !remote.updatedAt) return;
      const S = window.__getState ? window.__getState() : null;
      const localAt = (S && S.updatedAt) || "";
      remoteInfo = { updatedAt: remote.updatedAt, htmlUrl: remote.htmlUrl };
      if (remote.updatedAt > localAt) {
        localNote = "云端记录比本机新（" + remote.updatedAt.slice(0, 16).replace("T", " ") + "）";
      }
      render();
    } catch (e) {
      lastError = e.message;
      render();
    }
  }

  /* ---------------------------------------------------------- 视图 */
  function render() {
    const box = $("#sync-panel");
    if (!box) return;
    const on = enabled();
    const status = on
      ? `<span class="tag ok">已连接</span> <span class="small muted">Gist <code>${esc(cfg.gistId.slice(0, 8))}…</code></span>`
      : `<span class="tag">未连接</span> <span class="small muted">进度只在这台设备的浏览器里</span>`;

    box.innerHTML = `
      <div class="card">
        <div class="row">
          <h2 style="flex:1">云同步（可选 · GitHub Gist）</h2>
          ${status}
        </div>
        <p class="lead">跨设备同步进度与笔记。浏览器直连 GitHub API，不需要服务器；
          数据存进你账号下的 <b>secret gist</b>。</p>

        <label class="fl">GitHub Token（fine-grained，只勾 Gists 读写）</label>
        <input type="password" id="sync-token" placeholder="${on ? "已保存，留空则不修改" : "github_pat_..."}">

        <label class="fl">Gist ID（第一次留空，会自动创建）</label>
        <input type="text" id="sync-gist" value="${esc(cfg.gistId || "")}" placeholder="留空 = 新建一个">

        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="sync-save">保存并上传</button>
          <button class="btn" id="sync-pull" ${on ? "" : "disabled"}>从云端恢复</button>
          ${on ? `<button class="btn ghost" id="sync-off">断开</button>` : ""}
          <label class="check small"><input type="checkbox" id="sync-auto" ${cfg.auto ? "checked" : ""} ${on ? "" : "disabled"}> 自动同步</label>
        </div>

        ${remoteInfo && remoteInfo.htmlUrl ? `<p class="small" style="margin-top:10px">
          云端最新：<a href="${esc(remoteInfo.htmlUrl)}" target="_blank" rel="noopener">在 GitHub 查看</a>
          · ${esc(String(remoteInfo.updatedAt || "").slice(0, 16).replace("T", " "))}</p>` : ""}
        ${localNote ? `<p class="small" style="color:var(--warn)">${esc(localNote)}——点「从云端恢复」会用云端覆盖本机。</p>` : ""}
        ${lastError ? `<p class="small" style="color:var(--bad)">最近错误：${esc(lastError)}</p>` : ""}

        <p class="small muted" style="margin-top:10px">
          注意：secret gist 只是"不被公开列出"，<b>拿到链接的人仍可读取</b>；Token 存在本机浏览器，
          公用电脑不要开启。API Key 不会上传。
        </p>
      </div>`;
    bind();
  }

  function bind() {
    const s = $("#sync-save");
    if (!s) return;
    s.onclick = async () => {
      const t = $("#sync-token").value.trim();
      const g = $("#sync-gist").value.trim();
      if (t) cfg.token = t;
      if (g) cfg.gistId = g;
      if (!cfg.token) { window.toast("请先填 Token"); return; }
      save();
      const ok = await upload(true);
      if (ok) startupCheck();
    };
    const pull = $("#sync-pull");
    if (pull) pull.onclick = () => download(true);
    const off = $("#sync-off");
    if (off) off.onclick = () => {
      if (!confirm("断开云同步？本机进度会保留，只是不再上传。")) return;
      cfg = { token: "", gistId: "", auto: false };
      save();
      remoteInfo = null; localNote = ""; lastError = "";
      render();
      window.toast("已断开云同步");
    };
    const auto = $("#sync-auto");
    if (auto) auto.onchange = () => { cfg.auto = auto.checked; save(); };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------------------------------------------------- 对外 */
  window.ProgressSync = {
    render,
    onLocalChange,
    startupCheck,
    isEnabled: enabled,
    isSyncing: () => syncing,
  };

  load();
  // 首次渲染；startupCheck 由 app.js 在状态加载完成后调用（避免读到未初始化的 S）
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();