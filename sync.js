"use strict";
/* Синхронизация через GitHub Gist.
   - У каждого профиля свой файл в gist, зашифрованный своим ключом (AES-GCM).
   - Ключ профиля «her» выводится из главного ключа (SHA-256), обратно — нельзя.
     Полный код (главный ключ) открывает оба профиля, код девушки — только её профиль.
   - Слияние: тренировки и замеры объединяются по id (побеждает более свежая правка),
     удаления — «надгробиями», план и имена — по времени изменения.
   - Настройки (токен, id gist'а, ключи) не попадают в резервную копию. */

const Sync = (() => {
  const CFG_KEY = "trainer.sync";
  const OLD_FILE = "trainer.enc.json";
  const fileOf = p => `trainer.${p}.enc.json`;
  const API = "https://api.github.com";
  const ALL = ["me", "her"];
  let cfg = null, busy = false, timer = null, status = { ok: null, msg: "", at: 0 };

  /* cfg: { t: токен, g: id gist, m?: главный ключ, keys: {me?, her}, p: ["me","her"] | ["her"] } */
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch { cfg = null; }
  const saveCfg = () => { try { cfg ? localStorage.setItem(CFG_KEY, JSON.stringify(cfg)) : localStorage.removeItem(CFG_KEY); } catch {} };

  /* ---- base64 / ключи / шифрование ---- */
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
  async function deriveHer(master) {
    const data = new Uint8Array([...unb64(master), ...new TextEncoder().encode("trainer/her")]);
    return b64(await crypto.subtle.digest("SHA-256", data));
  }
  async function fullCfg(t, g, master) {
    return { t, g, m: master, keys: { me: master, her: await deriveHer(master) }, p: ["me", "her"] };
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
  async function fileText(f) {
    if (!f) return "";
    return f.truncated ? (await fetch(f.raw_url, { cache: "no-store" })).text() : f.content;
  }
  async function readGist() { return gh(`/gists/${cfg.g}`); }

  /* ---- данные профиля ---- */
  function localPart(p) {
    return {
      app: "trainer", v: 2, profile: p,
      sessions: S.sessions.filter(s => s.profile === p),
      measures: S.measures.filter(m => m.profile === p),
      deleted: S.deleted || {},
      plan: S.plans[p], planTs: S.meta?.plansTs?.[p] || 0,
      names: S.names, namesTs: S.meta?.namesTs || 0
    };
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
  function mergePart(loc, rem) {
    const deleted = { ...(rem.deleted || {}) };
    Object.entries(loc.deleted || {}).forEach(([k, v]) => { deleted[k] = Math.max(v, deleted[k] || 0); });
    const remPlanNewer = rem.plan && (rem.planTs || 0) > (loc.planTs || 0);
    const remNamesNewer = rem.names && (rem.namesTs || 0) > (loc.namesTs || 0);
    return {
      app: "trainer", v: 2, profile: loc.profile, deleted,
      sessions: mergeList(loc.sessions, rem.sessions, deleted).filter(s => s.profile === loc.profile),
      measures: mergeList(loc.measures, rem.measures, deleted).filter(m => m.profile === loc.profile),
      plan: remPlanNewer ? rem.plan : loc.plan, planTs: remPlanNewer ? rem.planTs : loc.planTs,
      names: remNamesNewer ? rem.names : loc.names, namesTs: remNamesNewer ? rem.namesTs : loc.namesTs
    };
  }
  const sig = x => JSON.stringify([
    [...(x.sessions || [])].map(s => s.id + ":" + (s.ts || 0)).sort(),
    [...(x.measures || [])].map(s => s.id + ":" + (s.ts || 0)).sort(),
    Object.keys(x.deleted || {}).sort(), x.planTs || 0, x.namesTs || 0, x.names
  ]);
  function applyPart(part) {
    const p = part.profile;
    S.sessions = S.sessions.filter(s => s.profile !== p && !part.deleted[s.id]).concat(part.sessions);
    S.measures = S.measures.filter(m => m.profile !== p && !part.deleted[m.id]).concat(part.measures);
    Object.assign(S.deleted, part.deleted);
    if (part.plan && part.planTs !== (S.meta.plansTs[p] || 0)) {
      S.plans[p] = part.plan; S.meta.plansTs[p] = part.planTs;
      const d = S.drafts[p];
      if (d && !part.plan.days.some(x => x.id === d.dayId)) delete S.drafts[p];
    }
    if (part.names && part.namesTs > (S.meta.namesTs || 0)) { S.names = { ...S.names, ...part.names }; S.meta.namesTs = part.namesTs; }
  }

  /* ---- синхронизация ---- */
  async function syncNow(manual) {
    await ready;
    if (!cfg || busy) return;
    if (!navigator.onLine) { setStatus(false, "Нет интернета — синхронизируем позже"); return; }
    busy = true; setStatus(null, "Синхронизация…");
    try {
      const g = await readGist();
      // перенос со старого формата (один общий файл)
      let legacy = null;
      if (cfg.m && g.files?.[OLD_FILE]) {
        const txt = await fileText(g.files[OLD_FILE]);
        if (txt && txt.trim() && txt.trim() !== "{}") legacy = await decrypt(txt, cfg.m).catch(() => null);
      }
      let localChanged = false;
      const upload = {};
      for (const p of cfg.p) {
        const txt = await fileText(g.files?.[fileOf(p)]);
        let rem = txt && txt.trim() ? await decrypt(txt, cfg.keys[p]) : null;
        if (legacy?.sessions) {
          const old = {
            sessions: legacy.sessions.filter(s => s.profile === p), measures: (legacy.measures || []).filter(m => m.profile === p),
            deleted: legacy.deleted || {}, plan: legacy.plans?.[p], planTs: legacy.meta?.plansTs?.[p] || 0,
            names: legacy.names, namesTs: legacy.meta?.namesTs || 0
          };
          rem = rem ? mergePart({ ...old, profile: p }, rem) : { ...old, profile: p };
        }
        const loc = localPart(p);
        const merged = rem ? mergePart(loc, rem) : loc;
        if (sig(merged) !== sig(loc)) { applyPart(merged); localChanged = true; }
        if (!rem || sig(merged) !== sig(rem) || legacy) upload[fileOf(p)] = { content: await encrypt(merged, cfg.keys[p]) };
      }
      if (legacy && cfg.p.length === ALL.length) upload[OLD_FILE] = null;
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

  /* ---- коды подключения ---- */
  function code(kind) {
    if (kind === "her") return "TRN2." + b64url(JSON.stringify({ t: cfg.t, g: cfg.g, her: cfg.keys.her }));
    return "TRN2." + b64url(JSON.stringify({ t: cfg.t, g: cfg.g, m: cfg.m }));
  }
  async function parseCode(c) {
    c = c.trim();
    const [pre, body] = [c.slice(0, 5), c.slice(5)];
    if (pre !== "TRN1." && pre !== "TRN2.") throw new Error("Это не код подключения");
    let o; try { o = JSON.parse(unb64url(body)); } catch { throw new Error("Код повреждён — скопируйте целиком"); }
    if (!o.t || !o.g) throw new Error("Код неполный");
    if (pre === "TRN1." && o.k) return fullCfg(o.t, o.g, o.k);
    if (o.m) return fullCfg(o.t, o.g, o.m);
    if (o.her) return { t: o.t, g: o.g, keys: { her: o.her }, p: ["her"] };
    throw new Error("Код неполный");
  }
  // старые настройки (одним ключом) → новый формат
  let ready = Promise.resolve();
  if (cfg && cfg.k && !cfg.keys) ready = fullCfg(cfg.t, cfg.g, cfg.k).then(c => { cfg = c; saveCfg(); }).catch(() => {});

  async function create(token) {
    token = token.trim();
    if (!token) throw new Error("Вставьте токен");
    const master = b64(crypto.getRandomValues(new Uint8Array(32)));
    const prev = cfg;
    cfg = await fullCfg(token, "", master);
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
    const next = await parseCode(c);
    const prev = cfg; cfg = next;
    try {
      const g = await readGist();
      for (const p of cfg.p) { const t = await fileText(g.files?.[fileOf(p)]); if (t && t.trim()) await decrypt(t, cfg.keys[p]); }
    } catch (e) { cfg = prev; throw e; }
    saveCfg();
    if (cfg.p.length === 1) { S.ui.profile = cfg.p[0]; save(true); }
    await syncNow(false);
  }

  /* ---- раздел в «Ещё» ---- */
  function section() {
    if (!cfg) return `
      <h2>Синхронизация между устройствами</h2>
      <p>Тренировки объединяются через ваш GitHub. У каждого профиля свой ключ шифрования.</p>
      <div class="card">
        <b>Первое устройство (Артём)</b>
        <p class="sub" style="margin:6px 0 8px">1. Создайте токен: отметка <b>gist</b> уже стоит, срок — «No expiration», внизу «Generate token». Скопируйте его.</p>
        <a class="btn ghost" href="https://github.com/settings/tokens/new?scopes=gist&description=%D0%A2%D1%80%D0%B5%D0%BD%D0%B5%D1%80" target="_blank" rel="noopener">Открыть GitHub → создать токен</a>
        <p class="sub" style="margin:10px 0 6px">2. Вставьте токен и создайте хранилище:</p>
        <div class="form" style="grid-template-columns:1fr"><input id="syncToken" placeholder="ghp_…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <button class="btn" style="margin-top:10px" data-act="sync-create">Создать хранилище</button>
      </div>
      <div class="card">
        <b>Другое устройство</b>
        <p class="sub" style="margin:6px 0 8px">Вставьте код подключения с первого устройства.</p>
        <div class="form" style="grid-template-columns:1fr"><input id="syncCode" placeholder="TRN2.…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <button class="btn ghost" style="margin-top:10px" data-act="sync-connect">Подключиться по коду</button>
      </div>`;
    const full = cfg.p.length === ALL.length;
    return `
      <h2>Синхронизация</h2>
      <div class="card">
        <div id="syncStatus" class="sub" style="margin:0 0 10px">${statusHtml()}</div>
        <p class="sub" style="margin:0 0 10px">Доступ на этом устройстве: <b>${full ? "все профили" : "только «" + esc(S.names[cfg.p[0]]) + "»"}</b></p>
        <button class="btn" data-act="sync-now">Синхронизировать сейчас</button>
        ${full ? `
          <button class="btn ghost" data-act="sync-code" data-kind="her">Код для девушки (только её профиль)</button>
          <button class="btn ghost" data-act="sync-code" data-kind="full">Полный код (для своих устройств)</button>` : ""}
        <div id="syncCodeBox" class="hidden" style="margin-top:10px">
          <div id="syncCodeLabel" class="sub" style="margin:0 0 6px"></div>
          <textarea id="syncCodeText" readonly style="min-height:90px;font-size:12px;word-break:break-all"></textarea>
          <button class="btn ghost" style="margin-top:8px" data-act="sync-copy">Скопировать код</button>
        </div>
      </div>
      <p>Синхронизация идёт сама: при открытии приложения, после сохранения тренировки или замера и при появлении интернета.</p>
      <button class="btn danger" data-act="sync-off">Отключить синхронизацию на этом устройстве</button>`;
  }
  async function handle(act, el) {
    try {
      if (act === "sync-create") { await create(document.getElementById("syncToken").value); toast("Хранилище создано"); render(); }
      else if (act === "sync-connect") { await connect(document.getElementById("syncCode").value); toast("Подключено"); render(); }
      else if (act === "sync-now") await syncNow(true);
      else if (act === "sync-code") {
        const kind = el?.dataset.kind || "full";
        document.getElementById("syncCodeBox").classList.remove("hidden");
        document.getElementById("syncCodeLabel").textContent = kind === "her"
          ? `Для «${S.names.her}»: откроет только её профиль, ваши тренировки ей не видны.`
          : "Полный доступ ко всем профилям. Только для ваших устройств — никому не отправляйте.";
        document.getElementById("syncCodeText").value = code(kind);
      }
      else if (act === "sync-copy") {
        const t = document.getElementById("syncCodeText");
        try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand("copy"); }
        toast("Код скопирован");
      }
      else if (act === "sync-off") {
        if (!confirm("Отключить синхронизацию? Данные на устройстве и в облаке останутся.")) return;
        cfg = null; saveCfg(); status = { ok: null, msg: "", at: 0 }; render();
      }
    } catch (e) { toast(e.message || String(e)); }
  }

  window.addEventListener("online", () => schedule());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });

  return {
    syncNow, schedule, section, handle,
    get on() { return !!cfg; },
    get profiles() { return cfg?.p || ALL; }
  };
})();
