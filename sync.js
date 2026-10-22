"use strict";
/* Синхронизация через GitHub Gist.
   - Данные шифруются на телефоне (AES-GCM), в gist лежит только шифротекст.
   - Слияние: тренировки и замеры объединяются по id (побеждает более свежая правка),
     удаления передаются «надгробиями», план и имена — по времени изменения.
   - Настройки (токен, id gist'а, ключ) хранятся отдельно и не попадают в резервную копию. */

const Sync = (() => {
  const CFG_KEY = "trainer.sync";
  const FILE = "trainer.enc.json";
  const API = "https://api.github.com";
  let cfg = null, busy = false, timer = null, status = { ok: null, msg: "", at: 0 };

  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch { cfg = null; }
  const saveCfg = () => { try { cfg ? localStorage.setItem(CFG_KEY, JSON.stringify(cfg)) : localStorage.removeItem(CFG_KEY); } catch {} };

  /* ---- base64 / шифрование ---- */
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  async function key() { return crypto.subtle.importKey("raw", unb64(cfg.k), "AES-GCM", false, ["encrypt", "decrypt"]); }
  async function encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
    return JSON.stringify({ app: "trainer", enc: 1, iv: b64(iv), data: b64(ct) });
  }
  async function decrypt(text) {
    const o = JSON.parse(text);
    if (!o.enc) return o;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, await key(), unb64(o.data));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* ---- GitHub API ---- */
  async function gh(path, opts = {}, token = cfg?.t) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(opts.headers || {}) },
      cache: "no-store"
    });
    if (!res.ok) {
      let m = ""; try { m = (await res.json()).message || ""; } catch {}
      const err = new Error(res.status === 401 ? "Токен недействителен или истёк" : res.status === 404 ? "Хранилище не найдено (проверьте код подключения)" : `GitHub ${res.status}: ${m}`);
      err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  async function readRemote() {
    const g = await gh(`/gists/${cfg.g}`);
    const f = g.files?.[FILE];
    if (!f) return null;
    const text = f.truncated ? await (await fetch(f.raw_url, { cache: "no-store" })).text() : f.content;
    if (!text || !text.trim()) return null;
    const o = await decrypt(text);
    return o && o.app === "trainer" && Array.isArray(o.sessions) ? o : null;
  }
  async function writeRemote(payload) {
    await gh(`/gists/${cfg.g}`, { method: "PATCH", body: JSON.stringify({ files: { [FILE]: { content: await encrypt(payload) } } }) });
  }

  /* ---- данные ---- */
  function payloadFrom(st) {
    return { app: "trainer", v: 1, names: st.names, plans: st.plans, sessions: st.sessions, measures: st.measures, deleted: st.deleted || {}, meta: st.meta };
  }
  function mergeList(a = [], b = [], deleted) {
    const m = new Map();
    [...a, ...b].forEach(x => {
      if (!x || !x.id || deleted[x.id]) return;
      const cur = m.get(x.id);
      if (!cur || (x.ts || 0) > (cur.ts || 0)) m.set(x.id, x);
    });
    return [...m.values()];
  }
  function merge(loc, rem) {
    const deleted = { ...(rem.deleted || {}) };
    Object.entries(loc.deleted || {}).forEach(([k, v]) => { deleted[k] = Math.max(v, deleted[k] || 0); });
    const lm = loc.meta || {}, rm = rem.meta || {};
    const out = {
      app: "trainer", v: 1, deleted,
      sessions: mergeList(loc.sessions, rem.sessions, deleted),
      measures: mergeList(loc.measures, rem.measures, deleted),
      plans: { ...loc.plans }, names: { ...loc.names },
      meta: { plansTs: { ...(lm.plansTs || {}) }, namesTs: lm.namesTs || 0 }
    };
    ["me", "her"].forEach(p => {
      const rt = rm.plansTs?.[p] || 0, lt = lm.plansTs?.[p] || 0;
      if (rem.plans?.[p] && rt > lt) { out.plans[p] = rem.plans[p]; out.meta.plansTs[p] = rt; }
    });
    if ((rm.namesTs || 0) > (lm.namesTs || 0) && rem.names) { out.names = { ...rem.names }; out.meta.namesTs = rm.namesTs; }
    return out;
  }
  const sig = p => JSON.stringify([
    [...p.sessions].map(s => s.id + ":" + (s.ts || 0)).sort(),
    [...p.measures].map(s => s.id + ":" + (s.ts || 0)).sort(),
    Object.keys(p.deleted || {}).sort(), p.meta?.plansTs, p.meta?.namesTs, p.names
  ]);

  /* ---- синхронизация ---- */
  async function syncNow(manual) {
    if (!cfg || busy) return;
    if (!navigator.onLine) { setStatus(false, "Нет интернета — синхронизируем позже"); return; }
    busy = true; setStatus(null, "Синхронизация…");
    try {
      const local = payloadFrom(S);
      const remote = await readRemote();
      const merged = remote ? merge(local, remote) : local;
      const localChanged = sig(merged) !== sig(local);
      if (localChanged) {
        const plansChanged = ["me", "her"].some(p => (merged.meta.plansTs[p] || 0) !== (S.meta?.plansTs?.[p] || 0));
        S.sessions = merged.sessions; S.measures = merged.measures; S.deleted = merged.deleted;
        S.plans = merged.plans; S.names = merged.names; S.meta = merged.meta;
        if (plansChanged) ["me", "her"].forEach(p => {
          const d = S.drafts[p];
          if (d && !S.plans[p].days.some(x => x.id === d.dayId)) delete S.drafts[p];
        });
        save(true);
      }
      if (!remote || sig(merged) !== sig(remote)) await writeRemote(merged);
      setStatus(true, "Синхронизировано");
      if (localChanged) safeRender();
      if (manual) toast(localChanged ? "Получены новые данные" : "Всё актуально");
    } catch (e) {
      setStatus(false, e.message || "Ошибка синхронизации");
      if (manual) toast(e.message || "Ошибка синхронизации");
    } finally { busy = false; }
  }
  function schedule() { if (!cfg) return; clearTimeout(timer); timer = setTimeout(() => syncNow(false), 1500); }
  function safeRender() {
    const a = document.activeElement;
    if (S.ui.tab === "today" && a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) return;
    render();
  }
  function setStatus(ok, msg) {
    status = { ok, msg, at: Date.now() };
    const el = document.getElementById("syncStatus");
    if (el) el.innerHTML = statusHtml();
  }
  function statusHtml() {
    if (!status.msg) return "Ещё не синхронизировалось";
    const t = new Date(status.at).toTimeString().slice(0, 5);
    const color = status.ok === true ? "var(--accent)" : status.ok === false ? "var(--danger)" : "var(--muted)";
    return `<span style="color:${color}">●</span> ${esc(status.msg)} · ${t}`;
  }

  /* ---- подключение ---- */
  function code() { return "TRN1." + b64url(JSON.stringify({ t: cfg.t, g: cfg.g, k: cfg.k })); }
  async function create(token) {
    token = token.trim();
    if (!token) throw new Error("Вставьте токен");
    const k = b64(crypto.getRandomValues(new Uint8Array(32)));
    const tmp = { t: token, k, g: "" };
    const prev = cfg; cfg = tmp;
    try {
      const body = pub => JSON.stringify({ description: "Тренер — зашифрованные данные", public: pub, files: { [FILE]: { content: "{}" } } });
      let g;
      try { g = await gh("/gists", { method: "POST", body: body(false) }, token); }
      catch (e) { if (e.status === 401) throw e; g = await gh("/gists", { method: "POST", body: body(true) }, token); }
      cfg.g = g.id; saveCfg();
      await syncNow(false);
    } catch (e) { cfg = prev; throw e; }
  }
  async function connect(c) {
    c = c.trim();
    if (!c.startsWith("TRN1.")) throw new Error("Это не код подключения");
    let o; try { o = JSON.parse(unb64url(c.slice(5))); } catch { throw new Error("Код повреждён — скопируйте целиком"); }
    if (!o.t || !o.g || !o.k) throw new Error("Код неполный");
    const prev = cfg; cfg = o;
    try { await readRemote(); } catch (e) { cfg = prev; throw e.name === "OperationError" ? new Error("Ключ не подходит к хранилищу") : e; }
    saveCfg(); await syncNow(false);
  }

  /* ---- раздел в «Ещё» ---- */
  function section() {
    if (!cfg) return `
      <h2>Синхронизация между телефонами</h2>
      <p>Тренировки обоих телефонов объединяются через ваш GitHub. Данные шифруются, ключ есть только у ваших телефонов.</p>
      <div class="card">
        <b>Первый телефон</b>
        <p class="sub" style="margin:6px 0 8px">1. Создайте токен: отметка <b>gist</b> уже стоит, срок — «No expiration», внизу «Generate token». Скопируйте его.</p>
        <a class="btn ghost" href="https://github.com/settings/tokens/new?scopes=gist&description=%D0%A2%D1%80%D0%B5%D0%BD%D0%B5%D1%80" target="_blank" rel="noopener">Открыть GitHub → создать токен</a>
        <p class="sub" style="margin:10px 0 6px">2. Вставьте токен и создайте хранилище:</p>
        <div class="form" style="grid-template-columns:1fr"><input id="syncToken" placeholder="ghp_…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <button class="btn" style="margin-top:10px" data-act="sync-create">Создать хранилище</button>
      </div>
      <div class="card">
        <b>Второй телефон</b>
        <p class="sub" style="margin:6px 0 8px">На первом телефоне нажмите «Код для второго телефона» и пришлите код сюда.</p>
        <div class="form" style="grid-template-columns:1fr"><input id="syncCode" placeholder="TRN1.…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <button class="btn ghost" style="margin-top:10px" data-act="sync-connect">Подключиться по коду</button>
      </div>`;
    return `
      <h2>Синхронизация</h2>
      <div class="card">
        <div id="syncStatus" class="sub" style="margin:0 0 10px">${statusHtml()}</div>
        <button class="btn" data-act="sync-now">Синхронизировать сейчас</button>
        <button class="btn ghost" data-act="sync-code">Код для второго телефона</button>
        <div id="syncCodeBox" class="hidden" style="margin-top:10px">
          <textarea id="syncCodeText" readonly style="min-height:90px;font-size:12px;word-break:break-all"></textarea>
          <button class="btn ghost" style="margin-top:8px" data-act="sync-copy">Скопировать код</button>
          <p class="sub" style="margin:8px 0 0">Код = доступ к вашим данным. Отправляйте только девушке, не публикуйте.</p>
        </div>
      </div>
      <p>Синхронизация идёт сама: при открытии приложения, после сохранения тренировки или замера и при появлении интернета.</p>
      <button class="btn danger" data-act="sync-off">Отключить синхронизацию на этом телефоне</button>`;
  }
  async function handle(act) {
    try {
      if (act === "sync-create") { await create(document.getElementById("syncToken").value); toast("Хранилище создано"); render(); }
      else if (act === "sync-connect") { await connect(document.getElementById("syncCode").value); toast("Подключено"); render(); }
      else if (act === "sync-now") await syncNow(true);
      else if (act === "sync-code") { const b = document.getElementById("syncCodeBox"); b.classList.toggle("hidden"); document.getElementById("syncCodeText").value = code(); }
      else if (act === "sync-copy") {
        const t = document.getElementById("syncCodeText");
        try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand("copy"); }
        toast("Код скопирован");
      }
      else if (act === "sync-off") {
        if (!confirm("Отключить синхронизацию? Данные на телефоне и в облаке останутся.")) return;
        cfg = null; saveCfg(); status = { ok: null, msg: "", at: 0 }; render();
      }
    } catch (e) { toast(e.message || String(e)); }
  }

  window.addEventListener("online", () => schedule());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });

  return { syncNow, schedule, section, handle, get on() { return !!cfg; } };
})();
