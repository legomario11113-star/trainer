"use strict";
/* Тренер — локальный дневник тренировок. Все данные хранятся в localStorage этого устройства. */

const KEY = "trainer.v1";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const ruDate = iso => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const fmtSec = s => { s = Math.max(0, Math.round(+s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const numStr = v => (v === "" || v == null) ? "" : String(v).replace(".", ",");
const toNum = v => { if (v === "" || v == null) return ""; const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? "" : n; };
const RIR = ["", "0", "1", "2", "3", "4+"];
const RIR_LABEL = { "0": "0 — отказ", "1": "+1 — на пределе", "2": "+2 — тяжело", "3": "+3 — норм", "4+": "+4 — легко" };

/* ---------- состояние ---------- */
/* S.names — клиенты {id: имя}; S.plans — план каждого клиента; sessions/measures помечены profile = id клиента.
   S.library — библиотека упражнений тренера. Подробности — PROJECT_NOTES.md. */
function blank() {
  return {
    names: {}, plans: {}, sessions: [], measures: [], drafts: {}, deleted: {}, library: [],
    meta: { plansTs: {}, nameTs: {}, deletedClients: {}, libraryTs: 0 },
    ui: { profile: "", tab: "today", day: {}, coach: { view: "list", id: "" } }
  };
}
function normalize(st) {
  st.deleted = st.deleted || {}; st.library = st.library || []; st.names = st.names || {}; st.plans = st.plans || {};
  st.meta = Object.assign({ plansTs: {}, nameTs: {}, deletedClients: {}, libraryTs: 0 }, st.meta || {});
  st.meta.plansTs = st.meta.plansTs || {}; st.meta.deletedClients = st.meta.deletedClients || {};
  if (!st.meta.nameTs || typeof st.meta.nameTs !== "object") st.meta.nameTs = {};
  Object.keys(st.names).forEach(id => { if (st.meta.nameTs[id] == null) st.meta.nameTs[id] = st.meta.namesTs || 0; });   // v2 → v3
  st.ui = Object.assign({ profile: "", tab: "today", day: {}, coach: { view: "list", id: "" } }, st.ui || {});
  st.ui.coach = st.ui.coach || { view: "list", id: "" };
  return st;
}
let S;
try { S = normalize(Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || "null") || {})); } catch { S = blank(); }
// переименование дней плана девушки (А/Б → понятные названия)
(() => {
  const ren = { "Тренировка А": "Ягодицы и спина", "Тренировка Б": "Ноги и плечи" };
  let hit = false;
  (S.plans.her?.days || []).forEach(d => { if (ren[d.title]) { d.title = ren[d.title]; hit = true; } });
  Object.values(S.drafts || {}).forEach(d => { if (d?.dayTitle) Object.entries(ren).forEach(([o, n]) => { d.dayTitle = d.dayTitle.replace(o, n); }); });
  if (hit) S.meta.plansTs.her = Date.now();
})();
// неделя 1 девушки: облегчённый объём и подсказки для новичка
(() => {
  if (S.meta.herW1Adj || S.plans.her?.week !== "Неделя 1 — знакомство с залом") return;
  const def = window.DEFAULT_PLANS.her;
  S.plans.her.rule = def.rule;
  S.plans.her.days.forEach(d => {
    const dd = def.days.find(x => x.id === d.id); if (!dd) return;
    d.exercises.forEach(e => { const de = dd.exercises.find(x => x.name === e.name); if (de) { e.sets = de.sets; e.hint = de.hint; } });
  });
  S.meta.herW1Adj = 1; S.meta.plansTs.her = Date.now();
  const dr = S.drafts.her;
  if (dr && !dr.ex.some(e => e.sets.some(x => x.done))) delete S.drafts.her;
})();
const changed = () => { if (typeof Sync !== "undefined") Sync.schedule(); };
let saveT;
function save(now) {
  clearTimeout(saveT);
  const w = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast("Не удалось сохранить: " + e.message); } };
  now ? w() : (saveT = setTimeout(w, 250));
}
window.addEventListener("pagehide", () => save(true));
document.addEventListener("visibilitychange", () => document.hidden && save(true));
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

const VIS = () => Sync.profiles;
const P = () => { const v = VIS(); if (!v.includes(S.ui.profile)) S.ui.profile = v[0] || ""; return S.ui.profile; };
const plan = (p = P()) => S.plans[p] || { week: "", rule: "", days: [] };

/* ---------- общие элементы ---------- */
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function openSheet(html) { $("#sheet").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeSheet() { $("#modal").classList.add("hidden"); $("#sheet").innerHTML = ""; }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeSheet(); });

