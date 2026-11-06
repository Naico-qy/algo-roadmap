/* 机试训练路线图 —— 纯前端，无依赖。进度/笔记/复盘存 localStorage。 */
"use strict";

const STORE_KEY = "algo-roadmap.v1";
const INTERVALS = [1, 3, 7, 21, 45, 90];        // 间隔重复：box 0..5 对应的天数
const BOX_LABEL = ["新错题", "1 天", "3 天", "7 天", "21 天", "45 天", "已稳固"];
const ERROR_TYPES = ["读题", "思路", "实现", "边界", "复杂度", "其他"];
const KIND_ORDER = ["平台", "题单", "课程", "文档", "模拟赛", "真题", "可视化", "社区"];

let CURR = null;
let S = null;
let currentView = "today";

/* ------------------------------------------------------------ 日期工具 */
// 统一用「本地日期字符串 YYYY-MM-DD」，避免时区导致的跨天错乱
function todayStr() { return toStr(new Date()); }
function toStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseDate(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return toStr(d);
}
function diffDays(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

/* ------------------------------------------------------------ 状态 */
function defaultState() {
  return {
    version: 1,
    planStart: todayStr(),
    targetDate: (CURR && CURR.meta.targetDate) || "2027-06-15",
    dailyTopics: 3,
    dailyReview: 5,
    doneTopics: {},
    taskProgress: {},
    notes: {},
    cards: [],
    activity: {},
    principlesOpen: false,
  };
}

function loadState() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  S.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch (e) {
    toast("保存失败：浏览器存储不可用（无痕模式？）");
  }
  // 开启云同步时防抖上传
  if (window.ProgressSync && window.ProgressSync.onLocalChange) window.ProgressSync.onLocalChange();
}

/* ------------------------------------------------------------ 派生数据 */
function allTopics() {
  const out = [];
  CURR.stages.forEach((st) => st.topics.forEach((t) => out.push({ stage: st, topic: t })));
  return out;
}

function topicsOf(st) { return st.topics.length; }

function taskPercent(st, task) {
  const p = S.taskProgress[task.id] || {};
  if (task.count) return Math.min(1, (Number(p.solved) || 0) / task.count);
  return p.done ? 1 : 0;
}

function stageStats(st) {
  const tTotal = st.topics.length;
  const tDone = st.topics.filter((t) => S.doneTopics[t.id]).length;
  let frac = 0;
  st.tasks.forEach((a) => { frac += taskPercent(st, a); });
  const denom = tTotal + st.tasks.length;
  const pct = denom ? Math.round(((tDone + frac) / denom) * 100) : 0;
  return { tDone, tTotal, tasksDone: frac, pct };
}

function overallStats() {
  let tTotal = 0, tDone = 0, taskTotal = 0, taskDone = 0, problems = 0;
  CURR.stages.forEach((st) => {
    const s = stageStats(st);
    tTotal += s.tTotal; tDone += s.tDone;
    taskTotal += st.tasks.length; taskDone += s.tasksDone;
    st.tasks.forEach((a) => { if (a.count) problems += Number((S.taskProgress[a.id] || {}).solved) || 0; });
  });
  const denom = tTotal + taskTotal;
  return {
    topicsDone: tDone, topicsTotal: tTotal,
    taskDone: Math.round(taskDone), taskTotal,
    problems,
    pct: denom ? Math.round(((tDone + taskDone) / denom) * 100) : 0,
    cards: S.cards.length,
    due: dueCards().length,
  };
}

function currentStage() {
  for (const st of CURR.stages) {
    if (stageStats(st).pct < 100) return st;
  }
  return CURR.stages[CURR.stages.length - 1];
}

function planWeek() {
  const total = CURR.meta.totalWeeks || 30;
  const w = Math.floor(diffDays(S.planStart, todayStr()) / 7) + 1;
  return Math.max(1, Math.min(total, w));
}

function actualWeek() {
  let doneWeeks = 0;
  for (const st of CURR.stages) {
    const s = stageStats(st);
    if (s.pct >= 100) { doneWeeks += st.weeks; continue; }
    doneWeeks += st.weeks * (s.pct / 100);
    break;
  }
  return Math.max(1, Math.min(CURR.meta.totalWeeks, Math.round(doneWeeks * 10) / 10));
}

function stageWeekRange(index) {
  let start = 1;
  for (let i = 0; i < index; i++) start += CURR.stages[i].weeks;
  return [start, start + CURR.stages[index].weeks - 1];
}

function dueCards() {
  const t = todayStr();
  return S.cards.filter((c) => !c.due || c.due <= t).sort((a, b) => (a.due || "").localeCompare(b.due || ""));
}

function upcomingCards() {
  const t = todayStr();
  return S.cards.filter((c) => c.due && c.due > t).sort((a, b) => a.due.localeCompare(b.due));
}

function streakDays() {
  let n = 0;
  let d = todayStr();
  // 今天没记录也不应清零（还没开始学），从今天或昨天起算
  if (!hasActivity(d)) d = addDays(d, -1);
  while (hasActivity(d)) { n++; d = addDays(d, -1); }
  return n;
}
function hasActivity(day) {
  const a = S.activity[day];
  return !!(a && (a.topics || a.review || a.problems));
}
function logActivity(patch) {
  const d = todayStr();
  const a = S.activity[d] || { topics: 0, review: 0, problems: 0 };
  for (const k of Object.keys(patch)) a[k] = (a[k] || 0) + patch[k];
  S.activity[d] = a;
}

