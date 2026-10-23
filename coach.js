"use strict";
/* Вкладка «Тренер»: список клиентов, карточка клиента (ссылка, дневник, редактор плана), библиотека упражнений.
   Видна только на устройстве тренера (Sync.isAdmin). План правится в рабочей копии (edit) и уходит клиенту по «Сохранить план». */

const Coach = (() => {
  const TYPES = { wr: "Вес × повторы", r: "Повторы", t: "Время, сек", cardio: "Кардио" };
  const RESTS = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300];
  const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const clone = o => JSON.parse(JSON.stringify(o));
  let edit = null;   // { id, plan, dirty }

  /* ---- библиотека ---- */
  const GROUPS = ["Ноги", "Ягодицы", "Спина", "Грудь", "Плечи", "Руки", "Пресс и кор", "Кардио", "Другое"];
  const norm = t => String(t || "").toLowerCase().replace(/ё/g, "е");
  function guessGroup(name) {
    const n = norm(name);
    if (/кардио|эллипс|велотрен|дорожк|гребл|бег|скакалк/.test(n)) return "Кардио";
    if (/планк|пресс|скручив|подъем ног|вакуум/.test(n)) return "Пресс и кор";
    if (/ягодичн|мост|отведени|гиперэкст|кикбек/.test(n)) return "Ягодицы";
    if (/жим ног|присед|выпад|разгибани.*ног|сгибани.*ног|болгар|гакк|икр|носки|румынск|степ/.test(n)) return "Ноги";
    if (/тяга|подтяг|становая|вис на|пуловер|шраг/.test(n)) return "Спина";
    if (/леж|отжим|брус|развод|грудь|кроссовер|бабочк/.test(n)) return "Грудь";
    if (/сидя|стоя|мах|плеч|армейск|арнольд/.test(n)) return "Плечи";
    if (/бицепс|трицепс|молот|французск|сгибани.*рук|разгибани.*рук/.test(n)) return "Руки";
    return "Другое";
  }
  function migrateGroups() {
    let hit = false;
    S.library.forEach(x => { if (!x.group) { x.group = guessGroup(x.name); hit = true; } });
    if (hit) save();
  }
  function seedLibrary() {
    migrateGroups();
    if (S.library.length || S.meta.librarySeeded) return;
    const seen = new Set();
    Object.values(window.DEFAULT_PLANS).forEach(pl => pl.days.forEach(d => d.exercises.forEach(e => {
      if (e.name.includes(" — ") || seen.has(e.name.toLowerCase())) return;
      seen.add(e.name.toLowerCase());
      S.library.push({ name: e.name, type: e.type, rest: e.rest || 0, hint: e.hint || "", group: guessGroup(e.name) });
    })));
    S.meta.librarySeeded = 1; save();
  }
  const libFind = name => S.library.find(x => x.name.trim().toLowerCase() === String(name).trim().toLowerCase());
  function libTouch() { S.meta.libraryTs = Date.now(); save(); changed(); fillDatalist(); }
  function fillDatalist() {
    const dl = document.getElementById("libList");
    if (dl) dl.innerHTML = S.library.map(x => `<option value="${esc(x.name)}"></option>`).join("");
  }

  /* ---- помощники ---- */
  const clients = () => Object.keys(S.names).filter(id => !S.meta.deletedClients[id]);
  function stats(id) {
    const ses = S.sessions.filter(s => s.profile === id).sort((a, b) => b.date.localeCompare(a.date));
    const last = ses[0]?.date || "";
    const days = last ? Math.floor((Date.now() - new Date(last + "T12:00").getTime()) / 864e5) : null;
    return { count: ses.length, last, days };
  }
  function startEdit(id) {
    if (!edit || edit.id !== id) edit = { id, plan: clone(S.plans[id] || { week: "", rule: "", days: [] }), dirty: false };
  }
  function leave() {
    if (edit?.dirty && !confirm("План изменён, но не сохранён. Выйти без сохранения?")) return false;
    edit = null; dirtyBar(); return true;
  }
  function dirtyBar() {
    const bar = document.getElementById("saveBar");
    const on = !!edit?.dirty && S.ui.tab === "coach" && S.ui.coach.view === "client";
    if (bar) bar.classList.toggle("hidden", !on);
    document.body.classList.toggle("savebar-on", on);
  }
  function markDirty() { if (edit) { edit.dirty = true; dirtyBar(); } }

  /* ---- экраны ---- */
  function view(v) {
    seedLibrary(); fillDatalist();
    const c = S.ui.coach;
    if (c.view === "client" && S.names[c.id] && !S.meta.deletedClients[c.id]) viewClient(v, c.id);
    else if (c.view === "library") viewLibrary(v);
    else { S.ui.coach = { view: "list", id: "" }; viewList(v); }
    dirtyBar();
  }

  function viewList(v) {
    const list = clients().map(id => ({ id, ...stats(id) }))
      .sort((a, b) => (b.last || "").localeCompare(a.last || "") || S.names[a.id].localeCompare(S.names[b.id]));
    v.innerHTML = `
      <h1>Клиенты</h1>
      <p class="sub">${list.length ? `${list.length} ${plural(list.length, "клиент", "клиента", "клиентов")}` : "Добавьте первого клиента"}</p>
      ${!Sync.on ? `<div class="rule">Чтобы отправлять клиентам ссылки и видеть их тренировки, подключите синхронизацию: вкладка «Ещё» → «Синхронизация».</div>` : ""}
      <div class="card">
        <div class="form" style="grid-template-columns:1fr auto;align-items:end">
          <label>Новый клиент<input id="newClientName" placeholder="Имя, например «Иван»" autocomplete="off"></label>
          <button class="btn" style="width:auto;padding:11px 16px" data-c="new-client">Добавить</button>
        </div>
      </div>
      ${list.map(c => {
        const pl = S.plans[c.id];
        const stale = c.days != null && c.days > 7;
        return `<button class="card client-row" data-c="open" data-id="${c.id}">
          <div class="card-head"><b>${esc(S.names[c.id])}</b>${stale ? `<span class="badge">не был ${c.days} дн.</span>` : ""}</div>
          <div class="prev">${c.last ? `Последняя тренировка: <b>${ruDate(c.last)}</b> · всего ${c.count}` : "Ещё не тренировался"}</div>
          <div class="prev">${pl?.days?.length ? `План: ${esc(pl.week || "без названия")} · ${pl.days.length} ${plural(pl.days.length, "день", "дня", "дней")}` : `<span style="color:var(--test)">План не составлен</span>`}</div>
        </button>`;
      }).join("")}
      <h2>Библиотека упражнений</h2>
      <button class="btn ghost" data-c="library">Открыть библиотеку (${S.library.length})</button>
      <p class="sub" style="margin-top:6px">Упражнения с типом, отдыхом и подсказкой по технике — подставляются в план автоматически.</p>`;
  }

  function viewClient(v, id) {
    startEdit(id);
    const pl = edit.plan, st = stats(id), others = clients().filter(x => x !== id && S.plans[x]?.days?.length);
    v.innerHTML = `
      <button class="link" data-c="back">← Все клиенты</button>
      <h1>${esc(S.names[id])}</h1>
      <p class="sub">${st.last ? `Последняя тренировка ${ruDate(st.last)} · всего ${st.count}` : "Ещё не тренировался"}</p>

      <div class="card">
        <div class="form" style="grid-template-columns:1fr"><label>Имя клиента<input data-cname="${id}" value="${esc(S.names[id])}"></label></div>
        <button class="btn" style="margin-top:10px" data-c="link" data-id="${id}">Ссылка для клиента</button>
        <div id="linkBox" class="hidden" style="margin-top:10px">
          <div class="sub" style="margin:0 0 6px">Клиент откроет ссылку и сразу увидит свой план и дневник. Другие клиенты ему не видны. На iPhone — открыть в Safari, затем «На экран „Домой“».</div>
          <textarea id="linkText" readonly style="min-height:80px;font-size:12px;word-break:break-all"></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn ghost" data-c="copy-link">Скопировать</button>
            ${navigator.share ? `<button class="btn ghost" data-c="share-link">Отправить…</button>` : ""}
          </div>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn ghost" data-c="diary" data-id="${id}">Дневник</button>
          <button class="btn ghost" data-c="log" data-id="${id}">Записать за него</button>
        </div>
      </div>

      <h2>План тренировок</h2>
      <div class="card">
        <div class="form" style="grid-template-columns:1fr">
          <label>Название плана<input data-ce="week" value="${esc(pl.week)}" placeholder="Например: Неделя 1 — втягивающая"></label>
          <label>Комментарий для клиента<textarea data-ce="rule" placeholder="Общие правила: отдых, разминка, на что обратить внимание">${esc(pl.rule)}</textarea></label>
        </div>
        ${others.length ? `<div class="form" style="grid-template-columns:1fr auto;align-items:end;margin-top:8px">
          <label>Скопировать план у клиента<select id="copyFrom">${others.map(x => `<option value="${x}">${esc(S.names[x])}</option>`).join("")}</select></label>
          <button class="btn ghost" style="width:auto;padding:11px 14px" data-c="copy-from">Взять</button></div>` : ""}
      </div>

      ${pl.days.map((d, di) => dayHtml(d, di, pl.days.length)).join("")}
      <button class="btn ghost" data-c="add-day">+ Тренировочный день</button>

      <div class="row" style="margin-top:16px">
        <button class="btn ghost" data-c="revert">Отменить правки</button>
        <button class="btn" data-c="save-plan">Сохранить план</button>
      </div>
      <p class="sub" style="margin-top:8px">После сохранения клиент увидит новый план при следующем открытии приложения.</p>

      <h2>&nbsp;</h2>
      <button class="btn danger" data-c="del-client" data-id="${id}">Удалить клиента</button>`;
  }

  function dayHtml(d, di, n) {
    return `<section class="ex pe-day">
      <div class="pe-dayhead">
        <select data-ce="day.label" data-di="${di}" aria-label="День недели">${DAYS.concat(DAYS.includes(d.label) ? [] : [d.label]).map(x => `<option ${x === d.label ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
        <input data-ce="day.title" data-di="${di}" value="${esc(d.title)}" placeholder="Название дня, например «Ноги и ягодицы»">
      </div>
      <div class="pe-tools">
        ${di > 0 ? `<button class="link muted" data-c="up-day" data-di="${di}">↑ выше</button>` : ""}
        ${di < n - 1 ? `<button class="link muted" data-c="down-day" data-di="${di}">↓ ниже</button>` : ""}
        <button class="link muted" data-c="del-day" data-di="${di}">✕ удалить день</button>
      </div>
      ${d.exercises.map((e, ei) => exHtml(e, di, ei, d.exercises.length)).join("")}
      <button class="link" data-c="add-ex" data-di="${di}">+ упражнение</button>
    </section>`;
  }
  function exHtml(e, di, ei, n) {
    const a = `data-di="${di}" data-ei="${ei}"`;
    return `<div class="pe-ex">
      <div class="pe-row1"><span class="n">${ei + 1}</span><input data-ce="ex.name" ${a} value="${esc(e.name)}" list="libList" placeholder="Упражнение (начните вводить)"><button class="pick-btn" data-c="pick-open" ${a} aria-label="Выбрать из библиотеки">📚</button></div>
      <div class="pe-grid">
        <label>Тип<select data-ce="ex.type" ${a}>${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${k === e.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label>Подходы<input data-ce="ex.sets" ${a} inputmode="numeric" value="${esc(e.sets)}"></label>
        <label>${e.type === "t" ? "Время" : e.type === "cardio" ? "Длительность" : "Повторы"}<input data-ce="ex.reps" ${a} value="${esc(e.reps)}" placeholder="${e.type === "t" ? "60 сек" : e.type === "cardio" ? "15 мин" : "10–12"}"></label>
        ${e.type === "wr" ? `<label>Вес, кг<input data-ce="ex.weight" ${a} inputmode="decimal" value="${esc(e.weight || "")}" placeholder="—"></label>` : `<span></span>`}
      </div>
      <div class="pe-grid2">
        <label>Отдых<select data-ce="ex.rest" ${a}>${RESTS.concat(RESTS.includes(+e.rest) ? [] : [+e.rest || 0]).map(r => `<option value="${r}" ${r === (+e.rest || 0) ? "selected" : ""}>${r ? fmtSec(r) : "без таймера"}</option>`).join("")}</select></label>
        <label class="pe-check"><input type="checkbox" data-ce="ex.test" ${a} ${e.test ? "checked" : ""}> Тест</label>
      </div>
      <input data-ce="ex.hint" ${a} value="${esc(e.hint || "")}" placeholder="Подсказка по технике (необязательно)" class="pe-hint">
      <div class="pe-tools">
        ${ei > 0 ? `<button class="link muted" data-c="up-ex" ${a}>↑</button>` : ""}
        ${ei < n - 1 ? `<button class="link muted" data-c="down-ex" ${a}>↓</button>` : ""}
        <button class="link muted" data-c="del-ex" ${a}>✕ удалить</button>
      </div>
    </div>`;
  }

  /* ---- поиск по библиотеке (общий для страницы библиотеки и окна выбора в плане) ---- */
  const libUi = { q: "", g: "", open: -1 };            // страница библиотеки
  const pickUi = { q: "", g: "", di: -1, ei: -1 };     // окно выбора в редакторе плана
  function libFilter(ui) {
    const words = norm(ui.q).split(/\s+/).filter(Boolean);
    return S.library.map((x, li) => ({ x, li }))
      .filter(({ x }) => {
        if (ui.g && x.group !== ui.g) return false;
        const hay = norm(x.name + " " + x.hint + " " + x.group).split(/[^a-zа-я0-9]+/);   // ищем по началу слов: «жим» ≠ «отжимания»
        return words.every(w => hay.some(h => h.startsWith(w)));
      })
      .sort((a, b) => a.x.name.localeCompare(b.x.name, "ru"));
  }
  function chipsHtml(ui, kind) {
    const count = g => S.library.filter(x => !g || x.group === g).length;
    return `<div class="chips">${["", ...GROUPS].filter(g => !g || count(g)).map(g =>
      `<button data-c="${kind}-group" data-g="${esc(g)}" class="${ui.g === g ? "on" : ""}">${esc(g || "Все")} <span>${count(g)}</span></button>`).join("")}</div>`;
  }
  function libListHtml() {
    const items = libFilter(libUi);
    if (!items.length) return `<div class="empty" style="padding:24px 10px">Ничего не найдено.${libUi.q.trim() ? `<br><br><button class="btn ghost" data-c="lib-add">+ Добавить «${esc(libUi.q.trim())}»</button>` : ""}</div>`;
    return items.map(({ x, li }) => li === libUi.open ? `<div class="card lib-edit">
        <div class="form" style="grid-template-columns:1fr">
          <label>Название<input data-cl="name" data-li="${li}" value="${esc(x.name)}"></label>
        </div>
        <div class="pe-grid3">
          <label>Группа<select data-cl="group" data-li="${li}">${GROUPS.map(g => `<option ${g === x.group ? "selected" : ""}>${g}</option>`).join("")}</select></label>
          <label>Тип<select data-cl="type" data-li="${li}">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${k === x.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
          <label>Отдых<select data-cl="rest" data-li="${li}">${RESTS.concat(RESTS.includes(+x.rest) ? [] : [+x.rest || 0]).map(r => `<option value="${r}" ${r === (+x.rest || 0) ? "selected" : ""}>${r ? fmtSec(r) : "—"}</option>`).join("")}</select></label>
        </div>
        <input data-cl="hint" data-li="${li}" value="${esc(x.hint || "")}" placeholder="Подсказка по технике" class="pe-hint">
        <div class="pe-tools"><button class="link muted" data-c="lib-del" data-li="${li}">✕ удалить</button><button class="link" data-c="lib-open" data-li="-1">Готово</button></div>
      </div>` : `<button class="lib-row" data-c="lib-open" data-li="${li}">
        <b>${esc(x.name)}</b><span>${esc(x.group || "")} · ${TYPES[x.type] || ""}${x.rest ? " · " + fmtSec(x.rest) : ""}</span>
      </button>`).join("");
  }
  function viewLibrary(v) {
    v.innerHTML = `
      <button class="link" data-c="back">← Все клиенты</button>
      <h1>Библиотека упражнений</h1>
      <p class="sub">${S.library.length} упражнений. Нажмите на упражнение, чтобы изменить. Новые упражнения из планов попадают сюда сами.</p>
      <div class="search"><input id="libSearch" type="search" value="${esc(libUi.q)}" placeholder="Поиск: «жим», «ягод», «гантел»…" autocomplete="off"></div>
      <div id="libChips">${chipsHtml(libUi, "lib")}</div>
      <button class="btn ghost" data-c="lib-add" style="margin-bottom:10px">+ Новое упражнение${libUi.g ? ` в «${esc(libUi.g)}»` : ""}</button>
      <div id="libItems">${libListHtml()}</div>`;
  }
  function refreshLib() {
    const it = document.getElementById("libItems"); if (it) it.innerHTML = libListHtml();
    const ch = document.getElementById("libChips"); if (ch) ch.innerHTML = chipsHtml(libUi, "lib");
  }

  /* окно выбора упражнения для плана */
  function pickListHtml() {
    const items = libFilter(pickUi);
    if (!items.length) return `<div class="empty" style="padding:20px 10px">Ничего не найдено.${pickUi.q.trim() ? `<br><br><button class="btn ghost" data-c="pick-new">Использовать «${esc(pickUi.q.trim())}» как новое</button>` : ""}</div>`;
    return items.map(({ x, li }) => `<button class="lib-row" data-c="pick" data-li="${li}"><b>${esc(x.name)}</b><span>${esc(x.group || "")} · ${TYPES[x.type] || ""}</span></button>`).join("");
  }
  function openPicker(di, ei) {
    Object.assign(pickUi, { di, ei, q: "" });
    openSheet(`<h3>Выбрать упражнение</h3>
      <div class="search"><input id="pickSearch" type="search" placeholder="Поиск по названию…" autocomplete="off"></div>
      <div id="pickChips">${chipsHtml(pickUi, "pick")}</div>
      <div id="pickItems" class="pick-list">${pickListHtml()}</div>
      <button class="btn ghost" data-act="close" style="margin-top:10px">Закрыть</button>`);
  }
  function refreshPick() {
    const it = document.getElementById("pickItems"); if (it) it.innerHTML = pickListHtml();
    const ch = document.getElementById("pickChips"); if (ch) ch.innerHTML = chipsHtml(pickUi, "pick");
  }
  function pickInto(name, fromLib) {
    const e = edit?.plan.days[pickUi.di]?.exercises[pickUi.ei]; if (!e) return;
    e.name = name; if (fromLib) applyLib(e);
    closeSheet(); markDirty(); render();
  }

  /* ---- сохранение плана ---- */
  function savePlan() {
    const id = edit.id, pl = clone(edit.plan);
    pl.days.forEach((d, i) => {
      d.title = (d.title || "").trim() || `Тренировка ${i + 1}`;
      d.exercises = d.exercises.filter(e => e.name.trim()).map(e => ({
        ...e, name: e.name.trim(), sets: Math.max(1, parseInt(e.sets) || 1), rest: +e.rest || 0,
        reps: String(e.reps || "").trim() || (e.type === "t" || e.type === "r" ? "макс" : "—"), weight: e.type === "wr" ? String(e.weight || "").trim() : ""
      }));
    });
    pl.days = pl.days.filter(d => d.exercises.length);
    let libAdded = 0;
    pl.days.forEach(d => d.exercises.forEach(e => {
      if (!libFind(e.name)) { S.library.push({ name: e.name, type: e.type, rest: e.rest, hint: e.hint || "", group: guessGroup(e.name) }); libAdded++; }
    }));
    if (libAdded) S.meta.libraryTs = Date.now();
    S.plans[id] = pl; S.meta.plansTs[id] = Date.now();
    const dr = S.drafts[id];
    if (dr && !pl.days.some(d => d.id === dr.dayId)) delete S.drafts[id];
    edit = { id, plan: clone(pl), dirty: false };
    save(true); changed(); render();
    toast(Sync.on ? "План сохранён — клиент увидит его при следующем открытии" : "План сохранён (синхронизация не подключена)");
  }

  /* ---- события ---- */
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    const c = b.dataset.c, di = +b.dataset.di, ei = +b.dataset.ei, li = +b.dataset.li;
    const days = edit?.plan.days;
    const go = (view, id = "") => { S.ui.coach = { view, id }; save(); render(); scrollTo(0, 0); };
    switch (c) {
      case "new-client": {
        const name = document.getElementById("newClientName").value.trim();
        if (!name) { toast("Введите имя клиента"); return; }
        const id = uid();
        S.names[id] = name; S.meta.nameTs[id] = Date.now(); S.plans[id] = { week: "", rule: "", days: [] };
        save(true); changed(); go("client", id); toast(`Клиент «${name}» добавлен. Составьте план и отправьте ссылку`);
        break;
      }
      case "open": go("client", b.dataset.id); break;
      case "back": if (leave()) go("list"); break;
      case "library": go("library"); break;
      case "link": {
        try {
          const url = await Sync.clientLink(b.dataset.id);
          document.getElementById("linkBox").classList.remove("hidden");
          document.getElementById("linkText").value = url;
        } catch (err) { toast(err.message); }
        break;
      }
      case "copy-link": await Sync.copyText(document.getElementById("linkText").value); toast("Ссылка скопирована"); break;
      case "share-link": try { await navigator.share({ title: "Тренер — мой план", text: "Твой план тренировок и дневник:", url: document.getElementById("linkText").value }); } catch {} break;
      case "diary": if (leave()) { S.ui.profile = b.dataset.id; S.ui.tab = "history"; save(); render(); scrollTo(0, 0); } break;
      case "log": if (leave()) { S.ui.profile = b.dataset.id; S.ui.tab = "today"; save(); render(); scrollTo(0, 0); } break;
      case "add-day": {
        const used = days.map(d => d.label), next = DAYS.find(x => !used.includes(x)) || "Пн";
        days.push({ id: uid(), label: next, title: "", exercises: [] }); markDirty(); render(); break;
      }
      case "del-day": if (confirm(`Удалить день «${days[di].label} ${days[di].title}» со всеми упражнениями?`)) { days.splice(di, 1); markDirty(); render(); } break;
      case "up-day": [days[di - 1], days[di]] = [days[di], days[di - 1]]; markDirty(); render(); break;
      case "down-day": [days[di + 1], days[di]] = [days[di], days[di + 1]]; markDirty(); render(); break;
      case "add-ex": days[di].exercises.push({ name: "", type: "wr", sets: 3, reps: "10–12", weight: "", rest: 90, hint: "" }); markDirty(); render();
        setTimeout(() => { const ins = document.querySelectorAll(`[data-ce="ex.name"][data-di="${di}"]`); ins[ins.length - 1]?.focus(); }, 0); break;
      case "del-ex": days[di].exercises.splice(ei, 1); markDirty(); render(); break;
      case "up-ex": { const x = days[di].exercises; [x[ei - 1], x[ei]] = [x[ei], x[ei - 1]]; markDirty(); render(); break; }
      case "down-ex": { const x = days[di].exercises; [x[ei + 1], x[ei]] = [x[ei], x[ei + 1]]; markDirty(); render(); break; }
      case "copy-from": {
        const src = document.getElementById("copyFrom").value;
        if (edit.plan.days.length && !confirm(`Заменить текущий план планом «${S.names[src]}»?`)) return;
        const p = clone(S.plans[src]); p.days.forEach(d => { d.id = uid(); });
        edit.plan = p; markDirty(); render(); toast("План скопирован — поправьте веса и сохраните"); break;
      }
      case "save-plan": savePlan(); break;
      case "revert": if (!edit.dirty || confirm("Отменить все несохранённые правки?")) { edit = null; render(); } break;
      case "del-client": {
        const id = b.dataset.id;
        if (!confirm(`Удалить клиента «${S.names[id]}»? Его план, тренировки и замеры удалятся у всех.`) || !confirm("Точно? Это нельзя отменить.")) return;
        S.meta.deletedClients[id] = Date.now();
        delete S.names[id]; delete S.plans[id]; delete S.drafts[id];
        S.sessions = S.sessions.filter(s => s.profile !== id); S.measures = S.measures.filter(m => m.profile !== id);
        edit = null; save(true); changed(); go("list"); toast("Клиент удалён"); break;
      }
      case "lib-add": {
        const name = libUi.q.trim() || "Новое упражнение";
        if (libFind(name)) { toast("Такое упражнение уже есть"); return; }
        S.library.push({ name, type: "wr", rest: 90, hint: "", group: libUi.g || guessGroup(name) });
        libUi.open = S.library.length - 1; libTouch(); render();
        setTimeout(() => document.querySelector(`[data-cl="name"][data-li="${libUi.open}"]`)?.focus(), 0); break;
      }
      case "lib-del": if (confirm(`Удалить «${S.library[li].name}» из библиотеки? В планах клиентов оно останется.`)) { S.library.splice(li, 1); libUi.open = -1; libTouch(); refreshLib(); } break;
      case "lib-open": libUi.open = li; refreshLib(); break;
      case "lib-group": libUi.g = b.dataset.g; libUi.open = -1; refreshLib(); break;
      case "pick-open": openPicker(di, ei); break;
      case "pick-group": pickUi.g = b.dataset.g; refreshPick(); break;
      case "pick": pickInto(S.library[li].name, true); break;
      case "pick-new": pickInto(pickUi.q.trim(), false); break;
    }
  });

  function applyLib(e) {
    const x = libFind(e.name); if (!x) return false;
    e.type = x.type; e.rest = x.rest; if (!e.hint) e.hint = x.hint;
    if (x.type !== "wr") e.weight = "";
    if (x.type === "t" && /^\d+–?\d*$/.test(e.reps)) e.reps = "60 сек";
    if (x.type === "cardio") { e.sets = 1; e.reps = "15 мин"; }
    return true;
  }
  function onField(t, final) {
    if (t.dataset.cname !== undefined && final) {
      const id = t.dataset.cname, v = t.value.trim(); if (!v) { t.value = S.names[id]; return; }
      S.names[id] = v; S.meta.nameTs[id] = Date.now(); save(); changed(); renderProfiles();
      const h = document.querySelector("#view h1"); if (h) h.textContent = v;
      return;
    }
    if (t.dataset.cl && final) {
      const x = S.library[+t.dataset.li]; if (!x) return;
      x[t.dataset.cl] = t.dataset.cl === "rest" ? +t.value : t.value; libTouch();
      if (t.dataset.cl === "group") refreshLib();
      return;
    }
    const f = t.dataset.ce; if (!f || !edit) return;
    const pl = edit.plan, val = t.type === "checkbox" ? t.checked : t.value;
    if (f === "week" || f === "rule") pl[f] = val;
    else if (f.startsWith("day.")) pl.days[+t.dataset.di][f.slice(4)] = val;
    else {
      const e = pl.days[+t.dataset.di].exercises[+t.dataset.ei], k = f.slice(3);
      e[k] = k === "rest" ? +val : val;
      if (k === "name" && final && applyLib(e)) { markDirty(); render(); return; }
      if (k === "type" && final) { markDirty(); render(); return; }
    }
    markDirty();
  }
  document.addEventListener("input", e => {
    if (e.target.id === "libSearch") { libUi.q = e.target.value; libUi.open = -1; refreshLib(); return; }
    if (e.target.id === "pickSearch") { pickUi.q = e.target.value; refreshPick(); return; }
    if (e.target.closest("#view") && S.ui.tab === "coach") onField(e.target, false);
  });
  document.addEventListener("change", e => { if (e.target.closest("#view") && S.ui.tab === "coach") onField(e.target, true); });

  return { view, leave, savePlan };
})();
function viewCoach(v) { Coach.view(v); }
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