function renderProfiles() {
  P();
  const vis = VIS(), admin = Sync.isAdmin;
  $("#profiles").classList.toggle("single", !admin);
  $("#profiles").innerHTML = !vis.length
    ? `<div class="brand">Тренер</div>`
    : !admin ? `<div class="brand">${esc(S.names[vis[0]] || "Мой дневник")}</div>`
    : vis.map(p => `<button data-act="profile" data-p="${p}" class="${P() === p ? "on" : ""}">${esc(S.names[p] || "Без имени")}</button>`).join("");
  $("#tabCoach").classList.toggle("hidden", !admin);
  if (!admin && S.ui.tab === "coach") S.ui.tab = "today";
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === S.ui.tab));
}

function render() {
  renderProfiles();
  const v = $("#view");
  ({ today: viewToday, history: viewHistory, measures: viewMeasures, more: viewMore, coach: viewCoach })[S.ui.tab](v);
  syncTimer();
}
function noClient(v) {
  v.innerHTML = Sync.isAdmin
    ? `<div class="empty">Клиентов пока нет.<br><br><button class="btn" data-tab="coach">Добавить клиента</button></div>`
    : `<div class="empty">Подключаемся…</div>`;
}

/* ---------- черновик тренировки ---------- */
function setFieldsFor(type) {
  return type === "wr" ? { w: "", r: "", rir: "" }
    : type === "r" ? { r: "", rir: "" }
    : type === "t" ? { t: "" }
    : { min: "", km: "", lvl: "" };
}
function newDraft(day) {
  return {
    dayId: day.id, dayTitle: `${day.label} — ${day.title}`, date: todayISO(),
    ex: day.exercises.map(e => ({
      name: e.name, type: e.type, target: e.reps, weight: e.weight || "", rest: e.rest, hint: e.hint || "", test: !!e.test, note: "",
      sets: Array.from({ length: Math.max(1, e.sets || 1) }, () => ({ ...setFieldsFor(e.type), done: false }))
    }))
  };
}
function draftHasData(d) {
  return d && d.ex.some(e => e.note || e.sets.some(s => s.done || Object.entries(s).some(([k, v]) => k !== "done" && v !== "")));
}
function currentDay() {
  const days = plan().days;
  if (!days.length) return null;
  const draft = S.drafts[P()];
  const id = draft?.dayId || S.ui.day[P()] || days[0].id;
  return days.find(d => d.id === id) || days[0];
}
function getDraft() {
  const day = currentDay(); if (!day) return null;
  let d = S.drafts[P()];
  if (!d || d.dayId !== day.id) { d = newDraft(day); S.drafts[P()] = d; save(); }
  return d;
}

function lastResult(name, profile = P()) {
  const s = S.sessions.filter(s => s.profile === profile).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  for (const ses of s) { const e = ses.ex.find(x => x.name === name); if (e && e.sets.length) return { date: ses.date, text: setsText(e) }; }
  return null;
}
function setText(type, s) {
  const extra = [];
  if (s.rir !== "" && s.rir != null && (type === "wr" || type === "r")) extra.push(`зап ${s.rir}`);
  if (s.rest !== "" && s.rest != null) extra.push(`отдых ${fmtSec(s.rest)}`);
  const tail = extra.length ? ` (${extra.join(", ")})` : "";
  if (type === "wr") return `${numStr(s.w) || 0}×${s.r || "?"}${tail}`;
  if (type === "r") return `${s.r || "?"}${tail}`;
  if (type === "t") return fmtSec(s.t) + tail;
  const parts = [];
  if (s.min !== "") parts.push(`${numStr(s.min)} мин`);
  if (s.km !== "") parts.push(`${numStr(s.km)} км`);
  if (s.lvl !== "") parts.push(`ур. ${s.lvl}`);
  return parts.join(", ") || "—";
}
function setsText(e) { return e.sets.map(s => setText(e.type, s)).join(", "); }