/* ------------------------------------------------------------ 交互动作 */
function toggleTopic(id) {
  if (S.doneTopics[id]) delete S.doneTopics[id];
  else { S.doneTopics[id] = todayStr(); logActivity({ topics: 1 }); }
  saveState();
  renderAll();
}

function setTaskSolved(taskId, value, total) {
  const prev = Number((S.taskProgress[taskId] || {}).solved) || 0;
  const v = Math.max(0, Math.min(total, Number(value) || 0));
  S.taskProgress[taskId] = Object.assign({}, S.taskProgress[taskId], { solved: v, done: v >= total });
  if (v > prev) logActivity({ problems: v - prev });
  saveState();
  renderAll();
}

function toggleTaskDone(taskId) {
  const p = S.taskProgress[taskId] || {};
  S.taskProgress[taskId] = Object.assign({}, p, { done: !p.done });
  if (S.taskProgress[taskId].done) logActivity({ topics: 1 });
  saveState();
  renderAll();
}

function gradeCard(id, ok) {
  const c = S.cards.find((x) => x.id === id);
  if (!c) return;
  c.box = ok ? Math.min(INTERVALS.length, (c.box || 0) + 1) : 0;
  c.due = addDays(todayStr(), INTERVALS[Math.min(c.box, INTERVALS.length - 1)]);
  c.reps = (c.reps || 0) + 1;
  c.last = todayStr();
  logActivity({ review: 1 });
  saveState();
  renderAll();
  toast(ok ? `已排到 ${c.due} 再复习（第 ${c.box + 1} 档）` : `已重置，明天再来一次`);
}

function deleteCard(id) {
  S.cards = S.cards.filter((x) => x.id !== id);
  saveState();
  renderAll();
  toast("已删除这条复盘");
}

function addCard(data) {
  S.cards.unshift({
    id: "c" + Date.now() + Math.random().toString(36).slice(2, 6),
    title: data.title.trim(),
    url: (data.url || "").trim(),
    stage: data.stage || "",
    errorType: data.errorType || "其他",
    lesson: (data.lesson || "").trim(),
    created: todayStr(),
    due: addDays(todayStr(), 1),
    box: 0,
    reps: 0,
  });
  saveState();
  renderAll();
  toast("已加入复盘队列，明天到期");
}

/* ------------------------------------------------------------ 渲染：框架 */
function renderChrome() {
  const days = diffDays(todayStr(), S.targetDate);
  const el = $("#countdown");
  if (days > 0) {
    el.innerHTML = `距 <b>${esc(S.targetDate)}</b> 还有 <b>${days}</b> 天<br><span class="small">计划第 ${planWeek()} 周 / 共 ${CURR.meta.totalWeeks} 周</span>`;
  } else if (days === 0) {
    el.innerHTML = `<b>今天就是目标日</b><br><span class="small">祝顺利</span>`;
  } else {
    el.innerHTML = `<b>目标日已过 ${-days} 天</b><br><span class="small">可在设置里改日期</span>`;
  }
  const due = dueCards().length;
  const pill = $("#pill-due");
  pill.textContent = due;
  pill.className = "pill" + (due ? " hot" : "");
}

function renderAll() {
  renderChrome();
  renderToday();
  renderRoadmap();
  renderReview();
  renderResources();
  renderStats();
  renderSettings();
}

