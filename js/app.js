(() => {
  const N = 6;
  const { POLL_MS = 3000, SAVE_MS = 700, DEFAULT_TOPIC = "" } = window.APP_CONFIG || {};
  const api = window.SheetAPI;

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /** 第 round 輪時，座位 seat 手上的表單編號（與後端 sheetFor 相同）。 */
  const sheetFor = (seat, round) => (((seat - round) % N) + N) % N + 1;

  // ───────── 狀態 ─────────

  const state = { topic: "", round: 1, epoch: null, sheets: {} };
  const cell = (k, r) => (state.sheets[k] && state.sheets[k]["r" + r]) || {};

  // 匿名身分：瀏覽器記住一組代號，座位由後端分配（同代號會回到同座位）。
  const me = { seat: 0, full: false, token: loadToken() };

  function loadToken() {
    try {
      const t = localStorage.getItem("635token");
      if (t) return t;
    } catch (e) {}
    const t = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem("635token", t); } catch (e) {}
    return t;
  }

  // ───────── 同步 ─────────
  // 寫入進行中或剛寫完時，丟掉較早發出的輪詢結果，避免畫面被舊資料蓋回去。

  let pendingWrites = 0;
  let lastWriteAt = 0;
  let polling = false;

  async function write(action, body, opts) {
    pendingWrites++;
    try {
      const res = await api.call(action, body, opts);
      lastWriteAt = Date.now();
      if (pendingWrites === 1 && res.state) applyState(res.state);
      setConn(true);
      return res;
    } catch (err) {
      if (err.code === "not_seated") claimSeat();
      throw err;
    } finally {
      pendingWrites--;
    }
  }

  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    const startedAt = Date.now();
    try {
      const st = await api.state();
      if (pendingWrites === 0 && startedAt >= lastWriteAt) applyState(st);
      setConn(true);
    } catch (err) {
      setConn(false);
    } finally {
      polling = false;
    }
  }

  function applyState(st) {
    const epochChanged = state.epoch !== null && st.epoch !== state.epoch;
    Object.assign(state, { topic: st.topic, round: st.round, epoch: st.epoch, sheets: st.sheets || {} });
    if (epochChanged) {           // 主持人清空了：重新入座
      me.seat = 0;
      me.full = false;
      claimSeat();
    }
    render();
  }

  async function claimSeat() {
    try {
      const res = await write("claim", { token: me.token });
      me.seat = res.seat || 0;
      me.full = !!res.full;
    } catch (err) {
      me.seat = 0;
    }
    render();
  }

  function setConn(ok) {
    const c = $("conn");
    c.textContent = !ok ? "連線中斷，正在重試…"
      : api.configured ? "已連線，匿名填寫，內容自動同步到 Google 試算表"
      : "本機模式：內容只存在這台瀏覽器（在 js/config.js 填入 API_URL 即可串接 Google 試算表）";
    c.classList.toggle("err", !ok);
  }

  // ───────── 自動儲存（每格延遲送出，離開頁面時立即送出） ─────────

  const timers = new Map();      // key -> {id, fn}
  const dirty = {};              // j -> 尚未寫入的輸入

  function schedule(key, fn) {
    if (timers.has(key)) clearTimeout(timers.get(key).id);
    const run = (leaving) => { timers.delete(key); fn(leaving); };
    timers.set(key, { id: setTimeout(run, SAVE_MS), run });
  }
  function flushAll() {
    for (const { id, run } of [...timers.values()]) { clearTimeout(id); run(true); }
  }

  function onIdeaInput(e) {
    if (!me.seat) return;
    const ta = e.target, j = +ta.dataset.j, r = state.round, k = sheetFor(me.seat, r);
    const st = $("saveState");
    dirty[j] = true;
    st.textContent = "輸入中…"; st.className = "save";

    schedule(`i${j}-${k}-${r}`, async (leaving) => {
      const text = ta.value;
      try {
        await write("save", { token: me.token, round: r, j, text }, { keepalive: !!leaving });
        if (ta.value === text) dirty[j] = false;
        st.textContent = "已儲存"; st.className = "save ok";
      } catch (err) {
        st.textContent = "儲存失敗，請再輸入一次"; st.className = "save err";
      }
    });
  }

  // ───────── 主持人 ─────────

  function onTopicInput(e) {
    state.topic = e.target.value;
    renderTopic();
    schedule("topic", () => write("topic", { topic: state.topic }).catch(() => {}));
  }

  function goRound(d) {
    const r = Math.max(1, Math.min(N, state.round + d));
    if (r === state.round) return;
    flushAll();                  // 換輪前先把這輪的輸入存好
    state.round = r;
    render();
    write("round", { round: r }).catch(() => {});
  }

  let armTimer;
  async function onReset(e) {
    const b = e.currentTarget;
    const disarm = () => { b.classList.remove("armed"); b.textContent = "清空所有填寫內容"; };
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      b.textContent = "再按一次確認清空";
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(armTimer);
    disarm();
    try { await write("reset", {}); } catch (err) {}
    // applyState 偵測到 epoch 改變後會自動重新入座
  }

  // ───────── 畫面 ─────────

  function renderTopic() {
    $("topic").innerHTML = "主題：<b>" + esc(state.topic || DEFAULT_TOPIC || "尚未設定") + "</b>";
  }

  const ideasList = p => [1, 2, 3].map(j => p["i" + j]).filter(Boolean);
  const roundBlock = (i, items) =>
    `<div class="prev-round"><div class="who">第 ${i} 輪</div><ol>${items.map(t => `<li>${esc(t)}</li>`).join("")}</ol></div>`;

  let lastKey = "";
  function renderMine() {
    const r = state.round;
    if (!me.seat) {
      $("sheetNo").textContent = "—";
      $("pick").hidden = false;
      $("mine").hidden = true;
      $("prevBox").hidden = true;
      $("pick").textContent = me.full
          ? "本組 6 個位置都已有人填寫。如果你是新的一組，請主持人先清空內容。"
          : "正在為你分配表單…";
      return;
    }

    const k = sheetFor(me.seat, r), key = k + "-" + r, c = cell(k, r);
    const switched = key !== lastKey;
    $("sheetNo").textContent = "你手上：表單 " + k;
    $("pick").hidden = true;
    $("mine").hidden = false;

    for (let j = 1; j <= 3; j++) {
      const ta = $("i" + j);
      $("c" + j).textContent = `${k}-${r}-${j}`;
      if (switched) dirty[j] = false;
      // 正在打字或還沒存好的欄位不要被伺服器資料蓋掉
      if (switched || (!dirty[j] && document.activeElement !== ta)) ta.value = c["i" + j] || "";
    }
    if (switched) { $("saveState").textContent = "內容會自動儲存"; $("saveState").className = "save"; }
    lastKey = key;

    let html = "";
    for (let i = 1; i < r; i++) {
      const p = cell(k, i);
      html += roundBlock(i, [1, 2, 3].map(j => p["i" + j] || "（空白）"));
    }
    $("prev").innerHTML = html;
    $("prevBox").hidden = r === 1;
  }

  function renderAll() {
    let html = "";
    for (let k = 1; k <= N; k++) {
      let rows = "";
      for (let i = 1; i <= N; i++) {
        const items = ideasList(cell(k, i));
        if (items.length) rows += roundBlock(i, items);
      }
      html += `<div class="sheet"><h3>表單 ${k}</h3>${rows || '<p class="hint">還沒有內容</p>'}</div>`;
    }
    $("all").innerHTML = html;
  }

  function render() {
    renderTopic();
    if (document.activeElement !== $("s_topic") && !timers.has("topic")) $("s_topic").value = state.topic || "";
    $("roundNo").textContent = state.round;
    $("b_prev").disabled = state.round <= 1;
    $("b_next").disabled = state.round >= N;
    renderMine();
    renderAll();
  }

  // ───────── 啟動 ─────────

  ["i1", "i2", "i3"].forEach(id => $(id).addEventListener("input", onIdeaInput));
  $("s_topic").addEventListener("input", onTopicInput);
  $("b_prev").onclick = () => goRound(-1);
  $("b_next").onclick = () => goRound(1);
  $("b_reset").onclick = onReset;
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushAll(); else poll(); });

  render();

  (async () => {
    await poll();
    await claimSeat();
    setInterval(poll, POLL_MS);
  })();
})();
