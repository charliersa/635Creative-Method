/**
 * 635 創意發想表 — Google Sheet 後端（Google Apps Script）
 *
 * 部署方式見 README.md。重點：
 *   1. 從試算表的「擴充功能 → Apps Script」開啟，貼上本檔。
 *   2. 部署 → 新增部署作業 → 網頁應用程式
 *      執行身分：我；誰可以存取：所有人。
 *   3. 把部署網址填進 js/config.js 的 API_URL。
 *
 * 試算表分頁（第一次呼叫時會自動建立）：
 *   設定：主題、目前輪次、清空次數(epoch)
 *   座位：6 個匿名座位與佔用者代號
 *   構想：6 張表 × 6 輪，每列 3 個構想
 */

const N = 6;
// 若這個 Apps Script 不是從試算表「擴充功能」開的，請填試算表網址中 /d/ 和 /edit 之間那串 ID。
const SPREADSHEET_ID = '';
const TAB = { session: '設定', slots: '座位', ideas: '構想' };

// ───────── 進入點 ─────────

function doGet(e) {
  return json_(handle_((e && e.parameter) || {}));
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  return json_(handle_(p));
}

function handle_(p) {
  try {
    const action = p.action || 'state';
    if (action === 'state') return { ok: true, state: readState_() };

    const fn = ACTIONS[action];
    if (!fn) return { ok: false, error: 'unknown_action' };

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const out = fn(p) || {};
      SpreadsheetApp.flush();
      return Object.assign({ ok: true, state: readState_() }, out);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────── 寫入動作（皆在鎖內執行） ─────────

const ACTIONS = {
  /** 匿名入座：同一代號回到原座位，否則找第一個空位。 */
  claim(p) {
    const token = cleanToken_(p.token);
    const sh = slotsSheet_();
    const rows = sh.getRange(2, 1, N, 2).getValues();
    const mine = rows.findIndex(r => String(r[1]) === token);
    if (mine >= 0) return { seat: mine + 1 };
    const free = rows.findIndex(r => !r[1]);
    if (free < 0) return { seat: 0, full: true };
    sh.getRange(free + 2, 2, 1, 2).setValues([[token, new Date()]]);
    return { seat: free + 1 };
  },

  /** 儲存一個構想。表單編號由伺服器依座位與輪次計算，避免寫錯表。 */
  save(p) {
    const seat = seatOf_(cleanToken_(p.token));
    if (!seat) throw new Error('not_seated');
    const round = clampInt_(p.round, 1, N);
    const j = clampInt_(p.j, 1, 3);
    const k = sheetFor(seat, round);
    const row = 2 + (k - 1) * N + (round - 1);
    const sh = ideasSheet_();
    sh.getRange(row, 2 + j).setValue(asText_(p.text, 2000));
    sh.getRange(row, 6).setValue(new Date());
    return { sheet: k };
  },

  topic(p) {
    sessionSheet_().getRange(2, 2).setValue(asText_(p.topic, 500));
  },

  round(p) {
    sessionSheet_().getRange(3, 2).setValue(clampInt_(p.round, 1, N));
  },

  /** 清空：輪次回到 1、清掉所有構想與座位，epoch +1 讓其他瀏覽器重新入座。 */
  reset() {
    const ss = sessionSheet_();
    const epoch = Number(ss.getRange(4, 2).getValue()) || 0;
    ss.getRange(3, 2, 2, 1).setValues([[1], [epoch + 1]]);
    ideasSheet_().getRange(2, 3, N * N, 4).clearContent();
    slotsSheet_().getRange(2, 2, N, 2).clearContent();
  },
};

// ───────── 讀取 ─────────

function readState_() {
  const s = sessionSheet_().getRange(2, 2, 3, 1).getValues();
  const ideas = ideasSheet_().getRange(2, 1, N * N, 5).getValues();
  const slots = slotsSheet_().getRange(2, 2, N, 1).getValues();

  const sheets = {};
  for (let k = 1; k <= N; k++) sheets[k] = {};
  ideas.forEach(([k, r, i1, i2, i3]) => {
    if (sheets[k]) sheets[k]['r' + r] = { i1: String(i1), i2: String(i2), i3: String(i3) };
  });

  return {
    topic: String(s[0][0] || ''),
    round: clampInt_(s[1][0], 1, N),
    epoch: Number(s[2][0]) || 0,
    seated: slots.filter(r => r[0]).length,
    sheets,
  };
}

// ───────── 分頁（不存在就自動建立） ─────────

function tab_(name, header, init) {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到試算表：請在 Code.gs 填入 SPREADSHEET_ID');
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    init(sh);
  }
  return sh;
}

function sessionSheet_() {
  return tab_(TAB.session, ['項目', '值'], sh =>
    sh.getRange(2, 1, 3, 2).setValues([['主題', "'仿生共享嬰兒車"],['目前輪次', 1], ['清空次數', 0]]));
}

function slotsSheet_() {
  return tab_(TAB.slots, ['座位', '代號', '加入時間'], sh =>
    sh.getRange(2, 1, N, 3).setValues(range_(N).map(i => [i, '', ''])));
}

function ideasSheet_() {
  return tab_(TAB.ideas, ['表單', '輪次', '構想1', '構想2', '構想3', '更新時間'], sh => {
    const rows = [];
    for (let k = 1; k <= N; k++) for (let r = 1; r <= N; r++) rows.push([k, r, '', '', '', '']);
    sh.getRange(2, 1, rows.length, 6).setValues(rows);
    sh.setColumnWidths(3, 3, 260);
    sh.getRange(2, 3, rows.length, 3).setWrap(true);
  });
}

/** 手動執行一次可預先建立分頁（非必要，第一次呼叫 API 也會建立）。 */
function setup() {
  sessionSheet_();
  slotsSheet_();
  ideasSheet_();
}

// ───────── 工具 ─────────

/** 第 round 輪時，座位 seat 手上的表單編號（每輪往下一位傳）。 */
function sheetFor(seat, round) {
  return ((((seat - round) % N) + N) % N) + 1;
}

function seatOf_(token) {
  const rows = slotsSheet_().getRange(2, 2, N, 1).getValues();
  return rows.findIndex(r => String(r[0]) === token) + 1;
}

function cleanToken_(t) {
  const s = String(t || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  if (s.length < 8) throw new Error('bad_token');
  return s;
}

function clampInt_(v, lo, hi) {
  const n = Math.round(Number(v)) || lo;
  return Math.max(lo, Math.min(hi, n));
}

/** 前面加 ' 讓試算表一律當純文字存（避免 =、數字、日期被轉換）。 */
function asText_(v, max) {
  const s = String(v == null ? '' : v).slice(0, max);
  return s ? "'" + s : '';
}

function range_(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}