/* ------------------------------------------------------------ 今日 */
function renderToday() {
  const st = currentStage();
  const sstat = stageStats(st);
  const days = diffDays(todayStr(), S.targetDate);
  const delta = actualWeek() - planWeek();

  // 今日知识点：当前阶段里前 N 个未完成
  const nextTopics = st.topics.filter((t) => !S.doneTopics[t.id]).slice(0, S.dailyTopics);
  // 到期复盘
  const due = dueCards().slice(0, S.dailyReview);
  // 混练提醒
  const mixed = st.tasks.filter((a) => a.kind === "混练" || a.kind === "模拟赛");

  const topicItems = nextTopics.map((t) => `
    <li>
      <button class="cb" data-topic="${esc(t.id)}" title="标记完成">${S.doneTopics[t.id] ? "✓" : ""}</button>
      <div class="task-main">
        <div class="task-title">${esc(t.name)}<button class="ask-btn" data-ask-topic="${esc(t.id)}" title="带上这个知识点问 AI">问</button></div>
        <div class="task-note">${esc(t.note || "")}</div>
      </div>
    </li>`).join("");

  const cardItems = due.map((c) => `
    <li>
      <button class="cb" data-grade="${esc(c.id)}" title="重做成功">✓</button>
      <div class="task-main">
        <div class="task-title">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</div>
        <div class="task-note">错因：${esc(c.errorType)} · 第 ${(c.reps || 0) + 1} 次重做${c.lesson ? " · " + esc(c.lesson) : ""}</div>
        <div class="row" style="margin-top:6px">
          <button class="btn tiny" data-ask-card="${esc(c.id)}">问 AI</button>
        <button class="btn tiny primary" data-grade="${esc(c.id)}">重做成功</button>
          <button class="btn tiny danger" data-fail="${esc(c.id)}">还是不会</button>
        </div>
      </div>
    </li>`).join("");

  const totalToday = topicItems ? nextTopics.length : 0;
  const doneToday = (S.activity[todayStr()] || {}).topics || 0;

  $("#view-today").innerHTML = `
    <div class="hero">
      <div class="card">
        <div class="row" style="align-items:flex-start">
          <div style="flex:1">
            <div class="muted small">当前阶段 · 计划第 ${stageWeekRange(CURR.stages.indexOf(st))[0]}–${stageWeekRange(CURR.stages.indexOf(st))[1]} 周</div>
            <h2 style="margin:2px 0 2px;font-size:19px">${esc(st.name)}</h2>
            <div class="muted small">${esc(st.goal)}</div>
          </div>
          <div style="text-align:right">
            <div class="big-num" style="font-size:30px">${sstat.pct}<small>%</small></div>
            <div class="muted small">${sstat.tDone}/${sstat.tTotal} 知识点</div>
          </div>
        </div>
        <div class="bar ${sstat.pct >= 100 ? "ok" : ""}" style="margin:12px 0 12px"><i style="width:${sstat.pct}%"></i></div>
        <div class="row small muted">
          <span>目标日 ${esc(S.targetDate)}</span>
          <span>·</span>
          <span>已投入 ${diffDays(S.planStart, todayStr())} 天</span>
          <span class="spacer"></span>
          <span class="${delta >= 0 ? "tag ok" : "tag warn"}">${delta >= 0 ? "进度正常/超前" : "落后约 " + Math.abs(delta) + " 周"}</span>
        </div>
      </div>
      <div class="card">
        <div class="muted small">学习节奏</div>
        <div class="row" style="margin:6px 0 2px;align-items:baseline">
          <div class="big-num">${streakDays()}<small>天连续</small></div>
          <span class="spacer"></span>
          <div class="muted small">今日已完成 ${doneToday} 项</div>
        </div>
        <div class="muted small" style="margin-top:8px">
          今日待办：${totalToday} 个知识点 · ${due.length} 条复盘
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-goto="roadmap">查看完整路线</button>
          <button class="btn" data-addcard="1">+ 记一条错题</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <h2 style="flex:1">今天做什么</h2>
        <span class="muted small">${days > 0 ? "距考试 " + days + " 天" : "考试日已到/已过"}</span>
      </div>
      <p class="lead">按当前阶段顺序往下推；复盘优先于新题——到期的错题先做完。</p>

      <div class="block">
        <div class="block-title">① 新知识点（${nextTopics.length}）</div>
        ${topicItems ? `<ul class="task-list">${topicItems}</ul>` : `<div class="empty">当前阶段的知识点都过完了，去「路线图」把题单继续推进，或进入下一阶段。</div>`}
      </div>

      <div class="block">
        <div class="block-title">② 到期复盘（${due.length}）</div>
        ${cardItems ? `<ul class="task-list">${cardItems}</ul>` :
          `<div class="empty">今天没有到期错题。${S.cards.length ? "下次到期在 " + (upcomingCards()[0] || {}).due + "。" : "还没记录过错题——做错的题随手记一条，比多刷 10 题有用。"}</div>`}
      </div>

      <div class="block">
        <div class="block-title">③ 混合练习（不看专题标签，自己判断用哪个方法）</div>
        ${mixed.length
          ? mixed.map((a) => `<div class="task"><div class="task-main"><div class="task-title"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a> <span class="tag accent">${esc(a.kind)}</span></div><div class="task-note">${esc(a.note || "")}</div></div></div>`).join("")
          : `<div class="empty">今天从题库里随机做 2 道<b>混合难度</b>的题——不要按专题挑，练「识别该用什么方法」。</div>`}
      </div>
    </div>

    ${principlesHTML()}
  `;

  bindCommon($("#view-today"));
}

function principlesHTML() {
  const open = S.principlesOpen;
  return `
    <div class="card">
      <div class="row">
        <h2 style="flex:1">这套顺序科学吗？—— 7 条依据</h2>
        <button class="btn tiny ghost" data-principles="1">${open ? "收起" : "展开"}</button>
      </div>
      <p class="lead">你的大方向是对的：语法 → 数据结构 → 算法 → 大量训练。但有 3 处按学习科学应该调整，下面每条都写清了「为什么」。</p>
      ${open ? `<div class="principles">${CURR.principles.map((p, i) => `
        <div class="prin${i < 3 ? " new" : ""}">
          <h4><span class="idx">${String(i + 1).padStart(2, "0")}</span>${esc(p.title)}</h4>
          <p>${esc(p.body)}</p>
        </div>`).join("")}</div>` : ""}
    </div>`;
}