/* ---------- Сегодня ---------- */
function field(i, j, k, val, unit, mode = "decimal", ph = "") {
  return `<div class="field"><input inputmode="${mode}" data-i="${i}" data-j="${j}" data-k="${k}" value="${esc(numStr(val))}" placeholder="${esc(ph)}"><i>${unit}</i></div>`;
}
function setRow(e, i, s, j) {
  let f = "";
  if (e.type === "wr") f = field(i, j, "w", s.w, "кг", "decimal", String(e.weight || "").split(/[–-]/)[0]) + `<span class="x">×</span>` + field(i, j, "r", s.r, "раз", "numeric");
  else if (e.type === "r") f = field(i, j, "r", s.r, "раз", "numeric");
  else if (e.type === "t") f = field(i, j, "t", s.t, "сек", "numeric");
  else f = field(i, j, "min", s.min, "мин") + field(i, j, "km", s.km, "км") + field(i, j, "lvl", s.lvl, "ур", "numeric");
  const rir = (e.type === "wr" || e.type === "r")
    ? `<select data-i="${i}" data-j="${j}" data-k="rir" aria-label="Запас повторов"><option value="" ${s.rir === "" || s.rir == null ? "selected" : ""}>запас?</option>${RIR.slice(1).map(r => `<option value="${r}" ${String(s.rir) === r ? "selected" : ""}>${RIR_LABEL[r]}</option>`).join("")}</select>`
    : `<span></span>`;
  const running = !!s.restStart;
  const restLine = running
    ? `<div class="rest-line live" id="rest${i}_${j}">⏱ отдых ${fmtSec((Date.now() - s.restStart) / 1000)} — нажми ещё раз, когда начнёшь следующий подход</div>`
    : (s.rest !== "" && s.rest != null ? `<div class="rest-line">отдых ${fmtSec(s.rest)}</div>` : "");
  const label = running ? "Зафиксировать отдых" : s.done ? "Подход выполнен" : "Отметить подход";
  return `<div class="set ${s.done ? "done" : ""}"><span class="n">${j + 1}</span><div class="fields">${f}</div>${rir}<button class="check ${running ? "running" : ""}" data-act="done" data-i="${i}" data-j="${j}" aria-label="${label}">${running ? "⏱" : "✓"}</button></div>${restLine}`;
}
function viewToday(v) {
  if (!P()) { noClient(v); return; }
  const pl = plan();
  if (!pl.days.length) {
    v.innerHTML = Sync.isAdmin
      ? `<div class="empty">У «${esc(S.names[P()])}» пока нет плана.<br><br><button class="btn" data-act="coach-open" data-id="${P()}">Составить план</button></div>`
      : `<div class="empty">Тренер ещё не составил вам план.<br>Загляните чуть позже 🙂</div>`;
    return;
  }
  const day = currentDay(), d = getDraft();
  const doneSets = d.ex.reduce((a, e) => a + e.sets.filter(s => s.done).length, 0);
  const allSets = d.ex.reduce((a, e) => a + e.sets.length, 0);
  v.innerHTML = `
    <h1>${esc(day.title)}</h1>
    <p class="sub">${esc(pl.week)} · <span class="num">${doneSets}/${allSets}</span> подходов</p>
    <div class="days">${pl.days.map(x => `<button data-act="day" data-id="${x.id}" class="${x.id === day.id ? "on" : ""}"><b>${esc(x.label)}</b><span>${esc(x.title)}</span></button>`).join("")}</div>
    ${pl.rule ? `<div class="rule">${esc(pl.rule)}<br><b>Запас</b> — сколько повторов ещё могли бы сделать после подхода (0 = отказ).</div>` : ""}
    ${d.ex.map((e, i) => {
      const prev = lastResult(e.name);
      const complete = e.sets.length && e.sets.every(s => s.done);
      return `<section class="ex ${complete ? "complete" : ""}">
        <div class="ex-head">
          <div class="ex-title"><b>${esc(e.name)}</b><small>${e.sets.length} × ${esc(e.target)}${e.weight ? ` · ${esc(e.weight)} кг` : ""}${e.rest ? ` · отдых ${fmtSec(e.rest)}` : ""}</small></div>
          ${e.test ? `<span class="badge">ТЕСТ</span>` : ""}
        </div>
        ${prev ? `<div class="prev">Прошлый раз (${ruDate(prev.date)}): <b>${esc(prev.text)}</b></div>` : ""}
        ${e.hint ? `<button class="hint-btn" data-act="hint" data-i="${i}">Подсказка ▾</button><div class="hint hidden" id="hint${i}">${esc(e.hint)}</div>` : ""}
        <div class="sets">${e.sets.map((s, j) => setRow(e, i, s, j)).join("")}</div>
        <div class="ex-foot">
          <button class="link" data-act="addset" data-i="${i}">+ подход</button>
          ${e.sets.length > 1 ? `<button class="link muted" data-act="delset" data-i="${i}">− подход</button>` : ""}
          <button class="link muted" data-act="note" data-i="${i}">${e.note ? "Заметка ✎" : "+ заметка"}</button>
        </div>
        <textarea data-i="${i}" data-k="note" placeholder="Заметка: ощущения, техника, боль…" class="${e.note ? "" : "hidden"}" id="note${i}">${esc(e.note)}</textarea>
      </section>`;
    }).join("")}
    <label class="sub" style="display:block;margin:8px 0 6px">Дата тренировки</label>
    <div class="form" style="grid-template-columns:1fr;margin-bottom:14px"><input type="date" data-k="date" value="${d.date}"></div>
    <button class="btn" data-act="finish">Завершить тренировку</button>
    <button class="btn ghost" data-act="reset">Очистить</button>`;
}

