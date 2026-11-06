/* AI 侧栏：流式对话 + 当前题目上下文 + 未配置时的免费兜底。 */
(function () {
  "use strict";

  const STORE_CHAT = "algo-roadmap.chat.v1";
  const STORE_AI = "algo-roadmap.ai.v1";   // 仅静态托管（直连）模式使用

  // 与 serve.py 的预设保持一致；直连模式下前端自己拼 baseUrl
  const PRESETS = {
    deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat",
      note: "按 token 计费，单价低；新账号常赠送试用额度，以官网为准。已确认允许浏览器直连。" },
    zhipu: { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash",
      note: "glm-4-flash 有免费额度政策，以官网为准。" },
    moonshot: { name: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.cn/v1/chat/completions", model: "moonshot-v1-8k",
      note: "长上下文强，按量计费。" },
    siliconflow: { name: "硅基流动 SiliconFlow", baseUrl: "https://api.siliconflow.cn/v1/chat/completions", model: "Qwen/Qwen2.5-7B-Instruct",
      note: "部分小模型免费，以官网为准。" },
    ollama: { name: "本地 Ollama", baseUrl: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:7b",
      note: "完全免费、不联网；需本机已装 Ollama。浏览器直连需设置 OLLAMA_ORIGINS。" },
  };

  const SYSTEM = "你是 C++ 算法竞赛与保研机试教练。用中文回答，直接具体；代码一律 C++17 且可编译，附时间/空间复杂度；"
    + "学生问怎么做时先给关键观察和提示，再给完整解法；不确定的地方直说不确定，不要编造题面；"
    + "并说明这类题的识别信号与易错点。代码块用 ```cpp 包裹。";

  const QUICK = [
    "给我提示，不要直接给答案",
    "为什么我这样做会错？",
    "这题的识别信号是什么",
    "复杂度怎么分析",
  ];

  let state = {
    messages: [],        // {role, content, display, ts}
    pendingCtx: null,    // {label, text}
    status: null,        // /api/status
    busy: false,
    setupOpen: false,
    mode: "proxy",      // proxy = 本地 serve.py；direct = 静态托管直连
    ai: {},             // 直连模式的配置（存在本机浏览器）
  };

  const $ = (s) => document.querySelector(s);

  /* ---------------------------------------------------------- 存储 */
  function load() {
    try {
      const ai = localStorage.getItem(STORE_AI);
      if (ai) state.ai = JSON.parse(ai) || {};
    } catch (e) { state.ai = {}; }
    try {
      const raw = localStorage.getItem(STORE_CHAT);
      if (raw) {
        const d = JSON.parse(raw);
        state.messages = Array.isArray(d.messages) ? d.messages.slice(-80) : [];
      }
    } catch (e) { /* 忽略 */ }
  }
  function save() {
    try {
      localStorage.setItem(STORE_CHAT, JSON.stringify({
        messages: state.messages.slice(-80),
      }));
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------- 渲染工具 */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** 极简 Markdown：先整体转义，再处理代码块/行内代码/加粗/标题/列表。安全（不注入 HTML）。 */
  function mdLite(src) {
    let text = esc(src);
    const blocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });
    text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    text = text.replace(/^#### (.*)$/gm, "<h5>$1</h5>")
               .replace(/^### (.*)$/gm, "<h4>$1</h4>")
               .replace(/^## (.*)$/gm, "<h3>$1</h3>");
    text = text.replace(/^\s*[-*]\s+(.*)$/gm, "<li>$1</li>");
    text = text.replace(/(?:<li>[\s\S]*?<\/li>\s*)+/g, (m) => "<ul>" + m + "</ul>");
    text = text.replace(/\n{2,}/g, "\n\n").replace(/\n/g, "<br>");
    // 还原代码块
    text = text.replace(/\u0000B(\d+)\u0000/g, (m, i) => {
      const b = blocks[Number(i)];
      if (!b) return "";
      return `<div class="code-wrap"><div class="code-bar"><span>${esc(b.lang)}</span>` +
        `<button class="code-copy" data-copy="${i}">复制</button></div>` +
        `<pre><code>${esc(b.code)}</code></pre></div>`;
    });
    return text;
  }

  /* ---------------------------------------------------------- 视图 */
  function renderMessages() {
    const body = $("#chat-body");
    if (state.setupOpen) return renderSetup();

    if (!state.messages.length) {
      body.innerHTML = `
        <div class="chat-empty">
          <div class="ce-emoji">⌘</div>
          <p>遇到不会的，直接问。左侧每个知识点、练习、错题旁边都有「问」按钮，会把上下文一起带过来。</p>
          <div class="chat-hints">
            ${QUICK.map((q) => `<button class="hint-chip" data-quick="${esc(q)}">${esc(q)}</button>`).join("")}
          </div>
        </div>`;
      bindQuick(body);
      return;
    }

    body.innerHTML = state.messages.map((m) => {
      if (m.role === "user") {
        return `<div class="msg user"><div class="bubble">${esc(m.display || m.content).replace(/\n/g, "<br>")}</div></div>`;
      }
      if (m.role === "error") {
        return `<div class="msg error"><div class="bubble">${esc(m.content)}</div></div>`;
      }
      return `<div class="msg ai"><div class="bubble">${mdLite(m.content || "")}</div></div>`;
    }).join("");

    body.querySelectorAll("[data-copy]").forEach((b) => {
      b.onclick = () => {
        const wrap = b.closest(".code-wrap");
        const code = wrap ? wrap.querySelector("code") : null;
        if (code && navigator.clipboard) {
          navigator.clipboard.writeText(code.textContent).then(() => {
            b.textContent = "已复制";
            setTimeout(() => { b.textContent = "复制"; }, 1400);
          });
        }
      };
    });
    bindQuick(body);
    scrollBottom();
  }

  function bindQuick(root) {
    root.querySelectorAll("[data-quick]").forEach((b) => {
      b.onclick = () => {
        const input = $("#chat-input");
        input.value = b.dataset.quick;
        input.focus();
        autoGrow(input);
      };
    });
  }

  function scrollBottom() {
    const body = $("#chat-body");
    if (body) body.scrollTop = body.scrollHeight;
  }

  function renderCtx() {
    const el = $("#chat-ctx");
    if (!state.pendingCtx) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.classList.remove("hidden");
    el.innerHTML = `<span class="ctx-tag">上下文：${esc(state.pendingCtx.label)}</span>
      <button id="ctx-clear" title="移除上下文">×</button>`;
    const c = $("#ctx-clear");
    if (c) c.onclick = () => { state.pendingCtx = null; renderCtx(); };
  }

  function renderSetup() {
    const s = state.status || {};
    const configured = !!s.configured;
    const direct = state.mode === "direct";
    const presets = s.presets || PRESETS;
    const keys = Object.keys(presets).filter((k) => !(direct && k === "mock"));
    const cur = s.provider && keys.includes(s.provider) ? s.provider : keys[0];
    const options = keys.map((k) =>
      `<option value="${esc(k)}" ${cur === k ? "selected" : ""}>${esc(presets[k].name)}</option>`).join("");

    $("#chat-body").innerHTML = `
      <div class="setup-card">
        <h3>${configured ? "模型已就绪" : "配置一个模型"}</h3>
        ${direct
          ? `<p class="small direct-warn">当前是<b>静态托管 / 离线打开</b>模式：Key 存在这台设备的浏览器里
             （不会上传、不进进度备份），建议只在个人电脑使用。想更稳妥就用本地模式运行 <code>python serve.py</code>。</p>`
          : `<p class="small muted">Key 只保存在本机 <code>config.json</code>，不会进浏览器存储，也不会被进度备份带走。</p>`}
        ${configured ? `<p class="small muted">当前：<b>${esc(s.providerName)}</b> / <code>${esc(s.model || "")}</code>
          ${s.keyHint ? "<br>Key " + esc(s.keyHint) : ""}</p>` : ""}

        <label class="fl">服务商</label>
        <select id="ai-provider">${options}</select>
        <p class="small muted" id="ai-note">${esc((presets[cur] || {}).note || "")}</p>

        <label class="fl">API Key</label>
        <input type="password" id="ai-key" placeholder="${configured ? "已保存，留空则不修改" : "sk-..."}">

        <label class="fl">模型（可选，留空用默认）</label>
        <input type="text" id="ai-model" value="${esc(s.model || "")}"
               placeholder="${esc((presets[cur] || {}).model || "")}">

        ${direct ? `<label class="fl">接口地址（一般不用改）</label>
          <input type="text" id="ai-base" value="${esc(s.baseUrl || (presets[cur] || {}).baseUrl || "")}">` : ""}

        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="ai-save">保存并启用</button>
          ${configured ? `<button class="btn ghost" id="ai-clear">清除配置</button>` : ""}
          <span class="spacer"></span>
          <button class="btn tiny ghost" id="ai-back">← 返回对话</button>
        </div>
      </div>

      <div class="setup-card">
        <h3>不想付费？两条免费路径</h3>
        <p class="small"><b>1. 直接用网页版</b>（无需配置，永远免费）</p>
        <p class="small muted">点下面按钮：把当前问题和上下文复制到剪贴板，并打开 DeepSeek 网页，粘贴即可。</p>
        <button class="btn" id="ai-web">复制问题并打开 DeepSeek 网页 ↗</button>
        <p class="small"><b style="display:inline-block;margin-top:12px">2. 本机跑小模型</b>（免费、不联网）</p>
        <p class="small muted">装好 <code>Ollama</code> 并 <code>ollama pull qwen2.5:7b</code>，服务商选「本地 Ollama」，Key 随便填。</p>
      </div>`;

    const prov = $("#ai-provider");
    prov.onchange = () => {
      const p = presets[prov.value] || {};
      $("#ai-note").textContent = p.note || "";
      $("#ai-model").value = p.model || "";
      $("#ai-model").placeholder = p.model || "";
      const base = $("#ai-base");
      if (base) base.value = p.baseUrl || "";
    };
    $("#ai-save").onclick = () => saveConfig(false);   // 注意：直接绑函数会把事件对象当成 clear 参数
    const clear = $("#ai-clear");
    if (clear) clear.onclick = () => saveConfig(true);
    $("#ai-back").onclick = () => { state.setupOpen = false; renderMessages(); };
    const web = $("#ai-web");
    if (web) web.onclick = openWebFallback;
  }

  async function saveConfig(clear) {
    const provider = $("#ai-provider").value;
    const keyInput = $("#ai-key").value.trim();
    const modelInput = $("#ai-model").value.trim();
    const baseInput = $("#ai-base") ? $("#ai-base").value.trim() : "";

    // 静态托管模式：只写本机浏览器
    if (state.mode === "direct") {
      if (clear) {
        state.ai = {};
      } else {
        const preset = PRESETS[provider] || {};
        state.ai = {
          provider,
          apiKey: keyInput || (state.ai && state.ai.apiKey) || "",
          model: modelInput,
          baseUrl: baseInput || preset.baseUrl || "",
        };
      }
      try { localStorage.setItem(STORE_AI, JSON.stringify(state.ai)); } catch (e) { /* 忽略 */ }
      state.status = directStatus();
      state.setupOpen = false;
      renderMessages();
      updateModelBadge();
      toast(clear ? "已清除模型配置" : (state.status.configured ? "已启用：" + state.status.providerName : "已保存，但 Key 为空"));
      return;
    }

    const body = clear
      ? { clear: true }
      : { provider, apiKey: keyInput, model: modelInput };
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      state.status = data;
      state.setupOpen = false;
      renderMessages();
      updateModelBadge();
      toast(clear ? "已清除模型配置" : (data.configured ? "已启用：" + data.providerName + " / " + data.model : "已保存，但 Key 为空"));
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }

  /* ---------------------------------------------------------- 发送 */
  function apiMessages() {
    return state.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async function send() {
    if (state.busy) return;
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    if (!state.status || !state.status.configured) {
      state.setupOpen = true;
      renderMessages();
      toast("先配置一个模型，或用下方的免费网页版路径");
      return;
    }

    const ctx = state.pendingCtx;
    const full = ctx ? `【背景】\n${ctx.text}\n\n【我的问题】\n${text}` : text;
    state.messages.push({ role: "user", content: full, display: text, ts: Date.now() });
    state.pendingCtx = null;
    renderCtx();
    input.value = "";
    autoGrow(input);
    save();
    renderMessages();

    // 占位 assistant 消息用于流式追加
    const msg = { role: "assistant", content: "", ts: Date.now() };
    state.messages.push(msg);
    renderMessages();
    const bubble = () => {
      const nodes = document.querySelectorAll("#chat-body .msg.ai .bubble");
      return nodes[nodes.length - 1];
    };
    const b0 = bubble();
    if (b0) b0.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;

    state.busy = true;
    setBusy(true);
    let acc = "";
    try {
      const history = apiMessages().slice(0, -1);
      let res;
      if (state.mode === "direct") {
        // 浏览器直连：前端自己带 system 与鉴权头
        const ai = state.ai || {};
        const preset = PRESETS[ai.provider] || {};
        const baseUrl = ai.baseUrl || preset.baseUrl;
        const model = ai.model || preset.model;
        if (!ai.apiKey || !baseUrl) throw new Error("尚未配置 API Key");
        res = await fetch(baseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + ai.apiKey },
          body: JSON.stringify({
            model,
            stream: true,
            temperature: 0.3,
            messages: [{ role: "system", content: SYSTEM }].concat(history),
          }),
        });
      } else {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });
      }

      if (!res.ok) {
        let detail = "HTTP " + res.status;
        try {
          const j = await res.json();
          detail = j.error || detail;
          if (j.detail) detail += "：" + String(j.detail).slice(0, 300);
        } catch (e) { /* ignore */ }
        throw new Error(detail);
      }
      if (!res.body) throw new Error("当前浏览器不支持流式读取");

      const reader = res.body.getReader();
      const dec = new TextDecoder("utf-8");
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let j;
            try { j = JSON.parse(payload); } catch (e) { continue; }
            if (j.error) throw new Error(j.error);
            const choice = (j.choices || [])[0] || {};
            const delta = (choice.delta && choice.delta.content) ||
                          (choice.message && choice.message.content) || "";
            if (delta) {
              acc += delta;
              msg.content = acc;
              const b = bubble();
              if (b) b.innerHTML = mdLite(acc);
              scrollBottom();
            }
          }
        }
      }
      if (!acc) throw new Error("模型没有返回内容");
      msg.content = acc;
      save();
      renderMessages();
    } catch (e) {
      // 移除空的占位消息，改为错误提示
      state.messages = state.messages.filter((m) => m !== msg);
      state.messages.push({ role: "error", content: "请求失败：" + e.message, ts: Date.now() });
      save();
      renderMessages();
    } finally {
      state.busy = false;
      setBusy(false);
    }
  }

  function setBusy(on) {
    const btn = $("#chat-send");
    btn.disabled = on;
    btn.textContent = on ? "生成中…" : "发送";
  }

  /* ---------------------------------------------------------- 免费兜底 */
  function openWebFallback() {
    const input = $("#chat-input");
    const text = input.value.trim() || "我在准备 C++ 机试，遇到一个问题：";
    const ctx = state.pendingCtx;
    const prompt = ctx ? `【背景】\n${ctx.text}\n\n【我的问题】\n${text}` : text;
    const done = () => {
      window.open("https://chat.deepseek.com/", "_blank", "noopener");
      toast("问题已复制，在网页版里 Ctrl+V 粘贴即可");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prompt).then(done).catch(done);
    } else {
      done();
    }
  }

  /* ---------------------------------------------------------- 对外接口 */
  function ask(ctx, draft) {
    open();
    state.pendingCtx = ctx || null;
    state.setupOpen = false;
    renderCtx();
    renderMessages();
    const input = $("#chat-input");
    input.value = draft || "";
    input.focus();
    autoGrow(input);
  }

  function open() {
    document.body.classList.add("chat-open");
    $("#chat").classList.remove("hidden");
    const fab = $("#chat-fab");
    if (fab) fab.classList.add("hidden");
    setTimeout(scrollBottom, 50);
  }

  function close() {
    document.body.classList.remove("chat-open");
    $("#chat").classList.add("hidden");
    const fab = $("#chat-fab");
    if (fab) fab.classList.remove("hidden");
  }

  function toggle() {
    if (document.body.classList.contains("chat-open")) close();
    else open();
  }

  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = Math.min(160, el.scrollHeight) + "px";
  }

  function updateModelBadge() {
    const el = $("#chat-model");
    const s = state.status;
    if (!el) return;
    if (s && s.configured) {
      el.textContent = s.providerName + " · " + (s.model || "");
      el.className = "chat-model ok";
    } else {
      el.textContent = "未配置模型";
      el.className = "chat-model";
    }
  }

  /** 直连模式的 status（不依赖本地服务） */
  function directStatus() {
    const ai = state.ai || {};
    const p = PRESETS[ai.provider] || {};
    const baseUrl = ai.baseUrl || p.baseUrl || "";
    return {
      configured: !!(ai.apiKey && baseUrl),
      provider: ai.provider || "deepseek",
      providerName: p.name || "自定义接口",
      model: ai.model || p.model || "",
      baseUrl,
      keyHint: ai.apiKey ? "已保存（" + ai.apiKey.slice(0, 3) + "…" + ai.apiKey.slice(-4) + "）" : "",
      keySource: "browser",
      presets: PRESETS,
      mode: "direct",
    };
  }

  async function loadStatus() {
    try {
      const res = await fetch("/api/status", { cache: "no-store", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("no api");
      const data = await res.json();
      state.mode = "proxy";
      state.status = Object.assign({ mode: "proxy" }, data);
    } catch (e) {
      // 没有本地服务（静态托管 / 直接打开文件）→ 走浏览器直连
      state.mode = "direct";
      state.status = directStatus();
    }
    updateModelBadge();
  }

  /* ---------------------------------------------------------- 启动 */
  function boot() {
    load();

    $("#chat-fab").onclick = () => { open(); };
    $("#chat-close").onclick = close;
    $("#chat-new").onclick = () => {
      if (state.messages.length && !confirm("清空当前对话？（不影响进度和复盘记录）")) return;
      state.messages = [];
      state.pendingCtx = null;
      save();
      renderCtx();
      renderMessages();
    };
    $("#chat-setup").onclick = () => {
      state.setupOpen = !state.setupOpen;
      renderMessages();
    };

    const form = $("#chat-form");
    form.onsubmit = (e) => { e.preventDefault(); send(); };
    const input = $("#chat-input");
    input.addEventListener("input", () => autoGrow(input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("chat-open")) close();
    });

    loadStatus().then(() => {
      renderMessages();
      renderCtx();
    });
  }

  window.ChatUI = { open, close, toggle, ask, mdLite };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();