/* ------------------------------------------------------------ 路线图 */
function renderRoadmap() {
  const cur = currentStage();
  const html = CURR.stages.map((st, idx) => {
    const s = stageStats(st);
    const range = stageWeekRange(idx);
    const isCur = st.id === cur.id;
    const done = s.pct >= 100;
    const collapsed = !isCur;   // 只展开当前阶段，其余折叠，避免页面过长
    return `
    <section class="stage ${isCur ? "current" : ""} ${done ? "done" : ""}" data-stage="${esc(st.id)}">
      <div class="stage-head" data-toggle-stage="${esc(st.id)}">
        <div class="line1">
          <span class="stage-no">${done ? "✓" : idx}</span>
          <span class="stage-name">${esc(st.name)}</span>
          <span class="tag ${isCur ? "accent" : ""}">${esc(st.band)}</span>
          <span class="stage-meta">第 ${range[0]}–${range[1]} 周 · ${st.weeks} 周</span>
          <span class="spacer"></span>
          <span class="stage-meta">${s.tDone}/${s.tTotal} 知识点 · ${s.pct}%</span>
        </div>
        <div class="bar" style="margin-top:10px"><i style="width:${s.pct}%"></i></div>
        <div class="stage-goal">${esc(st.goal)}</div>
      </div>
      <div class="stage-body ${collapsed ? "collapsed" : ""}" id="body-${esc(st.id)}">

        <div class="block">
          <div class="block-title">为什么放在这个位置</div>
          <div class="why">${esc(st.why)}</div>
        </div>

        <div class="block">
          <div class="block-title">知识点清单（${s.tDone}/${s.tTotal}）</div>
          ${st.topics.map((t) => {
            const ok = !!S.doneTopics[t.id];
            const note = S.notes[t.id];
            return `
            <div class="topic ${ok ? "done" : ""}">
              <button class="cb" data-topic="${esc(t.id)}" title="标记完成">${ok ? "✓" : ""}</button>
              <div class="task-main">
                <div class="row" style="gap:6px">
                  <span class="topic-name">${esc(t.name)}</span>
                  <button class="note-btn ${note ? "has" : ""}" data-note="${esc(t.id)}" title="记笔记">${note ? "✎ 笔记" : "✎ 记笔记"}</button>
                  <button class="ask-btn" data-ask-topic="${esc(t.id)}" title="带上这个知识点问 AI">问</button>
                </div>
                ${t.note ? `<div class="topic-note">${esc(t.note)}</div>` : ""}
                ${note ? `<div class="topic-note-text">${esc(note)}</div>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>

        <div class="block">
          <div class="block-title">配套练习（点标题直达）</div>
          ${st.tasks.map((a) => {
            const p = S.taskProgress[a.id] || {};
            const pct = Math.round(taskPercent(st, a) * 100);
            return `
            <div class="task">
              <div class="task-main">
                <div class="task-title">
                  <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
                  <span class="tag ${a.kind === "模拟赛" ? "warn" : a.kind === "题单" ? "accent" : ""}">${esc(a.kind)}</span>
                  ${a.must ? `<span class="tag">必做</span>` : `<span class="tag">选做</span>`}
                  <button class="ask-btn" data-ask-task="${esc(a.id)}" title="问 AI 这个怎么练">问</button>
                </div>
                ${a.note ? `<div class="task-note">${esc(a.note)}</div>` : ""}
                ${a.count ? `
                  <div class="task-progress">
                    <input type="number" min="0" max="${a.count}" value="${Number(p.solved) || 0}" data-solved="${esc(a.id)}" data-total="${a.count}">
                    <span class="small muted">/ ${a.count} 题</span>
                    <div class="bar ${pct >= 100 ? "ok" : ""}"><i style="width:${pct}%"></i></div>
                    <span class="pct">${pct}%</span>
                  </div>` : `
                  <div class="task-progress">
                    <button class="btn tiny ${p.done ? "primary" : ""}" data-taskdone="${esc(a.id)}">${p.done ? "✓ 已完成" : "标记完成"}</button>
                  </div>`}
              </div>
            </div>`;
          }).join("")}
        </div>

        <div class="block">
          <div class="block-title">通关标准（做到了再进下一阶段）</div>
          <div class="exit"><b>退出条件：</b>${esc(st.exit)}</div>
        </div>

        ${st.pitfalls && st.pitfalls.length ? `
        <div class="block">
          <div class="block-title">这一阶段最容易踩的坑</div>
          <div class="pitfall"><ul>${st.pitfalls.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
        </div>` : ""}

      </div>
    </section>`;
  }).join("");

  $("#view-roadmap").innerHTML = `
    <p class="lead">共 ${CURR.meta.totalWeeks} 周、${CURR.stages.length} 个阶段。点阶段标题可展开/收起；知识点打勾即记录进度，练习可填已完成题数。</p>
    ${html}`;
  bindCommon($("#view-roadmap"));
}

/* ------------------------------------------------------------ 复盘本 */
function renderReview() {
  const due = dueCards();
  const soon = upcomingCards();
  const all = S.cards;

  const errCount = {};
  ERROR_TYPES.forEach((k) => { errCount[k] = 0; });
  all.forEach((c) => { errCount[c.errorType] = (errCount[c.errorType] || 0) + 1; });
  const maxErr = Math.max(1, ...Object.values(errCount));

  const stageOptions = CURR.stages.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  const errOptions = ERROR_TYPES.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join("");

  const cardHTML = (c, cls) => `
    <div class="recard ${cls}">
      <div class="rc-head">
        <span class="rc-title">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</span>
        <span class="tag ${c.errorType === "思路" ? "bad" : c.errorType === "实现" ? "warn" : "accent"}">${esc(c.errorType)}</span>
        <span class="tag">${esc(BOX_LABEL[Math.min(c.box || 0, BOX_LABEL.length - 1)])}</span>
      </div>
      ${c.lesson ? `<div class="rc-lesson">${esc(c.lesson)}</div>` : ""}
      <div class="rc-foot">
        <span class="rc-meta">记录于 ${esc(c.created)} · 已重做 ${c.reps || 0} 次${c.last ? " · 上次 " + esc(c.last) : ""}</span>
        <span class="spacer"></span>
        <span class="rc-meta">下次 ${esc(c.due || "—")}</span>
        <button class="btn tiny primary" data-grade="${esc(c.id)}">重做成功</button>
        <button class="btn tiny danger" data-fail="${esc(c.id)}">还是不会</button>
        <button class="btn tiny ghost" data-del="${esc(c.id)}">删除</button>
      </div>
    </div>`;

  $("#view-review").innerHTML = `
    <div class="review-grid">
      <div>
        <div class="card">
          <h2>记一条错题</h2>
          <p class="lead">只写两件事：错在哪一类、下次靠什么信号识别它。</p>
          <form id="card-form">
            <label class="fl">题目 / 题号 *</label>
            <input type="text" name="title" required placeholder="例：LeetCode 300 最长递增子序列">
            <label class="fl">链接（可选）</label>
            <input type="url" name="url" placeholder="https://...">
            <div class="form-grid">
              <div>
                <label class="fl">所属阶段</label>
                <select name="stage">${stageOptions}</select>
              </div>
              <div>
                <label class="fl">错因分类</label>
                <select name="errorType">${errOptions}</select>
              </div>
            </div>
            <label class="fl">一句话教训 *</label>
            <textarea name="lesson" required placeholder="例：看到「最长子序列」先想 DP 而不是贪心；状态定义要包含「以 i 结尾」。"></textarea>
            <div class="row" style="margin-top:12px">
              <button class="btn primary" type="submit">加入复盘队列</button>
              <span class="small muted">默认明天首次复习，之后按 1/3/7/21/45 天递进</span>
            </div>
          </form>
        </div>

        <div class="card">
          <h3>错因分布</h3>
          ${all.length ? `<div class="errbars">${ERROR_TYPES.map((k) => `
            <div class="errbar">
              <span>${esc(k)}</span>
              <div class="bar"><i style="width:${Math.round(errCount[k] / maxErr * 100)}%;background:${k === "思路" ? "var(--bad)" : k === "实现" ? "var(--warn)" : "var(--accent)"}"></i></div>
              <span class="n">${errCount[k]}</span>
            </div>`).join("")}</div>
            <p class="small muted" style="margin:10px 0 0">通常 2~3 类错因会占 80%。如果你的「思路」特别多，说明该回头补专题；如果「实现」多，说明要练一次写对。</p>`
          : `<div class="empty">还没有记录。做错题时花 30 秒记一条，一个月后你会感谢自己。</div>`}
        </div>
      </div>

      <div>
        <div class="card">
          <div class="row"><h2 style="flex:1">今天到期（${due.length}）</h2><span class="muted small">共 ${all.length} 条复盘</span></div>
          ${due.length ? due.map((c) => cardHTML(c, "due")).join("") : `<div class="empty">今天没有到期项。${soon.length ? "最近一条在 " + esc(soon[0].due) + "。" : ""}</div>`}
        </div>

        <div class="card">
          <h2>已排期（${soon.length}）</h2>
          ${soon.length ? soon.map((c) => cardHTML(c, "soon")).join("") : `<div class="empty">暂无未来排期</div>`}
        </div>
      </div>
    </div>

    <div id="all-cards"></div>`;

  // 表单提交
  const form = $("#card-form");
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = (fd.get("title") || "").toString().trim();
      if (!title) return;
      addCard({
        title,
        url: (fd.get("url") || "").toString(),
        stage: (fd.get("stage") || "").toString(),
        errorType: (fd.get("errorType") || "其他").toString(),
        lesson: (fd.get("lesson") || "").toString(),
      });
      form.reset();
    };
  }
  bindCommon($("#view-review"));
}