/* ---------- таймер отдыха ---------- */
let timerEnd = 0, timerInt = null, audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0, .25, .5].forEach(t => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(.25, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + t + .2);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + .2);
    });
  } catch {}
  navigator.vibrate?.([300, 150, 300]);
}
/* Отдых: 1-е нажатие ✓ — подход выполнен, пошёл отсчёт отдыха; 2-е — отдых зафиксирован (s.rest, сек). */
let beepedFor = 0;
function runningRest(d) {
  if (!d) return null;
  for (let i = 0; i < d.ex.length; i++) for (let j = 0; j < d.ex[i].sets.length; j++) {
    const s = d.ex[i].sets[j]; if (s.restStart) return { i, j, s };
  }
  return null;
}
function fixRest(d, discard) {
  const r = runningRest(d); if (!r) return null;
  if (!discard) r.s.rest = Math.max(0, Math.round((Date.now() - r.s.restStart) / 1000));
  delete r.s.restStart;
  return r;
}
function startTimer() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch {}
  $("#timer").classList.remove("hidden"); document.body.classList.add("timer-on");
  clearInterval(timerInt); timerInt = setInterval(tick, 250); tick();
}
function tick() {
  const d = S.drafts[P()], r = runningRest(d);
  if (!r) { stopTimer(); return; }
  const el = Math.floor((Date.now() - r.s.restStart) / 1000), goal = d.restTarget || 0;
  $("#timerTime").textContent = fmtSec(el);
  $("#timerGoal").textContent = goal ? "цель " + fmtSec(goal) : "";
  const over = goal && el >= goal;
  $("#timer").classList.toggle("over", !!over);
  if (over && beepedFor !== r.s.restStart) { beepedFor = r.s.restStart; beep(); }
  const ln = document.getElementById(`rest${r.i}_${r.j}`);
  if (ln) ln.firstChild.textContent = `⏱ отдых ${fmtSec(el)} — нажми ещё раз, когда начнёшь следующий подход`;
}
function stopTimer() { clearInterval(timerInt); timerInt = null; $("#timer").classList.add("hidden"); document.body.classList.remove("timer-on"); }
function syncTimer() { runningRest(S.drafts[P()]) ? (timerInt || startTimer()) : stopTimer(); }

/* ---------- История ---------- */
function viewHistory(v) {
  if (!P()) { noClient(v); return; }
  const list = S.sessions.filter(s => s.profile === P()).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  v.innerHTML = `<h1>История</h1><p class="sub">${esc(S.names[P()])} · тренировок: ${list.length}</p>` +
    (list.length ? list.map(s => `<div class="card">
      <div class="card-head"><b>${esc(s.dayTitle)}</b><span>${ruDate(s.date)}</span></div>
      <ul class="lines">${s.ex.map(e => `<li><span class="nm">${esc(e.name)}:</span> ${esc(setsText(e))}${e.note ? ` — <i>${esc(e.note)}</i>` : ""}</li>`).join("")}</ul>
      ${s.feel ? `<div class="prev">Самочувствие: <b>${s.feel}/10</b></div>` : ""}
      ${s.note ? `<div class="prev">${esc(s.note)}</div>` : ""}
      <div class="ex-foot"><button class="link muted" data-act="edit-session" data-id="${s.id}">Открыть для правки</button><button class="link muted" data-act="del-session" data-id="${s.id}">Удалить</button></div>
    </div>`).join("") : `<div class="empty">Пока пусто. Завершённые тренировки появятся здесь.</div>`);
}

