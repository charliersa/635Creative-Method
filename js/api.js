// 與 Google Apps Script 網頁應用程式溝通。
// POST 用 text/plain，避免瀏覽器發 CORS 預檢（Apps Script 不支援 OPTIONS）。
// 若 config.js 還沒填 API_URL，改用「本機模式」：資料只存在這台瀏覽器，方便預覽與測試。
window.SheetAPI = (() => {
  const url = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || "").trim();
  return url ? remoteAPI(url) : localAPI();

  function remoteAPI(url) {
    async function unwrap(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.ok) throw Object.assign(new Error(data.error || "server_error"), { code: data.error });
      return data;
    }
    return {
      configured: true,
      async state() {
        const res = await fetch(url + "?action=state&t=" + Date.now(), { cache: "no-store" });
        return (await unwrap(res)).state;
      },
      async call(action, body = {}, { keepalive = false } = {}) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action, ...body }),
          keepalive,
        });
        return unwrap(res);
      },
    };
  }

  // 本機模式：與 apps-script/Code.gs 相同的規則，但存在 localStorage。
  function localAPI() {
    const N = 6, KEY = "635local";
    const sheetFor = (seat, round) => (((seat - round) % N) + N) % N + 1;
    const blank = () => {
      const sheets = {};
      for (let k = 1; k <= N; k++) { sheets[k] = {}; for (let r = 1; r <= N; r++) sheets[k]["r" + r] = { i1: "", i2: "", i3: "" }; }
      return { topic: "", round: 1, epoch: 0, slots: Array(N).fill(""), sheets };
    };
    let mem = null;
    const load = () => {
      try { return JSON.parse(localStorage.getItem(KEY)) || mem || blank(); } catch (e) { return mem || blank(); }
    };
    const save = db => { mem = db; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} };
    const view = db => ({
      topic: db.topic, round: db.round, epoch: db.epoch,
      seated: db.slots.filter(Boolean).length, sheets: db.sheets,
    });
    const fail = code => Promise.reject(Object.assign(new Error(code), { code }));

    const actions = {
      claim(db, p) {
        let i = db.slots.indexOf(p.token);
        if (i < 0) { i = db.slots.indexOf(""); if (i < 0) return { seat: 0, full: true }; db.slots[i] = p.token; }
        return { seat: i + 1 };
      },
      save(db, p) {
        const seat = db.slots.indexOf(p.token) + 1;
        if (!seat) throw "not_seated";
        const k = sheetFor(seat, p.round);
        db.sheets[k]["r" + p.round]["i" + p.j] = String(p.text || "");
        return { sheet: k };
      },
      topic(db, p) { db.topic = String(p.topic || ""); },
      round(db, p) { db.round = Math.max(1, Math.min(N, +p.round || 1)); },
      reset(db) { const t = db.topic, e = db.epoch + 1; Object.assign(db, blank(), { topic: t, epoch: e }); },
    };

    return {
      configured: false,
      async state() { return view(load()); },
      async call(action, body = {}) {
        const fn = actions[action];
        if (!fn) return fail("unknown_action");
        const db = load();
        try {
          const out = fn(db, body) || {};
          save(db);
          return { ok: true, state: view(db), ...out };
        } catch (code) {
          return fail(String(code));
        }
      },
    };
  }
})();