/* ------------------------------------------------------------ 资源库 */
let resFilter = { kind: "", level: "", q: "" };

function renderResources() {
  const kinds = [...new Set(CURR.resources.map((r) => r.kind))].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  const list = CURR.resources.filter((r) => {
    if (resFilter.kind && r.kind !== resFilter.kind) return false;
    if (resFilter.level && !r.level.includes(resFilter.level)) return false;
    if (resFilter.q) {
      const hay = `${r.name} ${r.best_for} ${r.caveat} ${r.kind}`.toLowerCase();
      if (!hay.includes(resFilter.q.toLowerCase())) return false;
    }
    return true;
  });

  $("#view-resources").innerHTML = `
    <p class="lead">19 个平台/资源，按用途挑，不用都用。每张卡都标了「最适合什么」和「要注意什么」——包括哪些国内访问可能不稳。</p>
    <div class="filters">
      <button class="chip ${resFilter.kind === "" ? "on" : ""}" data-rk="">全部</button>
      ${kinds.map((k) => `<button class="chip ${resFilter.kind === k ? "on" : ""}" data-rk="${esc(k)}">${esc(k)}</button>`).join("")}
      <span style="width:8px"></span>
      ${["入门", "进阶", "高阶"].map((lv) => `<button class="chip ${resFilter.level === lv ? "on" : ""}" data-rl="${lv}">${lv}</button>`).join("")}
      <span class="spacer"></span>
      <input type="text" id="rq" placeholder="搜索…" value="${esc(resFilter.q)}" style="width:180px">
    </div>
    <div class="res-grid">
      ${list.length ? list.map((r) => `
        <div class="res" data-hay="${esc((r.name + " " + r.best_for + " " + r.caveat + " " + r.kind).toLowerCase())}">
          <h3><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)} ↗</a></h3>
          <div class="res-meta">
            <span class="tag accent">${esc(r.kind)}</span>
            <span class="tag">${esc(r.level)}</span>
            <span class="tag">${esc(r.cost)}</span>
            <span class="tag">${esc(r.lang)}</span>
          </div>
          <div class="best"><b>适合：</b>${esc(r.best_for)}</div>
          ${r.caveat ? `<div class="caveat"><b>注意：</b>${esc(r.caveat)}</div>` : ""}
        </div>`).join("") : `<div class="empty">没有匹配的资源</div>`}
    </div>`;

  const box = $("#view-resources");
  box.querySelectorAll("[data-rk]").forEach((b) => {
    b.onclick = () => { resFilter.kind = b.dataset.rk; renderResources(); };
  });
  box.querySelectorAll("[data-rl]").forEach((b) => {
    b.onclick = () => { resFilter.level = resFilter.level === b.dataset.rl ? "" : b.dataset.rl; renderResources(); };
  });
  const q = $("#rq");
  if (q) {
    q.oninput = () => {
      resFilter.q = q.value;
      const needle = q.value.trim().toLowerCase();
      box.querySelectorAll(".res").forEach((el) => {
        el.style.display = !needle || (el.dataset.hay || "").includes(needle) ? "" : "none";
      });
    };
  }
}