/* ---------- Замеры ---------- */
function viewMeasures(v) {
  if (!P()) { noClient(v); return; }
  const list = S.measures.filter(m => m.profile === P()).sort((a, b) => b.date.localeCompare(a.date));
  v.innerHTML = `<h1>Замеры</h1><p class="sub">Вес — утром натощак. Талия — на уровне пупка.</p>
    <div class="card"><div class="form">
      <label class="full">Дата<input type="date" id="mDate" value="${todayISO()}"></label>
      <label>Вес, кг<input id="mWeight" inputmode="decimal" placeholder="—"></label>
      <label>Талия, см<input id="mWaist" inputmode="decimal" placeholder="—"></label>
      <label class="full">Другое<input id="mNote" placeholder="бёдра, грудь, фото…"></label>
    </div><button class="btn" style="margin-top:12px" data-act="add-measure">Сохранить замер</button></div>
    ${list.length ? `<table class="m"><tr><th>Дата</th><th>Вес</th><th>Талия</th><th>Другое</th><th></th></tr>${list.map(m =>
      `<tr><td>${ruDate(m.date)}</td><td>${numStr(m.weight) || "—"}</td><td>${numStr(m.waist) || "—"}</td><td>${esc(m.note || "")}</td><td><button class="link muted" data-act="del-measure" data-id="${m.id}">✕</button></td></tr>`).join("")}</table>` : ""}`;
}

/* ---------- Ещё ---------- */
function viewMore(v) {
  const admin = Sync.isAdmin, has = !!P();
  v.innerHTML = `<h1>Выгрузка и настройки</h1>
  <div class="menu">
    ${has ? `<h2>Дневник</h2>
    <button class="btn" data-act="export-md">Выгрузить дневник (.md) — ${esc(S.names[P()])}</button>
    ${admin && VIS().length > 1 ? `<button class="btn ghost" data-act="export-md-all">Выгрузить дневник (.md) — все клиенты</button>` : ""}
    <p>Файл в формате, который Claude читает напрямую. Прикрепите его в чат.</p>
    <button class="btn ghost" data-act="export-xlsx">Выгрузить в Excel (.xlsx)</button>
    <p>Все тренировки и замеры${admin && VIS().length > 1 ? " всех клиентов" : ""}, по подходам.</p>` : ""}
    ${admin && has ? `<button class="btn ghost" data-act="import-plan">Загрузить план из файла (.json)</button>
    <p>Для планов, которые присылает Claude. Обычно план удобнее составить во вкладке «Тренер».</p>` : ""}

    ${Sync.section()}

    <h2>Резервная копия</h2>
    <div class="row"><button class="btn ghost" data-act="backup">Сохранить копию</button><button class="btn ghost" data-act="restore">Восстановить</button></div>
    <p>Данные хранятся в этом браузере${Sync.on ? " и в зашифрованном облаке" : ""}. Копия в файл — дополнительная страховка.</p>
    <h2>&nbsp;</h2>
    <button class="btn danger" data-act="wipe">Удалить все данные на этом устройстве</button>
  </div>`;
}

