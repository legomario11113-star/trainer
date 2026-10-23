"use strict";
/* Синхронизация через GitHub Gist (v3: тренер + клиенты).

   Хранилище = один секретный gist:
     trainer.admin.enc.json     — индекс тренера: клиенты {id:{name,ts}}, удалённые клиенты, библиотека упражнений.
                                  Шифруется ГЛАВНЫМ ключом (есть только у тренера).
     trainer.<clientId>.enc.json — данные клиента: имя, план, тренировки, замеры, «надгробия» удалений.
                                  Шифруется КЛЮЧОМ КЛИЕНТА, который выводится из главного: SHA-256(главный + "trainer/client/" + id).
                                  Исторические клиенты: "me" — ключ = главный; "her" — SHA-256(главный + "trainer/her") (совместимость со старыми ссылками).
   Тренер (главный ключ) читает/пишет всё. Клиент (ссылка с ключом клиента) — только свой файл.
   Слияние: тренировки/замеры — по id (побеждает больший ts), удаления — «надгробия», план/имя/библиотека — по времени изменения.
   Хранилище изолировано в этом модуле: при переходе на настоящий сервер меняется только он (см. PROJECT_NOTES.md). */

const Sync = (() => {
  const CFG_KEY = "trainer.sync";
  const ADMIN_FILE = "trainer.admin.enc.json";
  const fileOf = id => `trainer.${id}.enc.json`;
  const API = "https://api.github.com";
  const TIMEOUT = 20000;
  let cfg = null, busy = false, timer = null, status = { ok: null, msg: "", at: 0 };

  /* cfg тренера: { t: токен, g: id gist, m: главный ключ }
     cfg клиента: { t, g, c: id клиента, k: ключ клиента } */
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch { cfg = null; }
  const saveCfg = () => { try { cfg ? localStorage.setItem(CFG_KEY, JSON.stringify(cfg)) : localStorage.removeItem(CFG_KEY); } catch {} };
  // старые форматы настроек → v3
  if (cfg && !cfg.m && !cfg.c) {
    if (cfg.k && !cfg.keys) cfg = { t: cfg.t, g: cfg.g, m: cfg.k };                         // v1
    else if (cfg.keys?.me) cfg = { t: cfg.t, g: cfg.g, m: cfg.keys.me };                     // v2 полный
    else if (cfg.keys?.her) cfg = { t: cfg.t, g: cfg.g, c: "her", k: cfg.keys.her };         // v2 девушка
    saveCfg();
  } else if (cfg?.m && cfg.keys) { cfg = { t: cfg.t, g: cfg.g, m: cfg.m }; saveCfg(); }

  /* ---- base64 / ключи / шифрование ---- */
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  async function sha(masterB64, label) {
    const data = new Uint8Array([...unb64(masterB64), ...new TextEncoder().encode(label)]);
    return b64(await crypto.subtle.digest("SHA-256", data));
  }
  async function keyFor(id) {
    if (cfg.c) { if (id !== cfg.c) throw new Error("Нет доступа"); return cfg.k; }
    if (id === "me") return cfg.m;
    if (id === "her") return sha(cfg.m, "trainer/her");
    return sha(cfg.m, "trainer/client/" + id);
  }
  const importKey = k => crypto.subtle.importKey("raw", unb64(k), "AES-GCM", false, ["encrypt", "decrypt"]);
  async function encrypt(obj, k) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(k), new TextEncoder().encode(JSON.stringify(obj)));
    return JSON.stringify({ app: "trainer", enc: 1, iv: b64(iv), data: b64(ct) });
  }
  async function decrypt(text, k) {
    const o = JSON.parse(text);
    if (!o.enc) return null;
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, await importKey(k), unb64(o.data));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch { throw new Error("Ключ не подходит к хранилищу"); }
  }

  /* ---- GitHub API (с ограничением времени ожидания) ---- */
  async function gh(path, opts = {}, token = cfg?.t) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), TIMEOUT);
    let res;
    try {
      res = await fetch(API + path, {
        ...opts, signal: ctl.signal, cache: "no-store",
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(opts.headers || {}) }
      });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "GitHub не отвечает — попробуйте ещё раз" : "Нет связи с GitHub");
    } finally { clearTimeout(tm); }
    if (!res.ok) {
      let m = ""; try { m = (await res.json()).message || ""; } catch {}
      const err = new Error(res.status === 401 ? "Токен недействителен или истёк" : res.status === 404 ? "Хранилище не найдено (проверьте ссылку)" : `GitHub ${res.status}: ${m}`);
      err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  async function fileText(f) {
    if (!f) return "";
    return f.truncated ? (await fetch(f.raw_url, { cache: "no-store" })).text() : f.content;
  }
  const readGist = () => gh(`/gists/${cfg.g}`);

  /* ---- слияние ---- */
  function mergeList(a = [], b = [], deleted) {
    const m = new Map();
    [...a, ...b].forEach(x => {
      if (!x || !x.id || deleted[x.id]) return;
      const cur = m.get(x.id);
      if (!cur || (x.ts || 0) > (cur.ts || 0)) m.set(x.id, x);
    });
    return [...m.values()];
  }
  const unionTs = (a = {}, b = {}) => { const o = { ...b }; Object.entries(a).forEach(([k, v]) => { o[k] = Math.max(v, o[k] || 0); }); return o; };

  // данные одного клиента
  function localPart(id) {
    return {
      app: "trainer", v: 3, profile: id,
      name: S.names[id] || "", nameTs: S.meta.nameTs[id] || 0,
      plan: S.plans[id] || null, planTs: S.meta.plansTs[id] || 0,
      sessions: S.sessions.filter(s => s.profile === id),
      measures: S.measures.filter(m => m.profile === id),
      deleted: S.deleted || {}
    };
  }
  function mergePart(loc, rem) {
    const deleted = unionTs(loc.deleted, rem.deleted);
    const planNewer = rem.plan && (rem.planTs || 0) > (loc.planTs || 0);
    const remName = rem.name ?? rem.names?.[loc.profile];            // v2-файлы хранили names целиком
    const remNameTs = rem.nameTs ?? rem.namesTs ?? 0;
    const nameNewer = remName && remNameTs > (loc.nameTs || 0);
    return {
      app: "trainer", v: 3, profile: loc.profile, deleted,
      name: nameNewer ? remName : loc.name, nameTs: nameNewer ? remNameTs : loc.nameTs,
      plan: planNewer ? rem.plan : loc.plan, planTs: planNewer ? rem.planTs : loc.planTs,
      sessions: mergeList(loc.sessions, rem.sessions, deleted).filter(s => s.profile === loc.profile),
      measures: mergeList(loc.measures, rem.measures, deleted).filter(m => m.profile === loc.profile)
    };
  }
  const sigPart = x => JSON.stringify([
    [...(x.sessions || [])].map(s => s.id + ":" + (s.ts || 0)).sort(),
    [...(x.measures || [])].map(s => s.id + ":" + (s.ts || 0)).sort(),
    Object.keys(x.deleted || {}).sort(), x.planTs || 0, x.nameTs || 0, x.name || ""
  ]);
  function applyPart(part) {
    const id = part.profile;
    S.sessions = S.sessions.filter(s => s.profile !== id && !part.deleted[s.id]).concat(part.sessions);
    S.measures = S.measures.filter(m => m.profile !== id && !part.deleted[m.id]).concat(part.measures);
    Object.assign(S.deleted, part.deleted);
    if (part.name && part.nameTs !== (S.meta.nameTs[id] || 0)) { S.names[id] = part.name; S.meta.nameTs[id] = part.nameTs; }
    else if (part.name && !S.names[id]) S.names[id] = part.name;
    if (part.plan && part.planTs !== (S.meta.plansTs[id] || 0)) {
      S.plans[id] = part.plan; S.meta.plansTs[id] = part.planTs;
      const d = S.drafts[id];
      if (d && !part.plan.days.some(x => x.id === d.dayId)) delete S.drafts[id];
    }
  }

  // индекс тренера
  function localIndex() {
    const clients = {};
    Object.keys(S.names).forEach(id => { if (!S.meta.deletedClients[id]) clients[id] = { name: S.names[id], ts: S.meta.nameTs[id] || 0 }; });
    return { app: "trainer", v: 3, clients, deletedClients: S.meta.deletedClients, library: S.library || [], libraryTs: S.meta.libraryTs || 0 };
  }
  function mergeIndex(loc, rem) {
    const deletedClients = unionTs(loc.deletedClients, rem.deletedClients);
    const clients = {};
    [loc.clients, rem.clients || {}].forEach(src => Object.entries(src).forEach(([id, c]) => {
      if (deletedClients[id]) return;
      if (!clients[id] || (c.ts || 0) > (clients[id].ts || 0)) clients[id] = c;
    }));
    const libNewer = (rem.libraryTs || 0) > (loc.libraryTs || 0);
    return { app: "trainer", v: 3, clients, deletedClients,
      library: libNewer ? rem.library : loc.library, libraryTs: libNewer ? rem.libraryTs : loc.libraryTs };
  }
  const sigIndex = x => JSON.stringify([Object.entries(x.clients || {}).map(([k, c]) => k + ":" + c.ts + ":" + c.name).sort(), Object.keys(x.deletedClients || {}).sort(), x.libraryTs || 0]);
  function applyIndex(ix) {
    Object.entries(ix.clients).forEach(([id, c]) => {
      if ((c.ts || 0) >= (S.meta.nameTs[id] || 0)) { S.names[id] = c.name; S.meta.nameTs[id] = c.ts || 0; }
    });
    S.meta.deletedClients = ix.deletedClients;
    Object.keys(ix.deletedClients).forEach(id => { delete S.names[id]; delete S.plans[id]; delete S.drafts[id]; });
    if ((ix.libraryTs || 0) !== (S.meta.libraryTs || 0)) { S.library = ix.library; S.meta.libraryTs = ix.libraryTs; }
  }

  /* ---- синхронизация ---- */
  async function syncNow(manual) {
    if (!cfg || busy) return;
    if (!navigator.onLine) { setStatus(false, "Нет интернета — синхронизируем позже"); return; }
    busy = true; setStatus(null, "Синхронизация…");
    try {
      const g = await readGist();
      const upload = {};
      let localChanged = false;
      let ids;
      if (cfg.m) {
        const txt = await fileText(g.files?.[ADMIN_FILE]);
        const rem = txt && txt.trim() ? await decrypt(txt, cfg.m) : null;
        const loc = localIndex();
        const ix = rem ? mergeIndex(loc, rem) : loc;
        if (sigIndex(ix) !== sigIndex(loc)) { applyIndex(ix); localChanged = true; }
        if (!rem || sigIndex(ix) !== sigIndex(rem)) upload[ADMIN_FILE] = { content: await encrypt(ix, cfg.m) };
        Object.keys(ix.deletedClients).forEach(id => { if (g.files?.[fileOf(id)]) upload[fileOf(id)] = null; });
        ids = Object.keys(ix.clients);
      } else ids = [cfg.c];
      for (const id of ids) {
        const k = await keyFor(id);
        const txt = await fileText(g.files?.[fileOf(id)]);
        const rem = txt && txt.trim() ? await decrypt(txt, k) : null;
        const loc = localPart(id);
        const merged = rem ? mergePart(loc, rem) : loc;
        if (sigPart(merged) !== sigPart(loc)) { applyPart(merged); localChanged = true; }
        if (!rem || sigPart(merged) !== sigPart(rem)) upload[fileOf(id)] = { content: await encrypt(merged, k) };
      }
      if (Object.keys(upload).length) await gh(`/gists/${cfg.g}`, { method: "PATCH", body: JSON.stringify({ files: upload }) });
      if (localChanged) save(true);
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
    if ((S.ui.tab === "today" || S.ui.tab === "coach") && a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
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

  /* ---- ссылки и коды ---- */
  const BASE = location.origin + location.pathname.replace(/[^/]*$/, "");
  const adminCode = () => "TRN3." + b64url(JSON.stringify({ t: cfg.t, g: cfg.g, m: cfg.m }));
  async function clientLink(id) {
    if (!cfg?.m) throw new Error("Сначала подключите синхронизацию (вкладка «Ещё»)");
    return BASE + "#join=TRN3." + b64url(JSON.stringify({ t: cfg.t, g: cfg.g, c: id, k: await keyFor(id), n: S.names[id] || "" }));
  }
  const adminLink = () => BASE + "#join=" + adminCode();
  function parseCode(c) {
    c = c.trim();
    const pre = c.slice(0, 5);
    if (!/^TRN[123]\.$/.test(pre)) throw new Error("Это не код подключения");
    let o; try { o = JSON.parse(unb64url(c.slice(5))); } catch { throw new Error("Ссылка повреждена — скопируйте целиком"); }
    if (!o.t || !o.g) throw new Error("Ссылка неполная");
    if (o.m) return { t: o.t, g: o.g, m: o.m };
    if (pre === "TRN1." && o.k) return { t: o.t, g: o.g, m: o.k };
    if (o.her) return { t: o.t, g: o.g, c: "her", k: o.her };
    if (o.c && o.k) return { t: o.t, g: o.g, c: o.c, k: o.k, n: o.n };
    throw new Error("Ссылка неполная");
  }
  function hashCode() { const m = location.hash.match(/^#join=(TRN[123]\.[\w-]+)/); return m ? m[1] : ""; }
  let pending = null;
  if (!cfg && hashCode()) { try { pending = parseCode(hashCode()); } catch {} }

  async function create(token) {
    token = token.trim();
    if (!token) throw new Error("Вставьте токен");
    const prev = cfg;
    cfg = { t: token, g: "", m: b64(crypto.getRandomValues(new Uint8Array(32))) };
    try {
      const body = pub => JSON.stringify({ description: "Тренер — зашифрованные данные", public: pub, files: { "README.md": { content: "Зашифрованные данные приложения «Тренер»." } } });
      let g;
      try { g = await gh("/gists", { method: "POST", body: body(false) }, token); }
      catch (e) { if (e.status === 401) throw e; g = await gh("/gists", { method: "POST", body: body(true) }, token); }
      cfg.g = g.id; saveCfg();
      await syncNow(false);
    } catch (e) { cfg = prev; throw e; }
  }
  async function connect(c) {
    const next = parseCode(c);
    const prev = cfg; cfg = next;
    try {
      const g = await readGist();
      if (cfg.m) { const t = await fileText(g.files?.[ADMIN_FILE]); if (t && t.trim()) await decrypt(t, cfg.m); else { const t2 = await fileText(g.files?.[fileOf("me")]); if (t2 && t2.trim()) await decrypt(t2, cfg.m); } }
      else { const t = await fileText(g.files?.[fileOf(cfg.c)]); if (t && t.trim()) await decrypt(t, cfg.k); else throw new Error("Клиент не найден — возможно, тренер его удалил"); }
    } catch (e) { cfg = prev; throw e; }
    if (cfg.c) { if (cfg.n && !S.names[cfg.c]) S.names[cfg.c] = cfg.n; delete cfg.n; S.ui.profile = cfg.c; if (S.ui.tab === "coach") S.ui.tab = "today"; }
    saveCfg(); save(true);
    await syncNow(false);
  }

  // Установка «на экран Домой» должна открывать ту же ссылку (с ключом), иначе на iPhone приложение откроется неподключённым.
  function manifestWithJoin() {
    if (!hashCode()) return;
    fetch("manifest.webmanifest").then(r => r.json()).then(m => {
      m.start_url = location.href; m.scope = BASE; m.id = BASE;
      m.icons = (m.icons || []).map(i => ({ ...i, src: new URL(i.src, BASE).href }));
      const l = document.querySelector('link[rel="manifest"]');
      if (l) l.href = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: "application/manifest+json" }));
    }).catch(() => {});
  }
  async function joinFromHash() {
    const c = hashCode(); if (!c) return;
    let sc; try { sc = parseCode(c); } catch (e) { toast(e.message); return; }
    if (cfg && cfg.g === sc.g && (cfg.m || cfg.c === sc.c) && !(sc.m && !cfg.m)) return; // уже подключено
    if (!navigator.onLine) { toast("Нет интернета — подключимся, когда появится"); window.addEventListener("online", joinFromHash, { once: true }); return; }
    try {
      await connect(c);
      toast(cfg.c ? `Привет, ${S.names[cfg.c] || "друг"}! 💪` : "Устройство тренера подключено");
      render();
    } catch (e) { toast("Не удалось подключиться: " + (e.message || e)); }
  }

  /* ---- раздел в «Ещё» ---- */
  function section() {
    if (!cfg) return `
      <h2>Синхронизация</h2>
      <p>Нужна, чтобы отправлять клиентам ссылки и видеть их тренировки. Данные шифруются, у каждого клиента свой ключ.</p>
      <div class="card">
        <b>Устройство тренера</b>
        <p class="sub" style="margin:6px 0 8px">1. Создайте токен GitHub: отметка <b>gist</b> уже стоит, срок — «No expiration», внизу «Generate token». Скопируйте его.</p>
        <a class="btn ghost" href="https://github.com/settings/tokens/new?scopes=gist&description=%D0%A2%D1%80%D0%B5%D0%BD%D0%B5%D1%80" target="_blank" rel="noopener">Открыть GitHub → создать токен</a>
        <p class="sub" style="margin:10px 0 6px">2. Вставьте токен и создайте хранилище (до 20 секунд):</p>
        <div class="form" style="grid-template-columns:1fr"><input id="syncToken" placeholder="ghp_…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <button class="btn" style="margin-top:10px" data-act="sync-create">Создать хранилище</button>
      </div>
      <div class="card">
        <b>Уже есть ссылка?</b>
        <p class="sub" style="margin:6px 0 8px">Просто откройте её — подключение произойдёт само. Или вставьте сюда:</p>
        <div class="form" style="grid-template-columns:1fr"><input id="syncCode" placeholder="https://…#join=… или TRN…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <button class="btn ghost" style="margin-top:10px" data-act="sync-connect">Подключиться</button>
      </div>`;
    return `
      <h2>Синхронизация</h2>
      <div class="card">
        <div id="syncStatus" class="sub" style="margin:0 0 10px">${statusHtml()}</div>
        <p class="sub" style="margin:0 0 10px">Это устройство: <b>${cfg.m ? "тренер (все клиенты)" : "клиент «" + esc(S.names[cfg.c] || "") + "»"}</b></p>
        <button class="btn" data-act="sync-now">Синхронизировать сейчас</button>
        ${cfg.m ? `
          <button class="btn ghost" data-act="sync-code">Ссылка для своих устройств (тренер)</button>
          <div id="syncCodeBox" class="hidden" style="margin-top:10px">
            <div class="sub" style="margin:0 0 6px">Полный доступ ко всем клиентам. Сохраните её в надёжном месте (например, «Избранное» в Telegram) — это ваш ключ восстановления. Никому не отправляйте.</div>
            <textarea id="syncCodeText" readonly style="min-height:90px;font-size:12px;word-break:break-all"></textarea>
            <div class="row" style="margin-top:8px">
              <button class="btn ghost" data-act="sync-copy">Скопировать</button>
              ${navigator.share ? `<button class="btn ghost" data-act="sync-share">Отправить…</button>` : ""}
            </div>
          </div>
          <p>Ссылки для клиентов — во вкладке «Тренер» → клиент → «Ссылка для клиента».</p>` : ""}
      </div>
      <p>Синхронизация идёт сама: при открытии приложения, после сохранения тренировки, плана или замера и при появлении интернета.</p>
      <button class="btn danger" data-act="sync-off">Отключить синхронизацию на этом устройстве</button>`;
  }
  async function busyBtn(el, text, fn) {
    const old = el?.textContent; if (el) { el.disabled = true; el.textContent = text; }
    try { return await fn(); } finally { if (el && el.isConnected) { el.disabled = false; el.textContent = old; } }
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); return true; }
  }
  async function handle(act, el) {
    try {
      if (act === "sync-create") await busyBtn(el, "Создаю…", async () => { await create(document.getElementById("syncToken").value); toast("Хранилище создано. Сохраните ссылку для своих устройств!"); render(); });
      else if (act === "sync-connect") await busyBtn(el, "Подключаю…", async () => {
        const v = document.getElementById("syncCode").value; const m = v.match(/TRN[123]\.[\w-]+/);
        await connect(m ? m[0] : v); toast("Подключено"); render();
      });
      else if (act === "sync-now") await busyBtn(el, "Синхронизация…", () => syncNow(true));
      else if (act === "sync-code") { document.getElementById("syncCodeBox").classList.remove("hidden"); document.getElementById("syncCodeText").value = adminLink(); }
      else if (act === "sync-copy") { await copyText(document.getElementById("syncCodeText").value); toast("Ссылка скопирована"); }
      else if (act === "sync-share") { try { await navigator.share({ title: "Тренер", url: document.getElementById("syncCodeText").value }); } catch {} }
      else if (act === "sync-off") {
        if (!confirm("Отключить синхронизацию? Данные на устройстве и в облаке останутся.")) return;
        cfg = null; saveCfg(); status = { ok: null, msg: "", at: 0 }; render();
      }
    } catch (e) { toast(e.message || String(e)); }
  }

  window.addEventListener("online", () => schedule());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  manifestWithJoin();
  setTimeout(joinFromHash, 0);

  return {
    syncNow, schedule, section, handle, clientLink, copyText,
    get on() { return !!cfg; },
    get isAdmin() { return cfg ? !!cfg.m : !(pending && pending.c); },
    // какие клиенты видны на этом устройстве
    get profiles() {
      const c = cfg?.c || pending?.c;
      if (c) return [c];
      return Object.keys(S.names).filter(id => !S.meta.deletedClients[id]);
    }
  };
})();