/* ------------------------------------------------------------ 进度 */
function renderStats() {
  const o = overallStats();
  const delta = actualWeek() - planWeek();

  // 近 14 天热力
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(todayStr(), -i);
    const a = S.activity[d] || {};
    const pts = (a.topics || 0) + (a.review || 0) + (a.problems || 0);
    const lv = pts === 0 ? 0 : pts <= 2 ? 1 : pts <= 5 ? 2 : pts <= 9 ? 3 : 4;
    days.push({ d, pts, lv, label: `${d}：${pts} 项` });
  }

  const stageRows = CURR.stages.map((st, i) => {
    const s = stageStats(st);
    return `<div class="srow">
      <span class="stage-no" style="width:20px;height:20px;font-size:10px">${s.pct >= 100 ? "✓" : i}</span>
      <span>${esc(st.name)}</span>
      <div class="bar ${s.pct >= 100 ? "ok" : ""}"><i style="width:${s.pct}%"></i></div>
      <span class="pct">${s.pct}%</span>
    </div>`;
  }).join("");

  $("#view-stats").innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="n accent">${o.pct}%</div><div class="k">整体完成度</div></div>
      <div class="stat"><div class="n">${o.topicsDone}<span class="muted small">/${o.topicsTotal}</span></div><div class="k">知识点</div></div>
      <div class="stat"><div class="n">${o.problems}</div><div class="k">已刷题数（按你填的累计）</div></div>
      <div class="stat"><div class="n ok">${o.cards}</div><div class="k">复盘卡片</div></div>
      <div class="stat"><div class="n ${o.due ? "bad" : ""}">${o.due}</div><div class="k">今日到期</div></div>
      <div class="stat"><div class="n">${streakDays()}</div><div class="k">连续学习天数</div></div>
    </div>

    <div class="card">
      <div class="row"><h2 style="flex:1">计划进度对照</h2>
        <span class="tag ${delta >= 0 ? "ok" : "warn"}">${delta >= 0 ? "正常/超前 " + delta + " 周" : "落后 " + Math.abs(delta) + " 周"}</span>
      </div>
      <div class="row" style="margin:10px 0 4px;gap:24px">
        <div><div class="muted small">按时间应该到</div><div style="font-size:19px;font-weight:600">第 ${planWeek()} 周</div></div>
        <div><div class="muted small">按进度实际在</div><div style="font-size:19px;font-weight:600">第 ${actualWeek()} 周</div></div>
        <div><div class="muted small">起步日期</div><div style="font-size:19px;font-weight:600">${esc(S.planStart)}</div></div>
      </div>
      <p class="small muted" style="margin:8px 0 0">「周」是把知识点和题单完成度加权换算的粗估，用来判断节奏，不是精确指标。落后 2 周以内不用焦虑，超过 4 周建议砍掉 S4 里的选学专题。</p>
    </div>

    <div class="card">
      <h2>各阶段完成度</h2>
      <div class="stage-rows" style="margin-top:12px">${stageRows}</div>
    </div>

    <div class="card">
      <h2>最近 14 天</h2>
      <div class="heat" style="margin-top:12px">
        ${days.map((x) => `<div class="cell" data-l="${x.lv}" title="${esc(x.label)}"></div>`).join("")}
      </div>
      <div class="heat-legend">
        <span>少</span>
        <i style="background:var(--line-2)"></i><i style="background:#dbe4fd"></i><i style="background:#b9c8fb"></i><i style="background:#8fa4f6"></i><i style="background:var(--accent)"></i>
        <span>多</span>
        <span style="margin-left:8px">每格一天，按「知识点 + 复盘 + 题数」累计</span>
      </div>
    </div>`;
}

/* ------------------------------------------------------------ 设置 */
function renderSettings() {
  $("#view-settings").innerHTML = `
    <div class="card">
      <h2>计划设置</h2>
      <div class="kv"><span>目标考试日期</span><input type="date" id="set-target" value="${esc(S.targetDate)}"></div>
      <div class="kv"><span>今日新知识点数</span><input type="number" id="set-topics" min="1" max="10" value="${S.dailyTopics}" style="width:90px"></div>
      <div class="kv"><span>今日复盘上限</span><input type="number" id="set-review" min="1" max="30" value="${S.dailyReview}" style="width:90px"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="save-settings">保存</button>
        <span class="small muted">改日期后会重新计算倒计时与「应该到第几周」</span>
      </div>
    </div>

    <div id="sync-panel"></div>

    <div class="card">
      <h2>数据备份</h2>
      <p class="lead">所有记录都在这个浏览器里。换设备 / 清缓存前导出一次。</p>
      <div class="row">
        <button class="btn" id="export">导出 JSON</button>
        <button class="btn" id="import">导入 JSON</button>
        <span class="spacer"></span>
        <button class="btn danger" id="reset">清空所有记录</button>
      </div>
      <p class="small muted" style="margin-top:10px">
        当前数据：知识点 ${Object.keys(S.doneTopics).length} 条、笔记 ${Object.keys(S.notes).length} 条、
        复盘 ${S.cards.length} 条、活动记录 ${Object.keys(S.activity).length} 天。
      </p>
    </div>

    <div class="card">
      <h2>怎么用这个站</h2>
      <ol class="small muted" style="margin:0;padding-left:20px;line-height:1.9">
        <li><b>每天只打开「今日」</b>：按 ① 新知识点 → ② 到期复盘 → ③ 混合练习 的顺序做，不要跳。</li>
        <li><b>做完就打勾 / 填题数</b>：进度条和「应该到第几周」都靠这个，不填就等于没练。</li>
        <li><b>做错的题立刻记一条</b>：标题 + 错因 + 一句话教训。系统会按 1/3/7/21/45 天排复习。</li>
        <li><b>到期的那天不看题解重做</b>：能独立写出来才点「重做成功」，否则点「还是不会」重置。</li>
        <li><b>每两周看一次「进度」</b>：如果某一类错因特别多，回路线图补对应专题。</li>
      </ol>
    </div>`;

  if (window.ProgressSync && window.ProgressSync.render) window.ProgressSync.render();

  $("#set-target").onchange = (e) => { S.targetDate = e.target.value || S.targetDate; saveState(); renderAll(); };
  $("#set-topics").onchange = (e) => { S.dailyTopics = Math.max(1, Number(e.target.value) || 3); saveState(); renderAll(); };
  $("#set-review").onchange = (e) => { S.dailyReview = Math.max(1, Number(e.target.value) || 5); saveState(); renderAll(); };
  $("#save-settings").onclick = () => toast("已保存");
  $("#export").onclick = exportData;
  $("#import").onclick = importData;
  $("#reset").onclick = () => {
    if (!confirm("清空所有进度、笔记和复盘记录？此操作不可撤销（建议先导出备份）。")) return;
    S = defaultState();
    saveState();
    renderAll();
    toast("已清空");
  };
}

function exportData() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `机试路线图备份-${todayStr()}.json`;
  a.click();
  toast("已导出备份");
}

function importData() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,application/json";
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (!data || typeof data !== "object") throw new Error("格式不对");
        S = Object.assign(defaultState(), data);
        saveState();
        renderAll();
        toast("已导入");
      } catch (e) {
        toast("导入失败：不是有效的备份文件");
      }
    };
    fr.readAsText(f);
  };
  inp.click();
}

/* ------------------------------------------------------------ 笔记弹窗 */
function openNoteModal(topicId) {
  const item = allTopics().find((x) => x.topic.id === topicId);
  if (!item) return;
  const t = item.topic;
  const box = $("#modal-box");
  box.innerHTML = `
    <h3>${esc(t.name)}</h3>
    <p class="small muted" style="margin:2px 0 10px">${esc(t.note || "")}</p>
    <textarea id="note-text" style="min-height:150px" placeholder="记什么有用：这个知识点的适用信号、易错点、你自己的实现模板要点…">${esc(S.notes[topicId] || "")}</textarea>
    <div class="modal-foot">
      <button class="btn ghost" id="note-cancel">取消</button>
      ${S.notes[topicId] ? `<button class="btn danger" id="note-del">删除笔记</button>` : ""}
      <button class="btn primary" id="note-save">保存</button>
    </div>`;
  $("#modal").classList.remove("hidden");
  $("#note-text").focus();
  $("#note-cancel").onclick = closeModal;
  $("#note-save").onclick = () => {
    const v = $("#note-text").value.trim();
    if (v) S.notes[topicId] = v; else delete S.notes[topicId];
    saveState();
    closeModal();
    renderAll();
    toast("笔记已保存");
  };
  const del = $("#note-del");
  if (del) del.onclick = () => {
    delete S.notes[topicId];
    saveState();
    closeModal();
    renderAll();
    toast("笔记已删除");
  };
}

function closeModal() { $("#modal").classList.add("hidden"); }

/* ------------------------------------------------------------ 问 AI */
function askContext(ctx, draft) {
  if (!window.ChatUI) { toast("AI 侧栏未加载，请刷新页面"); return; }
  window.ChatUI.ask(ctx, draft);
}

function askTopic(id) {
  const item = allTopics().find((x) => x.topic.id === id);
  if (!item) return;
  const st = item.stage, t = item.topic;
  const text = `阶段：${st.name}