/* ---------- экспорт ---------- */
function stamp() { const d = new Date(); return todayISO() + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0"); }
async function deliver(filename, blob) {
  const file = new File([blob], filename, { type: blob.type });
  const mobile = matchMedia("(pointer:coarse)").matches;
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function mdFor(p) {
  const name = S.names[p], pl = plan(p);
  const ses = S.sessions.filter(s => s.profile === p).sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
  const ms = S.measures.filter(m => m.profile === p).sort((a, b) => b.date.localeCompare(a.date));
  let md = `# Дневник из приложения — ${name}\n\n_Выгружено: ${ruDate(todayISO())} ${new Date().toTimeString().slice(0, 5)} · план: ${pl.week}_\n\n`;
  md += `> **Для Claude:** выгрузка из приложения «Тренер». Подключи скилл \`personal-trainer\` и перенеси эти результаты в дневник в \`C:\\Тренировки\`.\n\n`;
  md += `Обозначения: «60×8 (зап 2, отдых 2:15)» — 60 кг на 8 повторов, 2 повтора в запасе, отдых после подхода 2 мин 15 сек. Время — мин:сек.\n\n`;
  md += `## Журнал тренировок\n\n`;
  md += ses.length ? ses.map(s => {
    let t = `### ${ruDate(s.date)} — ${s.dayTitle}\n`;
    s.ex.forEach(e => { t += `- ${e.name}: ${setsText(e)}${e.note ? ` — ${e.note}` : ""}\n`; });
    if (s.feel) t += `- Самочувствие (1–10): ${s.feel}\n`;
    if (s.note) t += `- Заметки: ${s.note}\n`;
    return t;
  }).join("\n") : "_Тренировок пока нет._\n";
  md += `\n## Замеры\n\n| Дата | Вес | Талия | Другое |\n|---|---|---|---|\n`;
  md += ms.length ? ms.map(m => `| ${ruDate(m.date)} | ${numStr(m.weight) || "—"} | ${numStr(m.waist) || "—"} | ${(m.note || "—").replace(/\|/g, "/")} |`).join("\n") + "\n" : "| — | — | — | — |\n";
  return md;
}
function exportMd(all) {
  const ps = all ? VIS() : [P()];
  const md = ps.map(mdFor).join("\n\n---\n\n");
  const fname = all ? `дневник_все_${stamp()}.md` : `дневник_${S.names[P()]}_${stamp()}.md`;
  deliver(fname.replace(/[\\/:*?"<>|\s]+/g, "_"), new Blob([md], { type: "text/markdown" }));
}
function loadXlsx() {
  return window.XLSX ? Promise.resolve() : new Promise((ok, no) => {
    const s = document.createElement("script"); s.src = "vendor/xlsx.full.min.js"; s.onload = ok; s.onerror = () => no(new Error("не загрузилась библиотека Excel"));
    document.head.appendChild(s);
  });
}
async function exportXlsx() {
  try { await loadXlsx(); } catch (e) { toast(e.message); return; }
  const rows = [];
  const vis = VIS();
  [...S.sessions].filter(s => vis.includes(s.profile)).sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts).forEach(s => s.ex.forEach(e => e.sets.forEach((x, j) => rows.push({
    "Профиль": S.names[s.profile], "Дата": ruDate(s.date), "Тренировка": s.dayTitle, "Упражнение": e.name, "Подход": j + 1,
    "Вес, кг": x.w ?? "", "Повторы": x.r ?? "", "Запас": x.rir ?? "", "Время, сек": x.t ?? "", "Отдых, сек": x.rest ?? "",
    "Минуты": x.min ?? "", "Км": x.km ?? "", "Уровень": x.lvl ?? "", "Заметка": j === 0 ? e.note : ""
  }))));
  const sess = [...S.sessions].filter(s => vis.includes(s.profile)).sort((a, b) => a.date.localeCompare(b.date)).map(s => ({
    "Профиль": S.names[s.profile], "Дата": ruDate(s.date), "Тренировка": s.dayTitle, "Самочувствие": s.feel || "", "Заметки": s.note || ""
  }));
  const ms = [...S.measures].filter(m => vis.includes(m.profile)).sort((a, b) => a.date.localeCompare(b.date)).map(m => ({
    "Профиль": S.names[m.profile], "Дата": ruDate(m.date), "Вес, кг": m.weight, "Талия, см": m.waist, "Другое": m.note || ""
  }));
  const wb = XLSX.utils.book_new();
  const add = (data, name, widths) => {
    const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ "Нет данных": "" }]);
    ws["!cols"] = widths.map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(rows, "Подходы", [10, 11, 26, 30, 7, 8, 9, 7, 10, 8, 6, 8, 30]);
  add(sess, "Тренировки", [10, 11, 30, 13, 40]);
  add(ms, "Замеры", [10, 11, 9, 10, 30]);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  deliver(`тренировки_${stamp()}.xlsx`, new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

/* ---------- импорт ---------- */
let fileMode = "";
function pickFile(mode) { fileMode = mode; const f = $("#fileInput"); f.value = ""; f.click(); }
$("#fileInput").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("Это не JSON-файл"); return; }
  if (fileMode === "plan") importPlan(data); else restoreBackup(data);
});
function validDay(d) {
  return d && d.id && d.title && Array.isArray(d.exercises) && d.exercises.every(e => e.name && ["wr", "r", "t", "cardio"].includes(e.type));
}
function importPlan(data) {
  const plans = data.plans || data;
  const got = Object.keys(plans).filter(p => S.names[p] && !S.meta.deletedClients[p] && plans[p]);
  if (!got.length || !got.every(p => Array.isArray(plans[p].days) && plans[p].days.every(validDay))) { toast("Файл плана не подходит"); return; }
  got.forEach(p => {
    const old = S.drafts[p];
    if (old && !plans[p].days.some(d => d.id === old.dayId)) delete S.drafts[p];
    S.plans[p] = plans[p]; delete S.ui.day[p]; S.meta.plansTs[p] = Date.now();
  });
  save(true); render(); changed();
  toast("План обновлён: " + got.map(p => S.names[p]).join(", "));
}
function backup() {
  const data = { app: "trainer", version: 1, exported: new Date().toISOString(), ...S, ui: undefined };
  deliver(`trainer_backup_${stamp()}.json`, new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
}
function restoreBackup(data) {
  if (data.app !== "trainer" || !Array.isArray(data.sessions)) { toast("Это не резервная копия Тренера"); return; }
  if (!confirm(`Заменить текущие данные копией от ${new Date(data.exported).toLocaleString("ru")}?`)) return;
  const ui = S.ui;
  S = normalize(Object.assign(blank(), data, { ui })); delete S.app; delete S.version; delete S.exported;
  save(true); render(); changed(); toast("Данные восстановлены");
}

/* ---------- завершение тренировки ---------- */
let feel = 0;
function finishSheet() {
  const d = getDraft();
  if (!draftHasData(d)) { toast("Пока ничего не записано"); return; }
  feel = 0;
  openSheet(`<h3>Завершить тренировку</h3>
    <div class="sub">Самочувствие (1 — ужасно, 10 — отлично)</div>
    <div class="scale">${Array.from({ length: 10 }, (_, i) => `<button data-act="feel" data-v="${i + 1}">${i + 1}</button>`).join("")}</div>
    <textarea id="sesNote" placeholder="Общие заметки: сон, настроение, что болело…"></textarea>
    <div class="row" style="margin-top:12px"><button class="btn ghost" data-act="close">Отмена</button><button class="btn" data-act="save-session">Сохранить</button></div>`);
}
function saveSession() {
  const d = getDraft();
  fixRest(d, true);   // отдых после последнего подхода не считаем
  const clean = (type, s) => { const o = {}; Object.keys(setFieldsFor(type)).forEach(k => o[k] = s[k] ?? ""); if (s.rest !== "" && s.rest != null) o.rest = s.rest; return o; };
  const ex = d.ex.map(e => ({
    name: e.name, type: e.type, note: e.note.trim(),
    sets: e.sets.filter(s => s.done || Object.entries(s).some(([k, v]) => !["done", "rir", "rest", "restStart"].includes(k) && v !== "" && v != null)).map(s => clean(e.type, s))
  })).filter(e => e.sets.length || e.note);
  const ses = { id: d.editId || uid(), ts: Date.now(), profile: P(), date: d.date, dayId: d.dayId, dayTitle: d.dayTitle, ex, feel, note: ($("#sesNote")?.value || "").trim() };
  if (d.editId) S.sessions = S.sessions.filter(s => s.id !== d.editId);
  S.sessions.push(ses);
  delete S.drafts[P()];
  save(true); closeSheet(); stopTimer();
  S.ui.tab = "history"; render(); changed();
  toast("Тренировка сохранена 💪");
}
function editSession(id) {
  const s = S.sessions.find(x => x.id === id); if (!s) return;
  if (draftHasData(S.drafts[P()]) && !confirm("Текущая незавершённая тренировка будет заменена. Продолжить?")) return;
  const day = plan().days.find(d => d.id === s.dayId);
  S.drafts[P()] = {
    dayId: s.dayId, dayTitle: s.dayTitle, date: s.date, editId: s.id,
    ex: s.ex.map(e => {
      const pe = day?.exercises.find(x => x.name === e.name) || {};
      return { name: e.name, type: e.type, target: pe.reps || "", rest: pe.rest || 0, hint: pe.hint || "", test: !!pe.test, note: e.note || "", sets: e.sets.map(x => ({ ...x, done: true })) };
    })
  };
  if (!day) { toast("Этого дня нет в текущем плане — правка невозможна"); delete S.drafts[P()]; return; }
  S.ui.day[P()] = s.dayId; S.ui.tab = "today"; save(); render();
  toast("Тренировка открыта для правки — затем «Завершить»");
}

/* ---------- обработчики ---------- */
document.addEventListener("click", e => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    if (S.ui.tab === "coach" && tab.dataset.tab !== "coach" && !Coach.leave()) return;
    S.ui.tab = tab.dataset.tab; save(); render(); scrollTo(0, 0); return;
  }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, i = +b.dataset.i, j = +b.dataset.j;
  const d = S.drafts[P()];
  switch (act) {
    case "profile": S.ui.profile = b.dataset.p; save(); render(); break;
    case "coach-open": S.ui.tab = "coach"; S.ui.coach = { view: "client", id: b.dataset.id }; save(); render(); scrollTo(0, 0); break;
    case "day": {
      if (draftHasData(d) && d.dayId !== b.dataset.id && !confirm("Есть незавершённая тренировка. Переключить день? Записанное будет потеряно.")) return;
      if (d?.dayId !== b.dataset.id) delete S.drafts[P()];
      S.ui.day[P()] = b.dataset.id; save(); render(); break;
    }
    case "hint": $("#hint" + i).classList.toggle("hidden"); break;
    case "note": { const t = $("#note" + i); t.classList.remove("hidden"); t.focus(); break; }
    case "done": {
      const ex = d.ex[i], s = ex.sets[j];
      if (s.restStart) { fixRest(d); save(); render(); toast(`Отдых ${fmtSec(s.rest)} записан`); break; }   // 2-е нажатие
      if (s.done) {                                                                                         // снять отметку
        if (!confirm("Снять отметку с этого подхода?")) break;
        s.done = false; s.rest = ""; save(); render(); break;
      }
      fixRest(d);                                // если у другого подхода отдых не зафиксировали — фиксируем сейчас
      s.done = true;
      const prev = j > 0 ? ex.sets[j - 1] : null;
      if (prev) Object.keys(s).forEach(k => { if (!["done", "rir", "rest", "restStart"].includes(k) && s[k] === "" && prev[k] !== "" && prev[k] != null) s[k] = prev[k]; });
      if (ex.rest) { s.restStart = Date.now(); d.restTarget = ex.rest; }
      save(); render(); break;
    }
    case "rest-fix": { const r = fixRest(d); save(); render(); if (r) toast(`Отдых ${fmtSec(r.s.rest)} записан`); break; }
    case "addset": { const ex = d.ex[i]; const last = ex.sets[ex.sets.length - 1]; const n = { ...setFieldsFor(ex.type), done: false }; if (last) Object.keys(n).forEach(k => { if (k !== "done" && k !== "rir" && k !== "r") n[k] = last[k] ?? ""; }); ex.sets.push(n); save(); render(); break; }
    case "delset": d.ex[i].sets.pop(); save(); render(); break;
    case "finish": finishSheet(); break;
    case "reset": if (confirm("Очистить все записи текущей тренировки?")) { delete S.drafts[P()]; save(); render(); } break;
    case "feel": feel = +b.dataset.v; document.querySelectorAll(".scale button").forEach(x => x.classList.toggle("on", +x.dataset.v === feel)); break;
    case "save-session": saveSession(); break;
    case "close": closeSheet(); break;
    case "timer-plus": if (d) { d.restTarget = (d.restTarget || 0) + 15; save(); tick(); } break;
    case "timer-minus": if (d) { d.restTarget = Math.max(0, (d.restTarget || 0) - 15); save(); tick(); } break;
    case "timer-stop": { const r = fixRest(d); save(); render(); if (r) toast(`Отдых ${fmtSec(r.s.rest)} записан`); break; }
    case "del-session": if (confirm("Удалить эту тренировку?")) { S.deleted[b.dataset.id] = Date.now(); S.sessions = S.sessions.filter(s => s.id !== b.dataset.id); save(); render(); changed(); } break;
    case "edit-session": editSession(b.dataset.id); break;
    case "add-measure": {
      const w = toNum($("#mWeight").value), wa = toNum($("#mWaist").value), note = $("#mNote").value.trim();
      if (w === "" && wa === "" && !note) { toast("Заполните хотя бы одно поле"); return; }
      S.measures.push({ id: uid(), ts: Date.now(), profile: P(), date: $("#mDate").value || todayISO(), weight: w, waist: wa, note });
      save(true); render(); changed(); toast("Замер сохранён"); break;
    }
    case "del-measure": if (confirm("Удалить замер?")) { S.deleted[b.dataset.id] = Date.now(); S.measures = S.measures.filter(m => m.id !== b.dataset.id); save(); render(); changed(); } break;
    case "export-md": exportMd(false); break;
    case "export-md-all": exportMd(true); break;
    case "export-xlsx": exportXlsx(); break;
    case "import-plan": pickFile("plan"); break;
    case "backup": backup(); break;
    case "restore": pickFile("restore"); break;
    case "sync-create": case "sync-connect": case "sync-now": case "sync-code": case "sync-copy": case "sync-share": case "sync-off": Sync.handle(act, b); break;
    case "wipe":
      if (confirm("Удалить ВСЕ тренировки, замеры и планы на этом устройстве?") && confirm("Точно? Это нельзя отменить.")) {
        S = blank(); save(true); render(); toast("Данные удалены");
      }
      break;
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  const d = S.drafts[P()]; if (!d) return;
  if (t.dataset.k === "date") { d.date = t.value || todayISO(); save(); return; }
  if (t.dataset.k === "note") { d.ex[+t.dataset.i].note = t.value; save(); return; }
  if (t.dataset.j !== undefined) {
    const k = t.dataset.k, s = d.ex[+t.dataset.i].sets[+t.dataset.j];
    s[k] = k === "rir" ? t.value : toNum(t.value);
    save();
  }
});

// старт — после загрузки всех скриптов (coach.js подключается последним)
document.addEventListener("DOMContentLoaded", () => { render(); Sync.syncNow(false); });
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