知识点：${t.name}
要点：${t.note || "无"}`;
  askContext(
    { label: "知识点 · " + t.name, text },
    `用一句话讲清「${t.name}」是什么、什么时候该用、最容易错在哪。`
  );
}

function askTask(id) {
  for (const st of CURR.stages) {
    const a = st.tasks.find((x) => x.id === id);
    if (!a) continue;
    const text = `阶段：${st.name}
练习：${a.title}
类型：${a.kind}
链接：${a.url}
说明：${a.note || "无"}`;
    askContext(
      { label: a.title.slice(0, 20), text },
      "这个练习怎么练最有效？重点掌握什么、可以跳过什么？"
    );
    return;
  }
}

function askCard(id) {
  const c = S.cards.find((x) => x.id === id);
  if (!c) return;
  const text = `题目：${c.title}
错因分类：${c.errorType}
我的教训：${c.lesson || "无"}${c.url ? "｜链接：" + c.url : ""}`;
  askContext(
    { label: "错题 · " + c.title.slice(0, 16), text },
    `我这题错了（错因：${c.errorType}），帮我分析根本原因，并给我下次能识别的信号。`
  );
}

/* ------------------------------------------------------------ 通用绑定 */
function bindCommon(root) {
  if (!root) return;
  root.querySelectorAll("[data-topic]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); toggleTopic(b.dataset.topic); };
  });
  root.querySelectorAll("[data-note]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openNoteModal(b.dataset.note); };
  });
  root.querySelectorAll("[data-solved]").forEach((inp) => {
    const save = () => setTaskSolved(inp.dataset.solved, inp.value, Number(inp.dataset.total));
    inp.onchange = save;                       // 失焦时提交
    inp.onkeydown = (e) => {                   // 回车也提交（用户直觉）
      if (e.key === "Enter") { e.preventDefault(); save(); }
    };
  });
  root.querySelectorAll("[data-taskdone]").forEach((b) => {
    b.onclick = () => toggleTaskDone(b.dataset.taskdone);
  });
  root.querySelectorAll("[data-grade]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); gradeCard(b.dataset.grade, true); };
  });
  root.querySelectorAll("[data-fail]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); gradeCard(b.dataset.fail, false); };
  });
  root.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); if (confirm("删除这条复盘？")) deleteCard(b.dataset.del); };
  });
  root.querySelectorAll("[data-toggle-stage]").forEach((h) => {
    h.onclick = () => {
      const body = document.getElementById("body-" + h.dataset.toggleStage);
      if (body) body.classList.toggle("collapsed");
    };
  });
  root.querySelectorAll("[data-goto]").forEach((b) => {
    b.onclick = () => switchView(b.dataset.goto);
  });
  root.querySelectorAll("[data-addcard]").forEach((b) => {
    b.onclick = () => switchView("review");
  });
  root.querySelectorAll("[data-ask-topic]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); askTopic(b.dataset.askTopic); };
  });
  root.querySelectorAll("[data-ask-task]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); askTask(b.dataset.askTask); };
  });
  root.querySelectorAll("[data-ask-card]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); askCard(b.dataset.askCard); };
  });
  root.querySelectorAll("[data-principles]").forEach((b) => {
    b.onclick = () => { S.principlesOpen = !S.principlesOpen; saveState(); renderToday(); };
  });
}

function switchView(name) {
  currentView = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== "view-" + name));
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ 工具 */
const $ = (s) => document.querySelector(s);
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2000);
}

/* ------------------------------------------------------------ 启动 */
async function boot() {
  try {
    const res = await fetch("data/curriculum.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    CURR = await res.json();
  } catch (e) {
    document.querySelector("main").innerHTML =
      `<div class="card"><h2>读取课程数据失败</h2>
       <p class="muted">${esc(e.message)}</p>
       <p class="small muted">请用本地服务器打开本站（直接双击 index.html 时浏览器会拦截 fetch）：<br>
       <code>cd algo-roadmap &amp;&amp; python -m http.server 8900</code><br>
       然后访问 <code>http://127.0.0.1:8900/</code></p></div>`;
    return;
  }

  S = loadState();
  saveState();   // 首次访问写入 planStart

  document.getElementById("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) switchView(t.dataset.view);
  });
  $("#btn-settings").onclick = () => switchView("settings");
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  renderAll();
  switchView("today");

  // 已启用云同步时，检查云端是否有更新的记录（不自动覆盖本机）
  if (window.ProgressSync && window.ProgressSync.startupCheck) {
    window.ProgressSync.startupCheck();
  }
}

// 供云同步模块读写状态
window.__getState = () => S;
window.__setState = (data) => { S = Object.assign(defaultState(), data); saveState(); };
window.__rerender = () => renderAll();

boot();