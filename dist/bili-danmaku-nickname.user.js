// ==UserScript==
// @name         B站(bilibili)直播画面弹幕昵称标注
// @namespace    https://live.bilibili.com/
// @version      2.6.2
// @description  仅增强B站直播画面上的飘动弹幕：显示发送者昵称，标注粉丝数/已关注/自定义名单/粉丝牌/等级/舰长/房管，悬停出身份卡。
// @author       Loki-kiki
// @homepageURL  https://github.com/Loki-kiki/bili-danmaku-nickname
// @supportURL   https://github.com/Loki-kiki/bili-danmaku-nickname/issues
// @updateURL    https://raw.githubusercontent.com/Loki-kiki/bili-danmaku-nickname/main/dist/bili-danmaku-nickname.user.js
// @downloadURL  https://raw.githubusercontent.com/Loki-kiki/bili-danmaku-nickname/main/dist/bili-danmaku-nickname.user.js
// @match        https://live.bilibili.com/*
// @icon         https://static.hdslb.com/images/favicon.ico
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      api.live.bilibili.com
// @connect      broadcastlv.chat.bilibili.com
// @connect      *.chat.bilibili.com
// @connect      i0.hdslb.com
// @connect      *.hdslb.com
// @license      MIT
// ==/UserScript==
(function () {
  "use strict";
  const VERSION = "2.6.2";
// ===== 00-base.js =====
// ===== 全局常量与运行态 =====
// VERSION 由 build.js 在文件头注入（单一来源：version.js）

const SCRIPT = "BiliLiveFloatDanmakuNick";

// ⚠️ 三个存储键必须与 v1.0.41 字节一致：Tampermonkey 按 @name+@namespace 认升级，
// 键名照抄旧版才能读到他攒下的配置、用户缓存和 210 条记录。
const STORE_KEY = "blfdn_settings_v1";
const USER_CACHE_KEY = "blfdn_user_cache_v1";
const HL_KEY = "blfdn_highlights_v1";

// 配置格式版本：读到没有 cfgVer 的老配置走一次性迁移
const CFG_VER = 4;

const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

// 弹幕容器与弹幕元素选择器（B站改版时优先改这里；诊断里会打印实际命中的选择器）
const DANMAKU_CONTAINER_SELECTOR =
  ".danmaku-item-container, [class*='danmaku-item-container'], [class*='bili-danmaku']";
const DANMAKU_ITEM_SELECTOR =
  ".bili-danmaku-x-dm, [class*='bili-danmaku-x-dm'], [class*='danmaku-x-dm']";

const state = {
  settings: null, // 由 config.js 填充
  users: {}, // uid -> {uid, uname, follower, followed, attribute, fetched, ts, retry}
  cards: new Map(), // uid -> {data, ts}（身份卡专用，悬停才查）
  queue: [], // 待配对弹幕（诊断用，真实配对在 matcher 里）
  room: { uid: 0, name: "", title: "" },
  stats: {
    packets: 0,
    msgPackets: 0,
    brotli: 0,
    captured: 0,
    matched: 0,
    matchFail: 0,
    api: 0,
    apiFail: 0,
    apiQueued: 0,
    apiRisk: 0,
    cmds: {},
    inflateFail: 0,
    handleFail: 0,
    dbg: { seen: 0, noUid: 0, noText: 0, sampleSaved: 0 },
    noUidSample: null,
    paintNoId: 0,
    paintNoName: 0,
    paintSame: 0,
    paintOk: 0,
    nickHidden: 0,   // 昵称被整段隐藏的累计次数（v2.5.0 起基本恒为 0，用于验收）
    runaway: 0,      // 熔断/补跑次数（v2.5.0 起写进诊断）
    staleSlot: 0,
    dupSlot: 0,
    rawSample: null,
    jsonFail: 0,
    recCaptured: 0,
    recDedup: 0,
    enter: 0,
    source: "未启动",
    selector: "-",
  },
  sockets: { live: null, heartbeat: 0, reconnect: 0, hostCursor: 0 },
  wbi: null,
  destroyed: false,
  started: false,
  panelOpen: false,
  recordOpen: false,
};

// 排障用：把当前走到哪一步写到 localStorage（进程卡死时换标签页也能读到）
function trace(step) {
  try {
    if (W.__bfTrace) {
      const key = "__bftrace";
      const prev = localStorage.getItem(key) || "";
      const lines = prev ? prev.split(String.fromCharCode(10)) : [];
      lines.push(String(step));
      localStorage.setItem(key, lines.slice(-80).join(String.fromCharCode(10)));
    }
  } catch (_) {}
}

function log(...args) {
  if (state.settings && state.settings.debug) console.log(`[${SCRIPT}]`, ...args);
}

function warn(...args) {
  console.warn(`[${SCRIPT}]`, ...args);
}

// ===== 05-util.js =====
// ===== 通用工具 =====

// 零宽字符 / 全角空格清理 + 连续空白归一：DOM 读回来的文本和 WS 原文必须用同一把尺子
function normalizeText(text) {
  return String(text == null ? "" : text)
    .replace(/[\u200B-\u200F\u2028-\u202F\u205F-\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(name) {
  return normalizeText(name).toLocaleLowerCase();
}

// 表情图片 URL → 文件 key（去掉 query、@缩放后缀、扩展名）
function emoticonFileKey(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  u = u.split(/[?#]/)[0];
  u = u.substring(u.lastIndexOf("/") + 1);
  u = u.split("@")[0];
  u = u.replace(/\.(png|gif|webp|jpg|jpeg)$/i, "");
  return u.toLowerCase();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// 50000 → 5.0万，1234 → 1234
function formatCount(n) {
  const v = Number(n || 0);
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return String(v);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ===== 配对主键 =====
// B站 弹幕渲染器（danmaku-v2.js）的 textData 里有 dmid / uid / isMine，但**一个都不写进 DOM**：
//   实测弹幕元素只有 class 和 style（--color / --fontSize / --offset / --translateX / --duration / --top），
//   没有 data-dmid、没有 id、也没有挂实例（elOwnProps 为空）。
// 所以配对只能靠「文本 + FIFO」。同文本多人同时发时（实测一条「？」来自 7 个不同 uid）必然串人 ——
//   这就是 Master 自己发弹幕时看到的「id 匹配错」。
// 但 DOM 的 --color / --fontSize 是 WS 包 info[0][3] / info[0][2] 的直写，可以当**强指纹**：
//   先按「指纹+文本」找，找不到再退回纯文本 FIFO。纯增益，不会造成新漏标。
function pairKey(text, fp) {
  const t = text || "";
  const f = fp || "";
  return f ? f + "\u0001" + t : t;
}

/** DOM 侧指纹：读 B站 写在元素 inline style 上的 CSS 变量（读不到就返回空，退化为纯文本配对）
 *  注意必须**归一化**：B站 可能写 #fff / transparent / 带空格的 25px，
 *  只有和 WS 侧同一套尺子（#rrggbb + Npx）比对才有意义。
 *  任一部分非法就只留另一部分 —— 宁可少拦，不可错拦。 */
function domFingerprint(el) {
  try {
    const rawColor = String(el.style.getPropertyValue("--color") || "").trim();
    const rawSize = String(el.style.getPropertyValue("--fontSize") || "").trim();
    const color = normalizeColor(rawColor, "").toLowerCase(); // 非法（如 transparent）→ ""；统一小写
    const sizeNum = parseFloat(rawSize);
    const size = isFinite(sizeNum) && sizeNum > 0 ? Math.round(sizeNum) + "px" : "";
    if (!color && !size) return "";
    return color + "|" + size;
  } catch (_) {
    return "";
  }
}

/** v2.6.2 回收痕迹：class 旧值里没有任何「活动态」标记（-roll / -show / -center / -dm-fixed）
 *  → 这次 class 变更之前元素躺在池子里，现在被拿出来渲染下一条了。
 *  实测（2026-11-27 545068 房间，生命周期探针）：飘完时 class 收成光秃秃的 `bili-danmaku-x-dm`，
 *  复用时先整段换子节点（child +1/-1），再 `-dm` → `-dm -roll` → `-dm -roll -show`；
 *  回收和复用常落在同一批 MutationRecord 里，回调时元素看上去一直是活的，只有 oldValue 留得下这一笔。
 *  （更早版本 destroy 写成 bili-danmaku-x-<id>，同样没有活动标记，一并覆盖。）
 *  整词匹配：-dm-vip / -dm-rotate 不算活动标记。null/空串（新建元素）不算。 */
const LIVE_CLASS_RE = /(^|\s)bili-danmaku-x-(roll|show|center|dm-fixed)(\s|$)/;
function isPooledClass(old) {
  if (typeof old !== "string" || !old) return false;
  return !LIVE_CLASS_RE.test(old);
}

// 把 "123456" 或 "#aabbcc" 或 "aabbcc" 统一成 #rrggbb；非法返回空串
function normalizeColor(v, fallback) {
  const s = String(v || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return "#" + s.slice(1).split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-f]{6}$/i.test(s)) return "#" + s;
  return fallback || "";
}

// B站粉丝牌颜色是十进制整数（RGB）
function medalColorFromInt(n) {
  const v = Number(n || 0);
  if (!v) return "";
  const hex = (v & 0xffffff).toString(16).padStart(6, "0");
  return "#" + hex;
}

function debounce(fn, ms) {
  let t = 0;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

// ===== 10-config.js =====
// ===== 配置：默认值 / 读取 / 一次性迁移 =====

// 老键全部保留（值沿用他 v1.0.41 里的习惯），新键追加在下面
const DEFAULTS = {
  // —— v1 已有键，一个都不能少 ——
  enabled: true,
  showNick: true,
  nickSeparator: ":",
  fanMark: true,
  fanThreshold: 50000,
  fanBadge: "⭐",
  fanColor: "#ffd166",
  fanGlow: true,
  followMark: true,
  followBadge: "❤",
  followColor: "#fb7299",
  followGlow: true,
  customFollowMark: false,
  customFollowNames: "",
  customFollowBadge: "◆",
  customFollowColor: "#22d3ee",
  customFollowGlow: true,
  emojiNick: true,
  recordEnabled: true,
  recordPersist: true,
  theme: "dark",
  panelOpen: false,
  panelX: 24,
  panelY: 96,
  panelW: 0,
  panelH: 0,
  toggleX: 24,
  toggleY: 96,
  recX: 120,
  recY: 100,
  moreOpen: false,
  debug: false,

  // —— v2 新增 ——
  nickSmallChars: 8, // 昵称超过几个字就缩成小字
  nickSmallSize: 12, // 小字字号（px）
  medalMark: false, // 粉丝牌等级（默认关：会撑宽弹幕）
  medalMinLevel: 10, // 只在 >= 该等级时显示
  levelMark: false, // B站用户等级（Lv.6 太普遍，默认关）
  levelMinLevel: 6,
  guardMark: false, // 舰长/提督/总督（默认关）
  adminMark: false, // 房管（默认关）
  hoverCard: true, // 悬停出身份卡 + 暂停这一条
  apiMode: "all", // all=都查 / worthy=只查值得的人
  apiConcurrency: 5,
  apiIntervalMs: 60,
  keywordRules: "", // 每行 关键词 或 关键词:颜色
  keywordColor: "#ff5c5c",
  keywordGlow: true,
  watchNames: "", // 指定人（昵称，一行一个），保存时解析成 UID
  watchUids: "", // 解析后的 UID，逗号分隔
  watchEnter: true, // 指定人进直播间提示
  topTalkerMark: false, // 熟面孔排名（默认关）
  topTalkerCount: 10,
  // —— v2.6 高光效果（每档可多选，逗号分隔：card=底牌 / orbit=绕行光段 / ripple=入场涟漪）——
  // 分档原则：越贵的效果给越少的人。同屏全是高光 = 没有高光。
  customFollowFx: "card,orbit,ripple", // 自定义名单 / 指定人：最高档
  followFx: "card,ripple", // 已关注
  fanFx: "card", // 粉丝数达标
  keywordFx: "", // 关键词：保持换色即可（命中面广，加框会满屏）
  cfgVer: CFG_VER,
};

function gmGet(key, fallback) {
  try {
    const v = GM_getValue(key, fallback);
    return v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function gmSet(key, value) {
  try {
    GM_setValue(key, value);
  } catch (_) {
    debugLog("gm-set-fail", { key });
  }
}

// 纯函数：迁移只动「明显是旧格式/旧默认残留」的字段，用户自己调过的一律不碰
function migrateSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = Object.assign({}, DEFAULTS, src);
  const from = Number(src.cfgVer || 0);
  if (from >= CFG_VER) return out;

  // v1→v2：emojiNick 老默认 false（当时实现有 bug，他只好关掉）。
  // 新版表情弹幕昵称是必须项，这里把「仍是老默认 false」的一次性打开；真的想要 false 的人在面板里关掉即可。
  // ★ CFG_VER 升到 4 后必须加 from<3 门控，否则 v3 用户主动关掉的 emojiNick 会被重新打开
  if (from < 3 && src.emojiNick === false) out.emojiNick = true;

  // v2→v3：v2.0.0 把粉丝牌/舰长/房管/排名默认打开，真机实测会把弹幕撑宽、同轨互相压字。
  // 这几项改为默认关（详细信息移到悬停身份卡）。只动「还是默认值 true」的，用户主动关过的保持。
  if (from < 3) {
    out.medalMark = false;
    out.guardMark = false;
    out.adminMark = false;
    out.topTalkerMark = false;
  }

  // v3→v4（2.6.0）：◆ 默认色 #0011ff 深蓝在暗底牌上看不清，最高档反而最不显眼，默认改青色。
  // 只换「仍是旧默认值」的；用户在面板里挑过别的颜色保持不动。
  if (from < 4 && String(src.customFollowColor || "").toLowerCase() === "#0011ff") {
    out.customFollowColor = DEFAULTS.customFollowColor;
  }

  // 老版「自定义名单」是昵称字符串，v2 仍然兼容（保存时顺带解析 UID），不需要改写文本
  out.cfgVer = CFG_VER;
  return out;
}

function loadSettings() {
  const raw = safeJsonParse(gmGet(STORE_KEY, "{}"), {});
  return migrateSettings(raw);
}

function saveSettings() {
  // ★ 2026-11-19 v2.5.0：三个浮层的位置以「DOM 上真实显示的 style」为唯一来源。
  //   拖动中 state.settings 会被别的路径覆盖（真机实测 style=920 而存储仍是 460），
  //   收敛到落盘这个唯一出口后，任何一次保存都带着用户真正看到的位置。
  //   元素还没建好（启动早期）时 getElementById 为 null，直接跳过，不产生副作用。
  const syncPos = (id, kx, ky) => {
    const el = document.getElementById(id);
    if (!el) return;
    const x = parseFloat(el.style.left);
    const y = parseFloat(el.style.top);
    if (isFinite(x)) state.settings[kx] = x;
    if (isFinite(y)) state.settings[ky] = y;
  };
  syncPos("bf-panel", "panelX", "panelY");
  syncPos("bf-orb", "toggleX", "toggleY");
  syncPos("bf-rec", "recX", "recY");
  gmSet(STORE_KEY, JSON.stringify(state.settings));
}

function debugLog(type, payload) {
  if (!state.settings || !state.settings.debug) return;
  console.log(`[${SCRIPT}] ${type}`, payload);
}

// ===== 用户缓存（粉丝数/关注关系）=====
function loadUserCache() {
  const raw = safeJsonParse(gmGet(USER_CACHE_KEY, "{}"), {});
  const now = Date.now();
  const out = {};
  for (const uid of Object.keys(raw || {})) {
    const item = raw[uid];
    if (!item || typeof item !== "object") continue;
    if (now - Number(item.ts || 0) > 6 * 60 * 60 * 1000) continue; // 6 小时过期
    out[uid] = item;
  }
  return out;
}

let cacheSaveTimer = 0;
function saveUserCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    const entries = Object.entries(state.users)
      .sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0))
      .slice(0, 3000);
    gmSet(USER_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  }, 1500);
}

// ===== 12-md5.js =====
// ===== MD5（从 v1.0.41 原样搬入：WBI 签名 r_rid 要用，这段是试错试出来的，别重写） =====
function md5(input) {
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function md5blk(s) {
    const blocks = [];
    for (let i = 0; i < 64; i += 4) {
      blocks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return blocks;
  }
  function md51(s) {
    const n = s.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    const tail = Array(16).fill(0);
    for (i = 0; i < s.length; i += 1) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      tail.fill(0);
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j += 1) s += (`0${((n >> (j * 8)) & 255).toString(16)}`).slice(-2);
    return s;
  }
  return md51(unescape(encodeURIComponent(input))).map(rhex).join("");
}

// ===== 15-protocol.js =====
// ===== 协议层：HTTP / WBI 签名 / WS 弹幕流 =====
// 本层完全沿用 v1.0.41 里跑通的实现（WBI 签名、protover 2、心跳、重连），只把回调解耦出去。

function requestJson(url) {
  return new Promise((resolve, reject) => {
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        anonymous: false,
        withCredentials: true,
        timeout: 8000,
        headers: { Referer: "https://live.bilibili.com/" },
        onload: (res) => {
          const status = Number(res && res.status) || 0;
          // ★ B站 风控有两种形态，必须都认：
          //   ① JSON 里 code: -412（接口层限流）
          //   ② HTTP 412 + HTML 响应体（网关层拦截，实测 api.bilibili.com 直接返回 <!DOCTYPE html>）
          //   只认 ① 的话，② 会被当成「bad json」计入 apiFail，退避机制永远不触发 ——
          //   真机实测：一个房间 314 次请求 293 次失败，全是 412 打回来的 HTML。
          if (status === 412 || status === 429) {
            const riskErr = new Error("http risk " + status);
            riskErr.riskCode = -412;
            reject(riskErr);
            return;
          }
          const text = typeof res.responseText === "string" ? res.responseText : String(res.response || "");
          if (!text) {
            reject(new Error("empty response: " + url));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error("bad json: " + url));
          }
        },
        onerror: (err) => reject(new Error("request error: " + url + " " + ((err && err.status) || ""))),
        ontimeout: () => reject(new Error("request timeout: " + url)),
      });
    } catch (err) {
      reject(err);
    }
  });
}

function shortError(err) {
  const text = String((err && err.message) || err || "unknown");
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

function getRoomIdFromUrl() {
  const m = location.pathname.match(/^\/(\d+)/);
  return m ? m[1] : "";
}

function getRealRoomId(id) {
  return requestJson("https://api.live.bilibili.com/room/v1/Room/room_init?id=" + encodeURIComponent(id)).then(
    (json) => (json && json.code === 0 && json.data && json.data.room_id ? Number(json.data.room_id) : Number(id))
  );
}

// ===== WBI 签名（getDanmuInfo 必须带）=====
const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function extractFileKey(url) {
  const m = String(url || "").match(/\/([^/?#]+)\.(?:png|jpg|webp)$/);
  return m ? m[1] : "";
}

function getWbiKeys() {
  if (state.wbi && Date.now() - state.wbi.ts < 30 * 60 * 1000) return Promise.resolve(state.wbi);
  return requestJson("https://api.bilibili.com/x/web-interface/nav").then((json) => {
    const img = json && json.data && json.data.wbi_img;
    const imgKey = extractFileKey(img && img.img_url);
    const subKey = extractFileKey(img && img.sub_url);
    if (!imgKey || !subKey) throw new Error("Wbi keys missing");
    state.wbi = { imgKey, subKey, ts: Date.now() };
    return state.wbi;
  });
}

function wbiQuery(params) {
  return getWbiKeys().then(({ imgKey, subKey }) => {
    const mixinKey = WBI_MIXIN_TABLE.map((n) => `${imgKey}${subKey}`[n]).join("").slice(0, 32);
    const signed = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
    const query = Object.keys(signed)
      .sort()
      .map((key) => {
        const value = String(signed[key]).replace(/[!'()*]/g, "");
        return encodeURIComponent(key) + "=" + encodeURIComponent(value);
      })
      .join("&");
    return query + "&w_rid=" + md5(query + mixinKey);
  });
}

function getDanmuConfFallback(roomId) {
  return requestJson(
    "https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=" + encodeURIComponent(roomId) + "&platform=pc&player=web"
  ).then((json) => {
    if (!json || json.code !== 0 || !json.data) throw new Error("getConf failed (" + (json && json.code) + ")");
    const d = json.data;
    return {
      token: d.token || "",
      host_list: normalizeHostList(d.host_server_list || d.host_list || [{ host: d.host, wss_port: d.wss_port }]),
    };
  });
}

function getDanmuInfo(roomId) {
  const endpoint = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
  const validate = (json, tag) => {
    if (!json || Number(json.code) !== 0 || !json.data) {
      throw new Error(tag + " getDanmuInfo failed (" + (json && json.code) + ")");
    }
    return json.data;
  };
  // 签到（WBI）→ 不签名 → getConf，三级兜底；三级都要真正「拿到 data」才算成功
  return wbiQuery({ id: roomId, type: 0 })
    .then((query) => requestJson(endpoint + "?" + query))
    .then((json) => validate(json, "signed"))
    .catch((err) => {
      state.stats.signedErr = shortError(err);
      return requestJson(endpoint + "?id=" + encodeURIComponent(roomId) + "&type=0").then((json) => validate(json, "unsigned"));
    })
    .catch((err) => {
      state.stats.connectErr = shortError(err);
      return getDanmuConfFallback(roomId);
    });
}

// ===== 房间信息（主播名/标题）=====
function extractRoomTitle() {
  try {
    const t = (document.title || "").replace(/\s*[-—–]\s*哔哩哔哩.*$/, "");
    const parts = t.split(/[-—–]/);
    if (parts.length >= 2) return parts.slice(0, -1).join("-").trim();
    return t.trim();
  } catch (_) {
    return "";
  }
}

function applyRoomInfo(uid, name, title) {
  if (!uid) return;
  const prev = state.room || {};
  state.room = {
    uid: Number(uid) || prev.uid || 0,
    name: name || prev.name || "",
    title: title || prev.title || "",
  };
}

function updateRoomInfo() {
  const neptune = W.__NEPTUNE_IS_MY_WAIFU__;
  try {
    const info = neptune && neptune.roomInfoRes && neptune.roomInfoRes.data;
    if (info && info.uid) {
      applyRoomInfo(info.uid, String(info.uname || ""), String(info.title || extractRoomTitle()));
      if (state.room.name) return;
    }
    const init = neptune && neptune.roomInitRes && neptune.roomInitRes.data;
    if (init && init.uid) {
      let uname = "";
      const parts = (document.title || "").split(" - ");
      if (parts.length >= 3) uname = parts[parts.length - 2].trim();
      if (!uname) {
        const el = document.querySelector(".room-owner-name, .anchor-name, .initiator-name, [class*='anchor']");
        if (el) uname = (el.textContent || "").trim();
      }
      applyRoomInfo(init.uid, uname, extractRoomTitle());
    }
  } catch (_) {}

  // 已有主播名就不再请求；请求中/刚失败也不重发（recordHighlight 每条命中都会调到这里）
  if (state.room.uid && state.room.name) return;
  if (roomInfoInflight || Date.now() - roomInfoLastTry < 30000) return;
  const roomId = getRoomIdFromUrl();
  if (!roomId) return;
  roomInfoInflight = true;
  roomInfoLastTry = Date.now();
  // ★ get_info 只给 uid/title，不给 uname（2026-11 实测）→ 主播名另用 Master/info 按 uid 取
  requestJson("https://api.live.bilibili.com/room/v1/Room/get_info?room_id=" + encodeURIComponent(roomId))
    .then((json) => {
      if (json && json.code === 0 && json.data && json.data.uid) {
        applyRoomInfo(json.data.uid, String(json.data.uname || ""), String(json.data.title || ""));
      }
      if (state.room.uid && !state.room.name) {
        return fetchUpName(state.room.uid).then((name) => {
          if (name) applyRoomInfo(state.room.uid, name, "");
        });
      }
    })
    .catch(() => {})
    .then(() => {
      roomInfoInflight = false;
    });
}

let roomInfoInflight = false;
let roomInfoLastTry = 0;
const upNameCache = new Map(); // uid → Promise<string>

/** 按 UP 主 uid 取昵称（Master/info，免签名免登录）；失败返回 ""，失败结果不缓存 */
function fetchUpName(uid) {
  const key = String(uid || "");
  if (!key || key === "0") return Promise.resolve("");
  if (upNameCache.has(key)) return upNameCache.get(key);
  const p = requestJson("https://api.live.bilibili.com/live_user/v1/Master/info?uid=" + encodeURIComponent(key))
    .then((json) => {
      const name = (json && json.code === 0 && json.data && json.data.info && json.data.info.uname) || "";
      if (!name) upNameCache.delete(key);
      return String(name);
    })
    .catch(() => {
      upNameCache.delete(key);
      return "";
    });
  upNameCache.set(key, p);
  return p;
}

// ===== 自家 WS 客户端（不劫持页面，独立连接）=====
function pickDanmakuHost(info) {
  const hosts = normalizeHostList(info && (info.host_list || info.host_server_list));
  if (!hosts.length) return { host: "broadcastlv.chat.bilibili.com", wss_port: 443 };
  const idx = state.sockets.hostCursor % hosts.length;
  state.stats.selector = hosts[idx].host;
  return hosts[idx];
}

function normalizeHostList(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || !item.host) continue;
    const host = String(item.host);
    const key = host;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, wss_port: 443 });
  }
  if (!out.length) out.push({ host: "broadcastlv.chat.bilibili.com", wss_port: 443 });
  return out;
}

function sendPacket(ws, operation, body) {
  if (!ws || ws.readyState !== 1) return;
  const encoded = new TextEncoder().encode(body || "");
  const packetLen = 16 + encoded.length;
  const buffer = new ArrayBuffer(packetLen);
  const view = new DataView(buffer);
  view.setUint32(0, packetLen);
  view.setUint16(4, 16);
  view.setUint16(6, 1);
  view.setUint32(8, operation);
  view.setUint32(12, 1);
  new Uint8Array(buffer, 16).set(encoded);
  ws.send(buffer);
}

function getCookie(name) {
  const re = new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)");
  const m = document.cookie.match(re);
  return m ? decodeURIComponent(m[1]) : "";
}

function closeSocket() {
  clearInterval(state.sockets.heartbeat);
  const ws = state.sockets.live;
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch (_) {}
  }
  state.sockets.live = null;
}

function scheduleReconnect(reason) {
  clearTimeout(state.sockets.reconnect);
  state.stats.source = reason || "已断开，5秒后重连";
  state.sockets.reconnect = setTimeout(startDanmakuClient, 5000);
}

function startDanmakuClient() {
  if (!state.settings || !state.settings.enabled) return;
  clearTimeout(state.sockets.reconnect);
  closeSocket();
  updateRoomInfo();

  const roomIdFromUrl = getRoomIdFromUrl();
  if (!roomIdFromUrl) {
    state.stats.source = "未识别房间号";
    return;
  }
  state.stats.source = "连接中";

  getRealRoomId(roomIdFromUrl)
    .then((roomId) => getDanmuInfo(roomId).then((info) => ({ roomId, info })))
    .then(({ roomId, info }) => connectDanmakuServer(roomId, info))
    .catch((err) => {
      state.stats.source = "连接失败：" + shortError(err);
      state.sockets.hostCursor += 1;
      scheduleReconnect(state.stats.source);
      log("danmaku client init failed", err);
    });
}

function connectDanmakuServer(roomId, info) {
  closeSocket();
  const host = pickDanmakuHost(info);
  const url = "wss://" + host.host + ":" + (host.wss_port || 443) + "/sub";
  let ws;
  try {
    ws = new W.WebSocket(url);
  } catch (err) {
    scheduleReconnect("WS 构造失败：" + shortError(err));
    return;
  }
  state.sockets.live = ws;
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    if (state.sockets.live !== ws) return;
    state.stats.source = "已连接，等待弹幕";
    sendPacket(ws, 7, JSON.stringify({
      uid: Number(getCookie("DedeUserID") || 0),
      roomid: roomId,
      protover: 2,
      buvid: getCookie("buvid3") || getCookie("buvid4") || "",
      platform: "web",
      type: 2,
      key: (info && info.token) || "",
    }));
    clearInterval(state.sockets.heartbeat);
    state.sockets.heartbeat = setInterval(() => sendPacket(ws, 2, ""), 30000);
    sendPacket(ws, 2, "");
    log("danmaku connected", url, roomId);
  };
  ws.onmessage = (event) => consumeWsData(event.data);
  ws.onerror = () => {
    if (state.sockets.live === ws) state.stats.source = "连接异常";
  };
  ws.onclose = () => {
    if (state.sockets.live !== ws) return;
    clearInterval(state.sockets.heartbeat);
    state.sockets.live = null;
    state.sockets.hostCursor += 1;
    scheduleReconnect("已断开，5秒后重连");
  };
}

function consumeWsData(data) {
  try {
    if (data instanceof ArrayBuffer) parsePackets(data);
    else if (data instanceof Blob) data.arrayBuffer().then(parsePackets, () => {});
  } catch (_) {}
}

function parsePackets(buffer) {
  if (!buffer || buffer.byteLength < 16) return;
  const view = new DataView(buffer);
  let offset = 0;
  while (offset + 16 <= buffer.byteLength) {
    const packetLen = view.getUint32(offset);
    const headerLen = view.getUint16(offset + 4);
    const version = view.getUint16(offset + 6);
    const operation = view.getUint32(offset + 8);
    if (packetLen < headerLen || packetLen <= 0 || offset + packetLen > buffer.byteLength) break;
    state.stats.packets += 1;
    if (operation === 5) {
      state.stats.msgPackets += 1;
      if (state.stats.captured === 0) state.stats.source = "收到弹幕包";
      parseBody(buffer.slice(offset + headerLen, offset + packetLen), version);
    } else if (operation === 8) {
      state.stats.source = "鉴权成功";
    } else if (operation === 3) {
      state.stats.source = state.stats.captured > 0 ? "已接收弹幕" : "已连接，等待弹幕";
    }
    offset += packetLen;
  }
}

function parseBody(body, version) {
  if (version === 0 || version === 1) {
    parseJsonText(decodeUtf8(body));
    return;
  }
  if (version === 2) {
    decompress(body, "deflate")
      .then(parsePackets)
      .catch(() =>
        decompress(body, "deflate-raw").then(parsePackets, (err) => {
          state.stats.inflateFail += 1;
          debugLog("inflate-fail", { err: shortError(err), bytes: body.byteLength });
        })
      );
    return;
  }
  if (version === 3) {
    // 浏览器原生 DecompressionStream 不支持 br；protover:2 已让服务端不发 br，此计数应恒为 0
    state.stats.brotli += 1;
  }
}

function decodeUtf8(buffer) {
  return new TextDecoder("utf-8").decode(new Uint8Array(buffer));
}

function decompress(buffer, format) {
  if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("DecompressionStream unsupported"));
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).arrayBuffer();
}

function parseJsonText(text) {
  if (!text) return;
  const parts = text.indexOf("\u0000") >= 0 ? text.split("\u0000") : [text];
  for (const part of parts) {
    const s = part.trim();
    if (!s) continue;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch (_) {
      state.stats.jsonFail += 1;
      continue;
    }
    if (!msg || typeof msg.cmd !== "string") continue;
    const short = msg.cmd.slice(0, 24);
    state.stats.cmds[short] = (state.stats.cmds[short] || 0) + 1;
    try {
      if (msg.cmd.indexOf("DANMU_MSG") === 0) handleDanmakuPacket(msg);
      else if (msg.cmd === "INTERACT_WORD" || msg.cmd === "INTERACT_WORD_V2") handleInteractPacket(msg);
    } catch (err) {
      state.stats.handleFail += 1;
      if (state.stats.handleFail <= 3) warn("handle packet failed", short, err);
    }
  }
}

// ===== 20-api.js =====
// ===== API 队列：并发 + 优先级 + 风控退避 + 6 小时缓存 =====
// B站没有可用的批量身份接口（relations 批量实测 data:null），只能逐个查；
// 单个 stat/relation 约 90ms，60ms 起一个即可轻松追上大直播间的人流。

const API = {
  items: [],
  running: 0,
  lastStart: 0,
  timer: 0,
  riskUntil: 0,
  riskLevel: 0,
  seq: 0,
};

const RISK_CODES = new Set([-412, -352, -509, -799]);

function apiConcurrency() {
  return clamp(Number(state.settings.apiConcurrency) || 5, 1, 8);
}

function apiInterval() {
  return clamp(Number(state.settings.apiIntervalMs) || 60, 10, 2000);
}

function userRecord(uid) {
  uid = String(uid);
  let u = state.users[uid];
  if (!u) {
    u = { uid, uname: "", follower: 0, followed: false, attribute: 0, statTs: 0, followTs: 0, retry: 0 };
    state.users[uid] = u;
  }
  // 老缓存格式（只有 fetched/ts）→ 迁移成字段级时间戳
  if (u.fetched && u.ts && !u.statTs) u.statTs = u.ts;
  if (u.fetched && u.ts && !u.followTs) u.followTs = u.ts;
  return u;
}

function statFresh(u) {
  return !!u && u.statTs > 0 && Date.now() - u.statTs < 6 * 60 * 60 * 1000;
}

function followFresh(u) {
  return !!u && u.followTs > 0 && Date.now() - u.followTs < 6 * 60 * 60 * 1000;
}

// 队列里是否已有这个人（避免重复排队：同一 uid 一晚上只查一次）
function apiQueued(uid) {
  for (const job of API.items) if (job.uid === uid) return job;
  return null;
}

/**
 * 给一个人排队查身份。priority 0 最高（自定义/指定人），3 最低（普通观众）。
 */
function apiEnqueue(uid, priority) {
  uid = String(uid || "");
  if (!uid || uid === "0") return;
  const s = state.settings;
  if (!s.fanMark && !s.followMark) return;
  // 「只查值得的人」：普通观众（优先级 3）不查，省请求
  if (s.apiMode === "worthy" && Number(priority) >= 3) return;

  const u = userRecord(uid);
  const needFan = s.fanMark && !statFresh(u);
  const needFollow = s.followMark && !followFresh(u);
  if (!needFan && !needFollow) {
    debugLog("api-cache-hit", { uid, follower: u.follower, followed: u.followed });
    return;
  }
  if (Number(u.retry || 0) >= 3) return;

  const existing = apiQueued(uid);
  if (existing) {
    if (priority < existing.priority) existing.priority = priority;
    return;
  }
  API.items.push({ uid, priority: Number(priority) || 3, needFan, needFollow, at: Date.now(), seq: API.seq++ });
  state.stats.apiQueued += 1;
  apiPump();
}

function apiNextJob() {
  if (!API.items.length) return null;
  let bestIdx = 0;
  for (let i = 1; i < API.items.length; i += 1) {
    const a = API.items[i];
    const b = API.items[bestIdx];
    if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) bestIdx = i;
  }
  return API.items.splice(bestIdx, 1)[0];
}

function apiPump() {
  trace("api:pump");
  if (state.destroyed) return;
  clearTimeout(API.timer);
  const now = Date.now();
  if (now < API.riskUntil) {
    API.timer = setTimeout(apiPump, Math.min(30000, API.riskUntil - now));
    return;
  }
  const gap = Math.max(0, apiInterval() - (now - API.lastStart));
  const max = apiConcurrency();
  let started = false;
  while (API.running < max && API.items.length) {
    if (Date.now() - API.lastStart < apiInterval()) break;
    const job = apiNextJob();
    if (!job) break;
    API.running += 1;
    API.lastStart = Date.now();
    started = true;
    apiRunJob(job)
      .catch((err) => debugLog("api-job-crash", { uid: job.uid, err: shortError(err) }))
      .then(() => {
        trace("api:job-done");
        API.running = Math.max(0, API.running - 1);
        apiPump();
      });
  }
  if (!started && API.items.length) API.timer = setTimeout(apiPump, Math.max(16, gap));
}

function apiNoteRisk(code) {
  API.riskLevel = Math.min(6, API.riskLevel + 1);
  const wait = Math.min(60000, 1000 * Math.pow(2, API.riskLevel - 1));
  API.riskUntil = Date.now() + wait;
  state.stats.apiRisk += 1;
  warn("API 风控命中 code=" + code + "，退避 " + Math.round(wait / 1000) + "s");
  if (typeof renderStatus === "function") renderStatus();
}

function apiNoteOk() {
  if (API.riskLevel > 0) API.riskLevel = Math.max(0, API.riskLevel - 1);
  API.riskUntil = 0;
}

function apiRunJob(job) {
  const u = userRecord(job.uid);
  const steps = [];
  if (job.needFan && !statFresh(u)) steps.push(() => apiFetchFollower(job.uid));
  if (job.needFollow && !followFresh(u)) steps.push(() => apiFetchFollow(job.uid));
  return steps.reduce(
    (p, step) => p.then(() => step()),
    Promise.resolve()
  ).then(() => {
    API.riskLevel = 0;
    if (typeof renderStatus === "function") renderStatus();
  }).catch((err) => {
    u.retry = Number(u.retry || 0) + 1;
    throw err;
  });
}

function apiFetchFollower(uid) {
  state.stats.api += 1;
  return requestJson("https://api.bilibili.com/x/relation/stat?vmid=" + encodeURIComponent(uid))
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) {
        if (json && RISK_CODES.has(Number(json.code))) {
          apiNoteRisk(json.code);
          // 风控期间把这条放回队列（不消耗重试次数）
          const u = userRecord(uid);
          u.retry = Math.max(0, Number(u.retry || 0) - 1);
          API.items.push({ uid, priority: 3, needFan: true, needFollow: false, at: Date.now(), seq: API.seq++ });
          return;
        }
        throw new Error("stat code " + (json && json.code));
      }
      trace("api:follower-ok");
      const u = userRecord(uid);
      u.follower = Number(json.data.follower || 0);
      u.statTs = Date.now();
      u.retry = 0;
      state.stats.apiFail = Math.max(0, state.stats.apiFail - 1);
      apiNoteOk();
      saveUserCacheSoon();
      onUserMeta(uid);
      debugLog("api-follower", { uid, follower: u.follower });
    })
    .catch((err) => {
      // ★ 风控（HTTP 412 / JSON -412）走退避重排，不能算普通失败：
      //   算成 apiFail 会让退避机制看起来没生效，实际是被这条覆盖掉了。
      if (err && err.riskCode != null) {
        apiNoteRisk(err.riskCode);
        const u = userRecord(uid);
        u.retry = Math.max(0, Number(u.retry || 0) - 1);
        API.items.push({ uid, priority: 3, needFan: true, needFollow: false, at: Date.now(), seq: API.seq++ });
        return;
      }
      state.stats.apiFail += 1;
      trace("api:follower-fail " + shortError(err));
      debugLog("api-follower-fail", { uid, err: shortError(err) });
      throw err;
    });
}

function apiFetchFollow(uid) {
  state.stats.api += 1;
  return requestJson("https://api.bilibili.com/x/relation?fid=" + encodeURIComponent(uid))
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) {
        if (json && RISK_CODES.has(Number(json.code))) {
          apiNoteRisk(json.code);
          const u = userRecord(uid);
          u.retry = Math.max(0, Number(u.retry || 0) - 1);
          API.items.push({ uid, priority: 3, needFan: false, needFollow: true, at: Date.now(), seq: API.seq++ });
          return;
        }
        throw new Error("relation code " + (json && json.code));
      }
      const attr = Number(json.data.attribute || 0);
      const u = userRecord(uid);
      u.attribute = attr;
      u.followed = (attr & 2) === 2; // bit2 = 已关注（6=互粉 也含 2）
      u.followTs = Date.now();
      u.retry = 0;
      apiNoteOk();
      saveUserCacheSoon();
      onUserMeta(uid);
      debugLog("api-follow", { uid, attribute: attr, followed: u.followed });
    })
    .catch((err) => {
      if (err && err.riskCode != null) {
        apiNoteRisk(err.riskCode);
        const u = userRecord(uid);
        u.retry = Math.max(0, Number(u.retry || 0) - 1);
        API.items.push({ uid, priority: 3, needFan: false, needFollow: true, at: Date.now(), seq: API.seq++ });
        return;
      }
      state.stats.apiFail += 1;
      debugLog("api-follow-fail", { uid, err: shortError(err) });
      throw err;
    });
}

// ===== 身份卡：悬停才查，独立缓存（30 分钟）=====
function apiFetchCard(uid) {
  uid = String(uid || "");
  if (!uid) return Promise.resolve(null);
  const cached = state.cards.get(uid);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return Promise.resolve(cached.data);

  return requestJson("https://api.bilibili.com/x/web-interface/card?mid=" + encodeURIComponent(uid) + "&photo=false")
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) throw new Error("card code " + (json && json.code));
      const data = {
        card: json.data.card || {},
        following: !!json.data.following,
        relation: json.data.relation || null,
      };
      state.cards.set(uid, { data, ts: Date.now() });
      if (state.cards.size > 200) {
        const oldest = Array.from(state.cards.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) state.cards.delete(oldest[0]);
      }
      return data;
    })
    .catch((err) => {
      debugLog("card-fail", { uid, err: shortError(err) });
      return null;
    });
}

/** 值得优先查的人：自定义/指定人=0，舰长/房管/高粉丝牌/高等级=2，其他人=3 */
function apiPriorityFor(identity) {
  if (!identity) return 3;
  if (isWatchUid(identity.uid)) return 0;
  if (identity.guard > 0 || identity.admin) return 2;
  if (identity.medal && identity.medal.level >= Number(state.settings.medalMinLevel || 10)) return 2;
  return 3;
}

// ===== 25-identity.js =====
// ===== 身份层：弹幕包字段 → 身份对象；身份 → 昵称前缀（纯函数，便于单测）=====

/** 从 DANMU_MSG 原文解析出一条弹幕（零 API 成本的身份都在这里） */
function parseDanmakuInfo(msg) {
  const info = Array.isArray(msg && msg.info) ? msg.info : [];
  const user = Array.isArray(info[2]) ? info[2] : [];
  // B站新格式在 info[0][15].user 里也带一份身份（未登录/神秘人时两处都是空壳）
  const inner = info[0] && info[0][15] && typeof info[0][15] === "object" ? info[0][15].user || null : null;
  const innerBase = inner && inner.base ? inner.base : null;
  const innerUid = inner ? inner.uid : 0;
  const uid = String((user[0] == null ? "" : user[0]) || innerUid || "");
  const name = String((user[1] == null ? "" : user[1]) || (innerBase && innerBase.name) || "").trim();
  const rawText = info[1] == null ? "" : String(info[1]);
  const text = normalizeText(rawText);

  // 表情：大表情在 info[0][13].url；行内小表情在 info[0][15].extra 的 emots 字典
  const emoticonKeys = [];
  const emo = info[0] && info[0][13] && typeof info[0][13] === "object" ? info[0][13] : null;
  if (emo && emo.url) {
    const k = emoticonFileKey(emo.url);
    if (k) emoticonKeys.push(k);
  }
  try {
    const extraRaw = info[0] && info[0][15] && info[0][15].extra;
    const extra = typeof extraRaw === "string" ? JSON.parse(extraRaw) : extraRaw;
    if (extra && extra.emots && typeof extra.emots === "object") {
      for (const k in extra.emots) {
        const url = extra.emots[k] && extra.emots[k].url;
        const key = emoticonFileKey(url);
        if (key) emoticonKeys.push(key);
      }
    }
  } catch (_) {}

  // 粉丝牌：[等级, 牌名, 主播名, 主播房间号, 颜色?, ...]；无牌为 []
  let medal = null;
  if (Array.isArray(info[3]) && info[3].length && Number(info[3][0]) > 0) {
    medal = {
      level: Number(info[3][0]) || 0,
      name: String(info[3][1] || ""),
      anchor: String(info[3][2] || ""),
      color: medalColorFromInt(info[3][4]) || normalizeColor(inner && inner.medal && inner.medal.v2_medal_color_start, ""),
    };
  } else if (inner && inner.medal && Number(inner.medal.level) > 0) {
    medal = {
      level: Number(inner.medal.level) || 0,
      name: String(inner.medal.name || ""),
      anchor: String(inner.medal.anchor || ""),
      color: normalizeColor(inner.medal.v2_medal_color_start, ""),
    };
  }

  // 用户等级：老格式 info[4][0] 是 0–6；新格式这里可能不是等级，越界就当没有
  const lvRaw = Array.isArray(info[4]) ? Number(info[4][0]) || 0 : 0;
  const userLevel = lvRaw >= 0 && lvRaw <= 6 ? lvRaw : 0;
  const guard = Number(info[7]) || (inner && inner.guard && Number(inner.guard.level)) || 0; // 1=总督 2=提督 3=舰长

  // matchText：去掉 [表情] 占位符——画面上它们渲染成图，不计入文字
  const matchText = normalizeText(text.replace(/\[[^\[\]]{1,20}\]/g, ""));

  // ★ v2.5.4 配对指纹：B站 渲染器把 info[0][3]（颜色）与 info[0][2]（字号）原样写进
  //   DOM 元素的 inline `--color` / `--fontSize`。用它把「同文本不同人」分开 ——
  //   没有它，一条「？」来自 7 个人时纯 FIFO 必然串人（Master 自己发弹幕时撞见的就是这个）。
  //   只在两边都读得到时才拦，读不到就退回纯文本，绝不因此漏标。
  //   尺子必须和 domFingerprint 一致：#rrggbb + 取整 px。
  const colorInt = Number(info[0] && info[0][3]);
  const sizeInt = Number(info[0] && info[0][2]);
  const colorHex = isFinite(colorInt) && colorInt > 0 ? "#" + (colorInt & 0xffffff).toString(16).padStart(6, "0") : "";
  const sizePx = isFinite(sizeInt) && sizeInt > 0 ? Math.round(sizeInt) + "px" : "";
  const fp = colorHex || sizePx ? colorHex + "|" + sizePx : "";

  return {
    uid,
    name,
    text,
    matchText,
    fp,
    emoticonKeys,
    medal,
    userLevel,
    guard,
    admin: !!user[2],
    vip: !!user[3],
    svip: !!user[4],
    ts: Date.now(),
  };
}

const GUARD_LABEL = { 1: "总督", 2: "提督", 3: "舰长" };
// 弹幕上的前缀要压到单字（长前缀会撑宽元素、同轨压字），身份卡里才用全称
const GUARD_SHORT = { 1: "督", 2: "提", 3: "舰" };

// 自定义名单 / 指定人 文本 → 归一化集合（缓存，避免每帧重复 split）
const nameSetCache = { src: null, set: null };
function customNameSet(settings) {
  const src = String(settings.customFollowNames || "");
  if (nameSetCache.src === src) return nameSetCache.set;
  nameSetCache.src = src;
  nameSetCache.set = new Set(
    src.split(/[\n,，;；、\t ]+/).map(normalizeName).filter(Boolean)
  );
  return nameSetCache.set;
}

const watchCache = { src: null, set: null };
function watchUidSet(settings) {
  const src = String(settings.watchUids || "");
  if (watchCache.src === src) return watchCache.set;
  watchCache.src = src;
  watchCache.set = new Set(src.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean));
  return watchCache.set;
}

// 指定人的昵称兜底（UID 还没解析出来时按名字认人）
const watchNameCache = { src: null, set: null };
function watchNameSet(settings) {
  const src = String(settings.watchNames || "");
  if (watchNameCache.src === src) return watchNameCache.set;
  watchNameCache.src = src;
  watchNameCache.set = new Set(
    src.split(/[\n,，;；、\t]+/).map(normalizeName).filter(Boolean)
  );
  return watchNameCache.set;
}

function isWatchUid(uid) {
  if (!uid || !state.settings) return false;
  return watchUidSet(state.settings).has(String(uid));
}

function isWatchName(name) {
  if (!name || !state.settings) return false;
  return watchNameSet(state.settings).has(normalizeName(name));
}

// 关键词规则："关键词" 或 "关键词:#ff0000"，一行一条；# 开头的行是注释
const keywordCache = { src: null, rules: null };
function keywordRules(settings) {
  const src = String(settings.keywordRules || "") + "|" + String(settings.keywordColor || "");
  if (keywordCache.src === src) return keywordCache.rules;
  keywordCache.src = src;
  const rules = [];
  for (const line of String(settings.keywordRules || "").split(/\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = raw.match(/^(.*?):(#[0-9a-fA-F]{3,8})\s*$/);
    if (m && m[1].trim()) rules.push({ kw: m[1].trim().toLowerCase(), color: normalizeColor(m[2], "") });
    else rules.push({ kw: raw.toLowerCase(), color: "" });
  }
  keywordCache.rules = rules;
  return rules;
}

/** 返回命中的第一个关键词规则（含颜色），没命中返回 null */
function matchKeyword(text, settings) {
  const rules = keywordRules(settings);
  if (!rules.length) return null;
  const hay = String(text || "").toLowerCase();
  if (!hay) return null;
  for (const r of rules) {
    if (hay.indexOf(r.kw) >= 0) return { kw: r.kw, color: r.color || normalizeColor(settings.keywordColor, "#ff5c5c") };
  }
  return null;
}

// ===== 高光效果档位 =====
const FX_KEY = { custom: "customFollowFx", follow: "followFx", fan: "fanFx", keyword: "keywordFx" };
const FX_ALL = ["card", "orbit", "ripple"]; // 底牌 / 绕行光段 / 入场涟漪

/** "card, orbit,xx" → ["card","orbit"]：去重、丢未知值、按固定顺序输出（签名稳定） */
function parseFx(raw) {
  const set = new Set(String(raw == null ? "" : raw).split(/[\s,，+|]+/).map((x) => x.trim().toLowerCase()));
  return FX_ALL.filter((f) => set.has(f));
}

/**
 * 拼昵称前缀（纯函数）：badges 依次为 ◆自定义/指定人 → ❤已关注 → ⭐粉丝数
 * → 粉丝牌 Lv.N → 身份标签 → 熟面孔排名
 */
function composeNick(identity, meta, settings, ctx) {
  const custom = (ctx && ctx.customSet) || customNameSet(settings);
  const watch = (ctx && ctx.watchUidSet) || watchUidSet(settings);
  const name = (meta && meta.uname) || identity.name || "";
  const badges = [];
  let color = "";
  let glow = false;

  const isCustom = settings.customFollowMark && name && custom.has(normalizeName(name));
  const isWatch = watch.has(String(identity.uid)) || isWatchName(name);

  if (isCustom || isWatch) {
    badges.push({ kind: "custom", text: settings.customFollowBadge || "◆", color: settings.customFollowColor });
    if (!color) color = settings.customFollowColor;
    glow = glow || !!settings.customFollowGlow;
  }

  if (settings.followMark && meta && meta.followed) {
    badges.push({ kind: "follow", text: settings.followBadge || "❤", color: settings.followColor });
    if (!color) color = settings.followColor;
    glow = glow || !!settings.followGlow;
  }

  const follower = Number(meta && meta.follower) || 0;
  const fanHit = settings.fanMark && follower >= Number(settings.fanThreshold || 0);
  if (fanHit) {
    badges.push({ kind: "fan", text: settings.fanBadge || "⭐", color: settings.fanColor });
    if (!color) color = settings.fanColor;
    glow = glow || !!settings.fanGlow;
  }

  const medal = identity.medal;
  if (settings.medalMark && medal && medal.level >= Number(settings.medalMinLevel || 0)) {
    // 压到最短：主播自己的粉丝牌（满屏都是同一个牌子）只留等级数字，牌子名冗余
    const sameAnchor = medal.name && state.room && state.room.name && medal.name === state.room.name;
    badges.push({
      kind: "medal",
      text: sameAnchor || !medal.name ? String(medal.level) : medal.level + medal.name,
      color: medal.color || "#8a8a99",
    });
  }

  if (settings.guardMark && identity.guard && GUARD_LABEL[identity.guard]) {
    badges.push({ kind: "guard", text: GUARD_SHORT[identity.guard] || "舰", color: "#ff9f43" });
  }

  if (settings.adminMark && identity.admin) {
    badges.push({ kind: "admin", text: "管", color: "#00AEEC" });
  }

  if (settings.levelMark && identity.userLevel >= Number(settings.levelMinLevel || 0)) {
    badges.push({ kind: "level", text: "L" + identity.userLevel, color: "#9aa4b2" });
  }

  const topRank = ctx && ctx.topRank;
  if (settings.topTalkerMark && topRank > 0) {
    badges.push({ kind: "top", text: "#" + topRank, color: "#00AEEC" });
  }

  const chars = [...name];
  // ★ 2026-11-18 起不再按 8 字硬截断（Master 要「看全」）：
  //   画面能显示多少，由 35-decorate.js 的 fitAllNicks 按「与同轨前一条的真实间隙」逐帧决定
  //   （12px 完整 → 11px → 收窄 + 省略号）。这里只负责把完整名字交出去。
  const nick = settings.showNick && name ? name + (settings.nickSeparator == null ? ":" : String(settings.nickSeparator)) : "";
  const small = !!nick && chars.length > Number(settings.nickSmallChars || 8);

  let wholeColor = "";
  let wholeGlow = false;
  if (fanHit || isCustom || isWatch || (settings.followMark && meta && meta.followed)) {
    wholeColor = color;
    wholeGlow = glow;
  }
  const kw = matchKeyword(identity.text, settings);
  if (kw && !wholeColor) {
    wholeColor = kw.color;
    wholeGlow = !!settings.keywordGlow;
  }

  // 高光效果只取「命中的最高一档」，跟颜色的取法一致（自定义 > 关注 > 粉丝 > 关键词）
  const isFollow = !!(settings.followMark && meta && meta.followed);
  const tier = isCustom || isWatch ? "custom" : isFollow ? "follow" : fanHit ? "fan" : kw ? "keyword" : "";
  const fx = tier && wholeColor ? parseFx(settings[FX_KEY[tier]]) : [];

  return {
    badges,
    nick,
    name,
    small,
    smallSize: Number(settings.nickSmallSize) || 12,
    color: wholeColor,
    glow: wholeGlow,
    tier,
    fx,
    flags: { custom: isCustom || isWatch, follow: !!(settings.followMark && meta && meta.followed), fan: fanHit, keyword: !!kw },
  };
}

// ===== 30-matcher.js =====
// ===== 配对层：WS 弹幕 ↔ 画面 DOM 元素 =====
// 旧版病根：
//   D1 用 dataset 存状态 → B站重绘清掉标记后无法追回
//   D2 「文本 → 最近一条未使用」→ 同屏 5 条「嘉门」必然串人
// 新方案：状态进 WeakMap；同文本按 FIFO（WS 顺序 == 渲染顺序）；
// 并且**选槽前先验明正身**——元素必须此刻仍在滚、且文字仍等于这条 key，
// 否则它就是被回收复用的空壳，直接作废，绝不拿它吞掉一条新弹幕。

function createMatcher(opt) {
  const options = opt || {};
  const TTL = options.ttl || 3000; // 到达与元素出现允许的最大时间差
  const AHEAD = options.ahead || 500; // WS 允许比渲染晚多少（自家连接常比页面慢几十毫秒）
  // ★ v2.5.1：固定弹幕（顶部/底部，-center）在 B站 上屏前可能被碰撞池推迟，
  //   实测正常 0.1–1.3s，但排队时会超过滚动弹幕的 3s。给它们一条单独的宽窗口，
  //   否则「底部弹幕容易没标注」会一直存在。（宁可多等，错标由 FIFO + liveKey 兜住）
  const TTLF = options.ttlFixed || Math.max(TTL * 4, 12000);
  const isAlive = options.isAlive || (() => true);
  const liveKeyOf = options.liveKeyOf || null; // el → 此刻的配对 key（空壳/已复用返回不同值或 null）
  const ttlFor = (slot) => (slot && slot.fixed ? TTLF : TTL);

  const arrivals = []; // 按到达顺序
  const buckets = new Map(); // key -> arrival[]
  const pending = new Map(); // key -> slot[]
  const slotByEl = new WeakMap(); // el -> slot（一个元素只许有一个未完成的槽）
  let seq = 0;

  const stats = { arrivals: 0, elements: 0, matched: 0, failed: 0, pendingHit: 0, staleSlot: 0, dupSlot: 0, fpKeyed: 0, fpMiss: 0 };

  // 指纹弱化成「兼容」而不是「相等」：任一边缺指纹就放行。
  // 宁可退回纯文本 FIFO（旧口径），也不能因为拿不到 --color 就整条漏标。
  function fpCompatible(a, b) {
    const fa = a && a.fp ? String(a.fp) : "";
    const fb = b && b.fp ? String(b.fp) : "";
    if (!fa || !fb) return true;
    return fa === fb;
  }

  // 强键 → 纯文本键（liveKeyOf 只会返回纯文本，比对前要剥掉指纹前缀）
  function plainKeyOf(key) {
    const s = String(key || "");
    if (s.indexOf("F\u0001") === 0) {
      const rest = s.slice(2);
      const i = rest.indexOf("\u0001");
      return i >= 0 ? rest.slice(i + 1) : rest;
    }
    return s;
  }

  function keysOf(item) {
    const keys = [];
    // ★ 强键优先：指纹 + 文本。同文本多人同时发时，只有它能把人和弹幕对上。
    if (item.key) {
      if (item.fp) keys.push("F\u0001" + item.fp + "\u0001" + item.key);
      keys.push(item.key);
    }
    if (item.altKey && item.altKey !== item.key) {
      if (item.fp) keys.push("F\u0001" + item.fp + "\u0001" + item.altKey);
      keys.push(item.altKey);
    }
    if (Array.isArray(item.emojiKeys)) {
      for (const k of item.emojiKeys) if (k) keys.push("e:" + k);
    }
    return keys;
  }

  function pushBucket(key, item) {
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(item);
  }

  // 这个槽还配得上这条 key 吗？空壳（已飘完）、被复用换了内容的，都不配。
  function slotStillValid(slot, key) {
    if (slot.done) return false;
    if (!isAlive(slot)) {
      slot.done = true;
      stats.staleSlot += 1;
      return false;
    }
    if (liveKeyOf && liveKeyOf(slot.el) !== plainKeyOf(key)) {
      slot.done = true;
      stats.staleSlot += 1;
      return false;
    }
    return true;
  }

  function prune(now) {
    const keep = Math.max(TTL, TTLF) * 2;
    while (arrivals.length && (arrivals[0].used || now - arrivals[0].ts > keep)) {
      const old = arrivals.shift();
      old.dropped = true;
    }
    if (arrivals.length > 2000) arrivals.splice(0, arrivals.length - 2000);
    for (const [key, list] of buckets) {
      let i = 0;
      while (i < list.length && (list[i].used || list[i].dropped)) i += 1;
      if (i > 0) list.splice(0, i);
      if (!list.length) buckets.delete(key);
    }
    for (const [key, list] of pending) {
      const alive = list.filter((slot) => !slot.done && isAlive(slot));
      if (alive.length !== list.length) {
        if (alive.length) pending.set(key, alive);
        else pending.delete(key);
      }
    }
  }

  function takeArrival(key, at, fixed, fp) {
    const list = buckets.get(key);
    if (!list) return null;
    const ttl = fixed ? TTLF : TTL;
    let best = null;
    for (const item of list) {
      if (item.used || item.dropped) continue;
      if (at - item.ts > ttl) continue; // 太老的不能拿来充数
      if (item.ts - at > AHEAD) continue; // 还没到的也不能用
      // ★ 指纹闸：两边都有指纹且不同 → 一定不是同一条（同文本不同人），跳过
      if (!fpCompatible(item, { fp })) continue;
      if (!best || item.ts < best.ts) best = item; // 同文本按 FIFO 取最早
    }
    if (best) best.used = true;
    return best;
  }

  return {
    stats,

    pendingCount() {
      let n = 0;
      for (const list of pending.values()) n += list.filter((s) => !s.done).length;
      return n;
    },

    reset() {
      arrivals.length = 0;
      buckets.clear();
      pending.clear();
      stats.arrivals = 0;
      stats.elements = 0;
      stats.matched = 0;
      stats.failed = 0;
      stats.pendingHit = 0;
      stats.staleSlot = 0;
      stats.dupSlot = 0;
      stats.fpKeyed = 0;
      stats.fpMiss = 0;
    },

    /** WS 到达一条弹幕：先看有没有等它的元素，没有就入队 */
    onArrival(item) {
      const now = item.ts || Date.now();
      const rec = Object.assign({ seq: ++seq, used: false, dropped: false, ts: now }, item);
      stats.arrivals += 1;

      let hit = null;
      let hitKey = "";
      for (const key of keysOf(rec)) {
        const list = pending.get(key);
        if (!list || !list.length) continue;
        for (const slot of list) {
          if (!slotStillValid(slot, key)) continue;
          if (!fpCompatible(slot, rec)) continue;
          if (rec.ts - slot.seenAt > ttlFor(slot)) continue;
          if (slot.seenAt - rec.ts > AHEAD) continue;
          if (!hit || slot.seenAt < hit.seenAt) {
            hit = slot;
            hitKey = key;
          }
        }
        if (hit) break;
      }

      arrivals.push(rec);
      for (const key of keysOf(rec)) pushBucket(key, rec);
      prune(now);

      if (hit) {
        hit.done = true;
        rec.used = true;
        stats.matched += 1;
        return { arrival: rec, slot: hit, key: hitKey };
      }
      return null;
    },

    /** 画面出现（或文字刚到位）一个元素：先看有没有等它的弹幕，没有就登记等后续弹幕 */
    onElement(slot) {
      const seenAt = slot.seenAt || Date.now();
      const rec = Object.assign({ done: false, seenAt }, slot);
      stats.elements += 1;

      // 同一个元素只保留一个未完成槽：B站会在插入后再补文字/类名，会触发好几次
      const hasEl = rec.el && typeof rec.el === "object";
      if (hasEl) {
        const prev = slotByEl.get(rec.el);
        if (prev && !prev.done) {
          if (prev.key === rec.key && prev.fp === rec.fp) {
            stats.dupSlot += 1;
            return null; // 同一个元素同一个 key，重复登记没意义
          }
          prev.done = true;
          stats.dupSlot += 1;
        }
        slotByEl.set(rec.el, rec);
      }

      let arrival = null;
      for (const key of keysOf(rec)) {
        const hit = takeArrival(key, seenAt, rec.fixed, rec.fp);
        if (hit) {
          if (String(key).indexOf("F\u0001") === 0) stats.fpKeyed += 1;
          arrival = hit;
          break;
        }
      }
      if (arrival) {
        rec.done = true;
        stats.matched += 1;
        return { arrival, slot: rec };
      }

      stats.failed += 1;
      for (const key of keysOf(rec)) {
        let list = pending.get(key);
        if (!list) {
          list = [];
          pending.set(key, list);
        }
        if (list.length < 40) list.push(rec);
      }
      return null;
    },

    /** 元素被 B站复用/内容变了：作废它的登记 */
    dropSlot(rec) {
      if (rec) rec.done = true;
    },
  };
}

// 全局配对器：main.js 的 initMatcher() 负责实例化（换房间时会重建）
let danmakuMatcher = null;

// ===== 35-decorate.js =====
// ===== 装饰层：把昵称/徽章写进画面弹幕元素 =====
// 状态一律进 WeakMap（B站重写 innerHTML / style 时 dataset 会跟着没，WeakMap 不会）。
// 元素被 B站重绘/复用后，靠 WeakMap 里的「原文 + 身份快照」直接补画，不必再跟队列配对。

const elState = new WeakMap(); // el -> {uid, orig, sig, span, styled, old, identity, ts}
const elsByUid = new Map(); // uid -> Set<el>（API 晚到补刷用）

const CHAT_SELECTOR = ".chat-history-list, .chat-items, #chat-items, [class*='chat-history'], [class*='chat-item']";

function isDanmakuElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (!el.matches || !el.matches(DANMAKU_ITEM_SELECTOR)) return false;
  if (el.closest(CHAT_SELECTOR)) return false;
  // 生命期闸门：B站 有两个池子——正在滚的（-roll/-show）和飘完回收的空壳（只有 bili-danmaku-x-dm，opacity:0）。
  // 不过滤的话，空壳会被当成新元素去配对，把新弹幕的昵称写到看不见的盒子上。
  // ★ v2.5.1：加上 -center —— 顶部/底部固定弹幕的类名是「-dm -center」（firstShow 后才补 -show），
  //   而高能弹幕会把 className 整段重写成「-dm -center -high-top」，把 -show 抹掉；
  //   只认 roll/show 时这类弹幕永远进不来（实测顶部「donk？」就是这样漏的）。
  //   历史白名单里的 -dm-fixed 是幻觉：现役 danmaku-v2.js（3.0.10）118 个类名里没有它。
  const cls = el.className && typeof el.className === "string" ? el.className : "";
  if (
    cls.indexOf("bili-danmaku-x-roll") < 0 &&
    cls.indexOf("bili-danmaku-x-show") < 0 &&
    cls.indexOf("bili-danmaku-x-center") < 0 &&
    cls.indexOf("bili-danmaku-x-dm-fixed") < 0
  ) {
    return false;
  }
  return true;
}

/** 固定弹幕（顶部/底部）：B站 用同一个 -center 渲染，只靠 --translateY 分上下 */
function isFixedDanmaku(el) {
  if (!el || !el.className || typeof el.className !== "string") return false;
  return el.className.indexOf("bili-danmaku-x-center") >= 0;
}

// 读「我们没动过的那部分文字」：跳过自己插入的昵称 span
function ownText(el, st) {
  const skip = st && st.span;
  if (!el.children || el.children.length === 0) return el.textContent || "";
  let out = "";
  for (const node of el.childNodes) {
    if (node === skip) continue;
    if (node.nodeType === 3) out += node.textContent || "";
    else if (node.nodeType === 1) out += node.textContent || "";
  }
  return out;
}

function classifyElement(el, st) {
  const imgs = el.querySelectorAll ? el.querySelectorAll("img") : [];
  const text = normalizeText(ownText(el, st));
  if (imgs.length && !text) {
    const key = emoticonFileKey(imgs[0].getAttribute("src") || imgs[0].src || "");
    if (!key) return null;
    return { kind: "emoji", key: "e:" + key, altKey: "", text: "" };
  }
  if (!text || text.length > 120) return null;
  return { kind: imgs.length ? "mixed" : "text", key: text, altKey: "", text };
}

function removeOwnSpan(el, st) {
  if (st && st.span && st.span.parentNode === el) {
    try {
      el.removeChild(st.span);
    } catch (_) {}
  }
  if (st) st.span = null;
  // 高光层跟昵称同生同灭：所有「撤装饰」的路径（回收 / 复用 / 空壳）都走这里
  removeFx(st);
}

// ===== 高光效果层（v2.6）=====
// 一个挂在弹幕元素里的 z-index:-1 层，用 left/right 负内缩把「左侧昵称 + 正文」一起包住，
// 宽度不用 JS 算：昵称宽度写进 --bf-nw，其余交给 CSS。不占布局宽度 → 不改 B站 的滚动速度。
//   card   = 半透明档位色底牌 + 左侧色条（常驻，中途看过来也认得出）
//   orbit  = 两段光沿框绕圈（每帧重绘，同屏限量）
//   ripple = 出场时向外扩散两圈（只在出现/身份刚查到的那一刻）
const FX_ORBIT_MAX = 6;
const fxOrbits = new Set();

function removeFx(st) {
  if (!st) return;
  if (st.fx) {
    try {
      st.fx.remove();
    } catch (_) {}
    fxOrbits.delete(st.fx);
  }
  st.fx = null;
  st.fxKey = "";
  st.fxW = -1;
}

function fxNickW(st) {
  const span = st.span;
  if (!span) return 0;
  const html = span.__bfHtml || "";
  if (!html) return 0;
  if (!st.nickM || st.nickM.html !== html) {
    st.nickM = { html, w12: measureNickWidth(html, NICK_FONT_MAX, getComputedStyle(span)) };
  }
  return Math.max(NICK_FLOOR_W, Math.min(st.nickM.w12, NICK_CAP_W));
}

function syncFxGeom(st) {
  const fx = st.fx;
  if (!fx) return;
  const w = fxNickW(st);
  if (st.fxW !== w) {
    st.fxW = w;
    fx.style.setProperty("--bf-nw", w + "px");
  }
  const right = st.nickSide === "right";
  if (fx.classList.contains("bf-fx-r") !== right) fx.classList.toggle("bf-fx-r", right);
}

function applyFx(el, st, display) {
  let list = display.color && display.fx ? display.fx.slice() : [];
  if (!list.length) {
    removeFx(st);
    return;
  }
  const key = list.join("+") + "|" + display.color;
  if (st.fx && st.fx.parentNode === el && st.fxKey === key) {
    syncFxGeom(st);
    return;
  }
  removeFx(st);
  for (const o of fxOrbits) if (!o.isConnected) fxOrbits.delete(o);
  // 绕圈每帧重绘：同屏超过上限的降级为「底牌/涟漪」，不让它把页面拖慢，也避免满屏都在转
  if (list.indexOf("orbit") >= 0 && fxOrbits.size >= FX_ORBIT_MAX) {
    list = list.filter((f) => f !== "orbit");
    state.stats.fxOrbitCapped = (state.stats.fxOrbitCapped || 0) + 1;
  }
  st.fxKey = key; // 记原始 key：降级过的这条不会每次重画都重试
  if (!list.length) return;
  const fx = document.createElement("span");
  fx.className = "bf-fx " + list.map((f) => "bf-fx-" + f).join(" ");
  fx.setAttribute("aria-hidden", "true");
  fx.style.setProperty("--bf-c", display.color);
  let html = "";
  if (list.indexOf("ripple") >= 0) html += '<i class="bf-fx-rip"></i>';
  if (list.indexOf("orbit") >= 0) {
    html +=
      '<svg class="bf-fx-orb"><rect class="o1" x="1" y="1" rx="6" pathLength="100"></rect>' +
      '<rect class="o2" x="1" y="1" rx="6" pathLength="100"></rect></svg>';
  }
  fx.innerHTML = html;
  el.appendChild(fx);
  st.fx = fx;
  st.fxW = -1;
  if (list.indexOf("orbit") >= 0) fxOrbits.add(fx);
  state.stats.fxPainted = (state.stats.fxPainted || 0) + 1;
  syncFxGeom(st);
}

function restoreStyle(el, st) {
  if (!st || !st.styled) return;
  const old = st.old || {};
  applyProp(el, "color", old.color, old.colorPrio);
  applyProp(el, "-webkit-text-fill-color", old.fill, old.fillPrio);
  applyProp(el, "text-shadow", old.shadow, old.shadowPrio);
  st.styled = false;
}

function applyProp(el, name, value, priority) {
  try {
    if (value) el.style.setProperty(name, value, priority || "");
    else el.style.removeProperty(name);
  } catch (_) {}
}

/** 幂等加类名：已经在就别碰（classList.add 每次都算一次属性变更，会喂给 MutationObserver） */
function addClass(el, name) {
  if (!el.classList.contains(name)) el.classList.add(name);
}

function removeClass(el, name) {
  if (el.classList.contains(name)) el.classList.remove(name);
}

// ===== 昵称宽度/显隐自适应 =====
// 根因（真机实测）：B站 用「固定时长」滚动 → 越宽的元素滚得越快（实测 45px 宽 = -140px/s，
//   175px 宽 = -154px/s）。昵称是在 B站 算完宽度和速度之后才加上的：
//   · 内联 → 元素变宽 → 滚得更快 → 追上同轨前面那条，压字
//   · 绝对定位向左外溢 → 不改变宽度/速度（对了），但会盖住左邻，除非按间隙收窄
// 所以：昵称必须绝对定位（不碰宽度），并且每帧按「与同轨前一条的真实间隙」决定字号/宽度。
//
// 2026-11-18 按 Master 圈定改成「缩小优先」阶梯（旧版一律 11px + 58px 上限，长名字被截成两三个字）：
//   ① 12px 完整放得下 → 12px 整段显示
//   ② 放不下 → 降到 11px（仍尽量整段）
//   ③ 11px 还放不下 → 收窄到真实间隙 + 省略号
// ★ 2026-11-19 v2.5.0：取消「连两个字都放不下就整段隐藏」。
//   真机 60s 实测 13.9% 弹幕昵称被 display:none、真实可见率只有 84.7%，
//   而诊断只判 span 存在、一直报「漏 0」。改成保底 3 字 + 深色底衬，
//   宁可叠在左邻上（底衬保证可读），也不让标注整段消失。
const NICK_CAP_W = 240;  // 昵称硬上限（正常放得下就整段显示，这里只防极端长名）
const NICK_FLOOR_W = 36; // ★ v2.5.0：空间再小也至少留 3 个字，绝不整段隐藏
const NICK_FONT_MAX = 12; // 优先字号：完整显示
const NICK_FONT_MIN = 11; // 次选字号：放不下时缩小
const NICK_LANE_TOL = 16; // 垂直中心差多少 px 内算同轨（B站 轨道间距约 30px）
let nickLoopTimer = 0;
let nickMeasurer = null;

/** 用一个离屏节点量昵称的自然宽度：不改动画面上的 span，避免闪烁 */
function measureNickWidth(html, fontSize, cs) {
  if (!nickMeasurer) {
    nickMeasurer = document.createElement("div");
    nickMeasurer.id = "bf-nick-measure";
    nickMeasurer.style.cssText =
      "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;font-weight:600;line-height:1;";
    (document.body || document.documentElement).appendChild(nickMeasurer);
  }
  if (cs && cs.fontFamily) nickMeasurer.style.fontFamily = cs.fontFamily;
  nickMeasurer.style.fontSize = fontSize + "px";
  nickMeasurer.innerHTML = html || "";
  return Math.ceil(nickMeasurer.getBoundingClientRect().width);
}

function ensureNickLoop() {
  if (nickLoopTimer) return;
  nickLoopTimer = setInterval(fitAllNicks, 120);
}

function fitAllNicks() {
  const first = document.querySelector(DANMAKU_ITEM_SELECTOR);
  if (!first) return;
  const cont = first.closest(".danmaku-item-container") || first.parentElement;
  if (!cont) return;

  // ★ 不能按 --top 字符串分组：B站 实际给的是 33.125px / 34px 这类带小数且不统一的值，
  //   同一视觉行的两条会被当成不同轨道，于是「同轨重叠」永远测不出来（真机踩过）。
  //   改成直接看「垂直方向是否重叠」，不依赖 --top。
  const items = [];
  for (const el of cont.querySelectorAll(DANMAKU_ITEM_SELECTOR)) {
    const st = elState.get(el);
    if (!st || !st.span || st.span.parentNode !== el) continue;
    // ★ 空壳清扫：B站 回收元素时会先清空正文，但我们的昵称 span 还挂在上面 →
    //   画面上出现「只有昵称、没有正文」的残影（截图实测：`洛洛:` 单独一行），
    //   而且它会被当成左邻算进间隙，把真弹幕的昵称挤掉。
    //   MutationObserver 不一定能赶上（元素可能不再变更），所以在这里兜底。
    //   注意排除表情弹幕：它们本来就没有文字，只有 img。
    if (!normalizeText(ownText(el, st)) && !el.querySelector("img")) {
      cleanupDecor(el, st);
      continue;
    }
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    items.push({ st, l: r.left, r: r.right, t: r.top, b: r.bottom, fixed: isFixedDanmaku(el) });
  }
  if (!items.length) return;

  const contLeft = cont.getBoundingClientRect().left;

  for (const cur of items) {
    const span = cur.st.span;

    // 昵称要占的空间：从本条左边缘往左，最多 NICK_CAP_W + 4px 间距
    // 可用量 = 本条左边缘 - 左侧所有「同轨」元素的最右边缘 - 间距
    // ★ 同轨判定必须用「垂直中心差」而不是「有交集」：
    //   表情弹幕高 45px，跨两条轨道，用「有交集」会把上一轨的表情算成本轨左邻，
    //   算出 -60/-87/-161 这种负余量，把真弹幕的昵称全挤掉（真机实测 553/586 被隐藏）。
    const curMid = (cur.t + cur.b) / 2;
    let leftLimit = contLeft; // 不能越过容器左边缘
    // ★ v2.5.1：固定弹幕（-center）不参与这套间隙算法。
    //   它是居中静止的，左边**永远**有滚动弹幕路过；按滚动逻辑算出来的可用空间接近 0，
    //   昵称会被压成保底的 36px（3 个字）——这就是「底部弹幕像没标注」的主因，顶部同理。
    //   反过来，固定弹幕也不会挡别人的路（它不滚动，不追尾），所以也别算进别人的 leftLimit。
    if (!cur.fixed) {
      for (const o of items) {
        if (o === cur || o.fixed) continue;
        const oMid = (o.t + o.b) / 2;
        if (Math.abs(oMid - curMid) > NICK_LANE_TOL) continue; // 不同轨
        if (o.r <= cur.l) {                                  // 在本条左侧
          if (o.r > leftLimit) leftLimit = o.r;
        }
      }
    }

    // 固定弹幕：昵称按自然宽度放（上限 NICK_CAP_W），不缩不截
    const avail = cur.fixed ? NICK_CAP_W + 4 : Math.floor(cur.l - leftLimit - 4);
    // ★ v2.5.0：空间不足不再整段 display:none。保底窄标 + 深色底衬，标注永远在。
    if (span.style.display === "none") span.style.setProperty("display", "block", "important");
    const html = span.__bfHtml || "";
    if (!cur.st.nickM || cur.st.nickM.html !== html) {
      const cs = getComputedStyle(span);
      cur.st.nickM = { html, w12: measureNickWidth(html, NICK_FONT_MAX, cs) };
    }
    // ★ v2.5.2：**不再按间隙把昵称截成 2-3 个字**。
    //   真机实测（440006，4 分钟 216 条滚动弹幕）：顶部拥挤带昵称截断率 15.2%，
    //   中部只有 1.5%——因为同轨左边有邻居时，旧逻辑把 max-width 收到 36px。
    //   用户看到的「底部/顶部弹幕没标注」就是这个：名字只剩两三个字，认不出是谁。
    //   新口径：昵称有多宽就显示多宽（≤240px），放不下就加深色底衬压过去——
    //   弹幕本来就在飘，0.5 秒后左邻就走开了，比截断成「砰砰绅:」强得多。
    const fullW = Math.min(cur.st.nickM.w12, NICK_CAP_W);
    const font = cur.st.nickM.w12 > NICK_CAP_W ? NICK_FONT_MIN : NICK_FONT_MAX;
    if (cur.st.nickFont !== font) {
      cur.st.nickFont = font;
      span.style.setProperty("font-size", font + "px", "important");
    }
    const capW = Math.max(NICK_FLOOR_W, fullW);
    if (cur.st.nickW !== capW) {
      cur.st.nickW = capW;
      span.style.setProperty("max-width", capW + "px", "important");
    }
    // ★ v2.5.1：固定弹幕居中，昵称挂在左侧；弹幕本身够长时会越出容器左沿被裁掉 → 翻到右侧
    if (cur.fixed) {
      const needW = Math.min(cur.st.nickM ? cur.st.nickM.w12 : 0, NICK_CAP_W);
      const side = cur.l - needW - 6 < contLeft ? "right" : "left";
      if (cur.st.nickSide !== side) {
        cur.st.nickSide = side;
        if (side === "right") {
          span.style.setProperty("left", "100%", "important");
          span.style.setProperty("right", "auto", "important");
          span.style.setProperty("margin", "0 0 0 4px", "important");
        } else {
          span.style.setProperty("right", "100%", "important");
          span.style.setProperty("left", "auto", "important");
          span.style.setProperty("margin", "0 4px 0 0", "important");
        }
      }
    }
    // 放不下就加深色底衬（压在左邻上仍读得清）；空间够了就撤掉。固定弹幕不需避让，不加底衬
    const needBg = !cur.fixed && fullW > avail + 4;
    if (cur.st.nickBg !== needBg) {
      cur.st.nickBg = needBg;
      if (needBg) {
        span.style.setProperty("background", "rgba(16,11,15,.82)", "important");
        span.style.setProperty("border-radius", "3px", "important");
        span.style.setProperty("padding", "0 2px", "important");
        span.style.setProperty("text-shadow", "none", "important");
      } else {
        span.style.removeProperty("background");
        span.style.removeProperty("border-radius");
        span.style.removeProperty("padding");
        span.style.removeProperty("text-shadow");
      }
    }
    // 高光层跟着昵称宽度/左右翻转走（值没变就不写 DOM）
    if (cur.st.fx) syncFxGeom(cur.st);
  }
}

function saveStyle(el, st) {
  if (st.styled) return;
  st.old = {
    color: el.style.getPropertyValue("color"),
    colorPrio: el.style.getPropertyPriority("color"),
    fill: el.style.getPropertyValue("-webkit-text-fill-color"),
    fillPrio: el.style.getPropertyPriority("-webkit-text-fill-color"),
    shadow: el.style.getPropertyValue("text-shadow"),
    shadowPrio: el.style.getPropertyPriority("text-shadow"),
  };
  st.styled = true;
}

function renderSpan(display) {
  const parts = [];
  for (const b of display.badges) {
    const color = normalizeColor(b.color, "");
    parts.push(
      '<i class="bf-b"' +
        (color ? ' style="color:' + color + ";-webkit-text-fill-color:" + color + '"' : "") +
        ">" +
        escapeHtml(b.text) +
        "</i>"
    );
  }
  parts.push('<span class="bf-n">' + escapeHtml(display.nick) + "</span>");
  return parts.join("");
}

function signatureOf(display) {
  return (
    display.nick + "|" + display.small + "|" + display.smallSize + "|" + display.color + "|" + display.glow + "|" +
    (display.fx ? display.fx.join("+") : "") + "|" +
    display.badges.map((b) => b.text + b.color).join(",")
  );
}

function displayFor(identity, uid) {
  const settings = state.settings;
  const meta = state.users[String(uid)] || {};
  const ctx = {
    customSet: customNameSet(settings),
    watchUidSet: watchUidSet(settings),
    topRank: topRankOf(uid),
  };
  return composeNick(identity, meta, settings, ctx);
}

/** 低层写入：只负责把 display 落到 DOM */
function paintDisplay(el, st, display, cls) {
  trace("paint:write");
  const isEmoji = !!(cls && cls.kind === "emoji");
  let span = st.span;
  if (!span || span.parentNode !== el) {
    span = document.createElement("span");
    span.className = "bf-nick";
    if (isEmoji) el.appendChild(span);
    else el.insertBefore(span, el.firstChild);
    st.span = span;
  }
  const html = renderSpan(display);
  if (span.__bfHtml !== html) {
    span.innerHTML = html;
    span.__bfHtml = html;
  }
  span.className = "bf-nick" + (display.small ? " bf-small" : "");

  // ★★ 文字弹幕的昵称必须绝对定位，绝不能内联。
  //   根因（真机实测）：B站 用【固定时长】滚动，越宽的元素滚得越快
  //   （实测 45px 宽 = -140px/s，175px 宽 = -154px/s，反推时长都是 9.07s）。
  //   内联插入昵称会把元素撑宽 → 跑得更快 → 几秒后追上同轨前面那条 → 压字。
  //   这就是「调小字号/收紧宽度都治不好」的原因：只要占宽度就改变速度。
  //   绝对定位不占布局宽度，B站 的宽度与速度计算完全不受影响；
  //   外溢到左侧的空间由 fitAllNicks 按真实间隙逐帧收窄（装不下就不显示）。
  span.style.setProperty("position", "absolute", "important");
  // 固定弹幕若已翻到右侧（fitAllNicks 判过界），重画时保持，不要闪回左边
  if (st.nickSide === "right") {
    span.style.setProperty("left", "100%", "important");
    span.style.setProperty("right", "auto", "important");
    span.style.setProperty("margin", "0 0 0 4px", "important");
  } else {
    span.style.setProperty("right", "100%", "important");
    span.style.setProperty("left", "auto", "important");
    span.style.setProperty("margin", "0 4px 0 0", "important");
  }
  span.style.setProperty("top", "50%", "important");
  span.style.setProperty("transform", "translateY(-50%)", "important");
  span.style.setProperty("width", "max-content", "important");
  span.style.setProperty("max-width", NICK_CAP_W + "px", "important");
  span.style.setProperty("overflow", "hidden", "important");
  span.style.setProperty("text-overflow", "ellipsis", "important");
  span.style.setProperty("white-space", "nowrap", "important");
  span.style.setProperty("font-size", NICK_FONT_MAX + "px", "important");
  span.style.setProperty("opacity", "0.92", "important");
  span.style.setProperty("line-height", "1", "important");
  span.style.setProperty("display", "block", "important");
  span.style.setProperty("pointer-events", "auto", "important");
  // 昵称挂在元素外侧，父级不能裁
  addClass(el, "bf-nick-open");
  ensureNickLoop();

  if (isEmoji) {
    // 纯表情：表情图宽度不能动（撑开会变成巨图），昵称只能绝对定位到图片左侧外溢。
    span.style.setProperty("position", "absolute", "important");
    span.style.setProperty("right", "100%", "important");
    span.style.setProperty("top", "50%", "important");
    span.style.setProperty("transform", "translateY(-50%)", "important");
    span.style.setProperty("width", "max-content", "important");
    span.style.setProperty("margin", "0 4px 0 0", "important");
    span.style.setProperty("font-size", NICK_FONT_MAX + "px", "important");
    addClass(el, "bf-emoji-open");
  }
  addClass(el, "bf-hit");

  if (display.color) {
    saveStyle(el, st);
    el.style.setProperty("color", display.color, "important");
    el.style.setProperty("-webkit-text-fill-color", display.color, "important");
    if (display.glow) el.style.setProperty("text-shadow", "0 0 3px #000,0 0 9px " + display.color, "important");
    else el.style.removeProperty("text-shadow");
  } else if (st.styled) {
    restoreStyle(el, st);
  }
  applyFx(el, st, display);
  st.sig = signatureOf(display);
  st.ts = Date.now();
}

/** 把我们对某个元素做过的一切抹掉（昵称 span / 样式 / 类名 / 索引）。
 *  ★ 必须在「元素是否还是活动弹幕」的判定之外调用：B站 回收元素时会先剥掉
 *    -roll/-show 类名，但我们的 span 还挂在上面，元素仍以固定坐标渲染 ——
 *    真机实测会在容器右沿堆出一坨「只有昵称、没有正文」的残影（5 条叠在同一点）。 */
function cleanupDecor(el, st) {
  if (!st) return;
  removeOwnSpan(el, st);
  restoreStyle(el, st);
  el.style.removeProperty("font-size");
  removeClass(el, "bf-emoji-open");
  removeClass(el, "bf-nick-open");
  removeClass(el, "bf-hit");
  const set = elsByUid.get(st.uid);
  if (set) set.delete(el);
  elState.delete(el);
}

/** 处理一个新出现的弹幕元素 */
// ★ 2026-11-19 v2.5.0：熔断按「元素」去重，不再按 handleElement 回调次数。
//   一条弹幕会触发 6-9 次回调（插入 / 补文字 / 补 -roll / 补 -show / 我们自己的 addClass 回灌），
//   按回调计数在峰值窗口会误触发；而原来的 return 在 cleanupDecor 之前，
//   会连带丢掉「复用残影清理」和「新元素登记」。改成超限排队、窗口末尾补跑，一条不丢。
//   （实测当前房间 200ms 峰值仅 41 次、runaway=0，这条是消除高密度峰值时的隐患。）
let __burstAt = 0;
let __burstSeen = new WeakSet();
let __burstCount = 0;
let __burstDeferred = [];
let __burstFlush = 0;
function handleElement(el, fromDefer) {
  const now = Date.now();
  if (now - __burstAt > 200) {
    __burstAt = now;
    __burstCount = 0;
    __burstSeen = new WeakSet();
  }
  if (!fromDefer) {
    if (!__burstSeen.has(el)) { __burstSeen.add(el); __burstCount += 1; }
    if (__burstCount > 200) {
      state.stats.runaway = (state.stats.runaway || 0) + 1;
      trace("el:runaway " + __burstCount);
      if (__burstDeferred.indexOf(el) < 0) __burstDeferred.push(el);
      if (!__burstFlush) {
        __burstFlush = setTimeout(() => {
          const list = __burstDeferred;
          __burstDeferred = [];
          __burstFlush = 0;
          for (const x of list) { try { handleElement(x, true); } catch (_) {} }
        }, 0);
      }
      return;
    }
  }
  trace("el:handle");
  if (!state.settings || !state.settings.enabled) return;

  // ★ 先清理、再判定：元素已离开活动池（B站 回收），我们的装饰必须跟着撤掉。
  if (!isDanmakuElement(el)) {
    const old = elState.get(el);
    if (old) state.stats.recycled = (state.stats.recycled || 0) + 1; // 飘完回池时撤装饰（实测这是主路径）
    cleanupDecor(el, old);
    return;
  }

  let st = elState.get(el);
  const cur = normalizeText(ownText(el, st));

  // ① 元素被复用：内容变了 → 清干净当新元素处理
  //   ★ v2.6.2 第二道闸：纯表情正文是空串、同款表情 <img> 一模一样，「文字变了」永远判不出复用；
  //   同文本不同人也一样。B站 render 会重写 --color/--fontSize，指纹变了就一定换了一条弹幕。
  //   （第一道闸是 70-main.js 里按 class 旧值撤装饰；这道兜住同帧合并等漏网情况）
  const fpNow = st && st.fp ? domFingerprint(el) : "";
  const fpChanged = !!(st && st.fp && fpNow && fpNow !== st.fp);
  if (st && st.uid && ((cur && cur !== st.orig) || fpChanged)) {
    trace("reuse:" + st.uid + " cur=" + cur.slice(0, 16) + " orig=" + String(st.orig || "").slice(0, 16) + " span=" + !!(st.span && st.span.parentNode === el));
    removeOwnSpan(el, st);
    restoreStyle(el, st);
    el.style.removeProperty("font-size");
    el.classList.remove("bf-emoji-open", "bf-nick-open", "bf-hit");
    const set = elsByUid.get(st.uid);
    if (set) set.delete(el);
    elState.delete(el);
    st = null;
  }

  const cls = classifyElement(el, st);
  if (!cls) {
    // B站 回收元素时会先清空文字/图片，这时 classify 返回 null。
    // 如果直接 return，我们上一轮插进去的昵称会孤零零挂在空盒子上
    // （真机截图实测：画面上挂着一行「森罗万象之主宰:」后面什么都没有）。
    if (st && st.span) {
      removeOwnSpan(el, st);
      restoreStyle(el, st);
      el.style.removeProperty("font-size");
      removeClass(el, "bf-emoji-open");
      removeClass(el, "bf-hit");
      const deadSet = elsByUid.get(st.uid);
      if (deadSet) deadSet.delete(el);
      elState.delete(el);
    }
    return;
  }

  // ② 已经认过身份 → 只在「签名变了 / span 丢了」时重画。
  //    ★ 绝不能无条件重画：paintDisplay 会写 innerHTML，写 innerHTML 又产生 mutation，
  //    mutation 又回到这里 —— 真机实测会把页面主线程锁死（两个直播页直接卡死不响应）。
  if (st && st.uid && st.identity) {
    const display = displayFor(st.identity, st.uid);
    const sig = signatureOf(display);
    const spanAlive = !!(st.span && st.span.parentNode === el);
    if (sig === st.sig && spanAlive) {
      state.stats.paintSame += 1;
      return;
    }
    paintDisplay(el, st, display, cls);
    return;
  }

  // ③ 全新元素 → 找配对
  const slot = { key: cls.key, altKey: cls.altKey, el, seenAt: Date.now(), fixed: isFixedDanmaku(el), fp: domFingerprint(el) };
  const hit = danmakuMatcher.onElement(slot);
  if (!hit) {
    debugLog("element-wait", { text: cls.text.slice(0, 20), kind: cls.kind });
    return;
  }
  paintElement(el, hit.arrival, cls);
}

function paintElement(el, identityOrArrival, cls) {
  // 配对器返回的是「到达记录」，真身份在 .identity 里；直接当身份用会拿到 uid=undefined，
  // 于是昵称算成空串、整条被丢弃（真机实测：166 条只标上 5 条就是栽在这）。
  const identity = identityOrArrival && identityOrArrival.identity ? identityOrArrival.identity : identityOrArrival;
  if (!identity || !identity.uid) {
    state.stats.paintNoId += 1;
    trace("paint:no-id");
    return false;
  }
  trace("paint:start uid=" + identity.uid + " text=" + String(cls && cls.text || "").slice(0, 10));
  const display = displayFor(identity, identity.uid);
  trace("paint:display nick=" + display.nick.slice(0, 10) + " badges=" + display.badges.length);
  if (!display.nick && !display.badges.length) {
    state.stats.paintNoName += 1;
    return false;
  }

  let st = elState.get(el);
  if (!st) {
    st = { uid: String(identity.uid), orig: cls.text, sig: "", span: null, styled: false, old: null, identity: identity, ts: Date.now() };
    elState.set(el, st);
  }
  if (st.sig === signatureOf(display) && st.span && st.span.parentNode === el) {
    state.stats.paintSame += 1;
    return false;
  }

  st.uid = String(identity.uid);
  st.orig = cls.text || st.orig;
  st.identity = identity;
  st.fp = domFingerprint(el); // 复用判定用（见 handleElement ①）
  if (!st.origWidth && !st.span) st.origWidth = el.offsetWidth || el.scrollWidth || 0;
  paintDisplay(el, st, display, cls);
  state.stats.matched += 1;
  state.stats.paintOk += 1;
  trace("paint:painted");

  let set = elsByUid.get(st.uid);
  if (!set) {
    set = new Set();
    elsByUid.set(st.uid, set);
  }
  set.add(el);

  if (display.flags.custom || display.flags.follow || display.flags.fan || display.flags.keyword) {
    recordHighlight(identity, display);
  }
  return true;
}

/** API 回包后，把这个 uid 在屏幕上所有元素重刷一遍（元素不在了就当没发生） */
function onUserMeta(uid) {
  trace("meta:enter");
  const set = elsByUid.get(String(uid));
  if (!set || !set.size) return;
  for (const el of Array.from(set)) {
    if (!el.isConnected) {
      set.delete(el);
      continue;
    }
    const st = elState.get(el);
    if (!st || !st.identity) continue;
    const cur = normalizeText(ownText(el, st));
    if (cur && st.orig && cur !== st.orig) {
      set.delete(el);
      continue;
    }
    const display = displayFor(st.identity, st.uid);
    if (st.sig === signatureOf(display)) continue;
    paintDisplay(el, st, display, classifyElement(el, st));
  }
}

/** 面板里改了标注设置：把屏幕上的现存元素按身份快照重画一次（用户主动操作，允许一次性扫描） */
function repaintOnScreen() {
  document.querySelectorAll(DANMAKU_ITEM_SELECTOR).forEach((el) => {
    const st = elState.get(el);
    if (!st || !st.identity) return;
    const cls = classifyElement(el, st);
    if (!cls) return;
    paintDisplay(el, st, displayFor(st.identity, st.uid), cls);
  });
}

// ===== 40-hover.js =====
// ===== 悬停：只暂停鼠标下的那一条 + 弹出身份卡 =====
// 弹幕是 CSS animation 驱动的，Web Animations API 能精准暂停单条，B站不会抢回去。

const hoverState = {
  el: null, anims: null, timer: 0, cardShown: false, rafId: 0, x: 0, y: 0,
  overCard: false, leaveTimer: 0, deadAt: 0, uid: "", movedAt: 0,
  pinHiddenEl: null, // 被冻结层遮住的原元素（B站 回收它时要撤掉遮罩，别殃及复用后的新弹幕）
  pinX: null, pinY: null // 建框时的指针坐标，用来判定「用户有没有动鼠标」
};
// 源弹幕被 B站 回收/滚出屏幕后，身份卡再给这么久让人把鼠标挪上去（Master 2026-11-18 报「信息跟着弹幕一起消失」）
const DEAD_GRACE_MS = 2500;
const HOVER_LEAVE_MS = 260; // 从弹幕挪到身份卡的路上会短暂落在两者之间，给一个过渡窗口

function initHover() {
  if (hoverState.bound) return;
  hoverState.bound = true;

  document.addEventListener("mouseover", onHoverOver, true);
  document.addEventListener("mouseout", onHoverOut, true);
  document.addEventListener("mousemove", onHoverMove, { capture: true, passive: true });
  window.addEventListener("blur", () => endHover(true));
}

function hoverTarget(node) {
  let el = node;
  while (el && el.nodeType === 1) {
    if (el.classList && el.classList.contains("bf-nick")) return el.parentElement;
    if (el.classList && el.classList.contains("bili-danmaku-x-dm")) return el;
    el = el.parentElement;
  }
  return null;
}

function onHoverOver(e) {
  if (!state.settings || !state.settings.hoverCard) return;
  const el = hoverTarget(e.target);
  if (!el || !elState.has(el)) return;
  if (hoverState.el === el) return;
  // ★ 指针压在冻结层上 → 后来飘过来的弹幕不许抢走悬停（Master 2026-11-18 报）
  const pin = document.getElementById("bf-pin");
  if (hoverState.el && pin && pin.classList.contains("bf-pin-on") && insideRect(pin, 2)) return;
  // ★ 指针已经在身份卡上 → 更不许抢。B站 复用元素时会把新弹幕「移」到光标下，
  //   浏览器会补发 mouseover；不拦的话用户刚要把鼠标挪到卡片上，卡片就被顶掉了。
  if (cardOpen() && insideRect(document.getElementById("bf-card"), 3)) return;
  // ★ 指针压根没动（新弹幕自己飘到光标下）→ 一律不换。
  //   这是「弹幕飘过来抢走悬停」的判据：用户没动手，焦点就不该变。
  if (hoverState.el && pin && pin.classList.contains("bf-pin-on")
      && Math.abs(e.clientX - (hoverState.pinX == null ? -9999 : hoverState.pinX)) < 12
      && Math.abs(e.clientY - (hoverState.pinY == null ? -9999 : hoverState.pinY)) < 12) return;
  beginHover(el, e.clientX, e.clientY);
}

function onHoverOut(e) {
  if (!hoverState.el) return;
  const to = e.relatedTarget;
  if (to && (to === hoverState.el || hoverState.el.contains(to) || (to.closest && to.closest("#bf-card")))) return;
  // ★ 不能立刻收：鼠标往身份卡上挪的时候会先离开这条弹幕（落在两者之间的空隙里），
  //   立刻 endHover 会让卡片在鼠标快到卡片时消失 —— Master 2026-11-18 点名要这条。
  scheduleLeave();
}

function insideRect(el, pad) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const p = pad == null ? 4 : pad;
  return hoverState.x >= r.left - p && hoverState.x <= r.right + p && hoverState.y >= r.top - p && hoverState.y <= r.bottom + p;
}

function cardOpen() {
  const card = document.getElementById("bf-card");
  return !!(card && card.classList.contains("bf-open") && hoverState.cardShown);
}

/** 既不在这条弹幕上、也不在身份卡上：给 260ms 过渡，之后才真正收 */
function scheduleLeave() {
  if (hoverState.leaveTimer) return;
  hoverState.leaveTimer = setTimeout(() => {
    hoverState.leaveTimer = 0;
    if (!hoverState.el) return;
    // 判定锚点是冻结层（原元素已被藏起来且随时可能被 B站 复用，不能拿它当依据）
    const pin = document.getElementById("bf-pin");
    const stillPin = !!(pin && pin.classList.contains("bf-pin-on") && insideRect(pin, 3));
    const stillCard = cardOpen() && insideRect(document.getElementById("bf-card"), 2);
    if (!stillPin && !stillCard) endHover();
  }, HOVER_LEAVE_MS);
}

function onHoverMove(e) {
  if (!hoverState.el) return;
  // 用户是不是自己在动鼠标（区分「弹幕自己飘走」与「用户主动离开」）
  if (Math.abs(e.clientX - hoverState.x) > 2 || Math.abs(e.clientY - hoverState.y) > 2) hoverState.movedAt = Date.now();
  hoverState.x = e.clientX;
  hoverState.y = e.clientY;
  // ★ 鼠标已经压在身份卡上时，卡片不许跟着鼠标跑 —— 否则它自己从指针底下溜走，用户永远点不到。
  const card = document.getElementById("bf-card");
  if (cardOpen() && card && insideRect(card, 2)) {
    hoverState.overCard = true;
    return;
  }
  hoverState.overCard = false;
  // ★ 卡片位置只由 showCard 决定一次，之后绝不跟着鼠标走 ——
  //   否则卡片永远在指针正旁，用户往它身上挪的每一步它都先滑走，永远点不到「进入空间」。
}

function beginHover(el, x, y) {
  endHover(true);
  hoverState.el = el;
  hoverState.x = x;
  hoverState.y = y;
  clearTimeout(hoverState.timer);
  hoverState.timer = setTimeout(() => {
    if (!hoverState.el || !hoverState.el.isConnected) return;
    // ★ 不再暂停 B站 的动画：实测暂停反而让它提前回收。
    //   改为把这条弹幕冻结成我们自己的浮层（#bf-pin），它就不受 B站 回收池影响。
    pinDanmaku(hoverState.el);
    showCard(hoverState.el, x, y);
    followCursor(hoverState.el);
  }, 120);
}

// ===== 冻结层：#bf-pin =====
// 为什么不用「暂停 CSS 动画」：B站 的元素是池化复用的，它按自己的计时器把元素
// 塞回池子（display:none;opacity:0）再复给新弹幕。实测暂停动画后 0.3s，
// 同一个元素里的文字就从「茉莉雪毫:拿下」变成「果赖闯龙宫:？」——
// 暂停既拦不住回收，还会让用户看到一条僵在半路的弹幕。
// 所以改成：悬停时把这条弹幕的**外观**克隆一份挂到我们自己的 fixed 浮层上，
// 原元素藏起来。浮层不归 B站 管，它怎么回收复用都影响不到我们。
function pinDanmaku(el) {
  unpinDanmaku();
  const st = elState.get(el);
  if (!st) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // ★ uid 必须在这里就记下：守护循环靠它判断「元素是否已被 B站 复用」。
  hoverState.uid = String(st.uid);

  // ★ 不克隆原节点。B站 给弹幕挂了 position:absolute / right:100% / max-width /
  //   overflow:hidden 等一串内联 !important，克隆过来就得跟它们逐个搏斗，
  //   实测每修一处又冒出另一处（昵称被推出框外、被框沿裁掉）。
  //   改成用我们自己的状态拼一个干净 DOM：昵称 HTML 取 st.span，正文取 st.orig。
  const nickHtml = st.span && st.span.__bfHtml ? st.span.__bfHtml : (st.span ? st.span.innerHTML : "");
  const bodyText = String(st.orig || "").trim();

  const pin = document.createElement("div");
  pin.id = "bf-pin";
  pin.setAttribute("data-bftheme", state.settings.theme === "light" ? "light" : "dark");
  pin.className = "bf-pin-on";
  pin.style.left = Math.round(r.left) + "px";
  pin.style.top = Math.round(r.top) + "px";
  pin.style.minHeight = Math.round(r.height) + "px";

  const nick = document.createElement("span");
  nick.className = "bf-nick bf-pin-nick";
  nick.innerHTML = nickHtml;
  pin.appendChild(nick);

  const body = document.createElement("span");
  body.className = "bf-pin-text";
  body.textContent = bodyText;
  pin.appendChild(body);

  document.body.appendChild(pin);

  // 位置：先夹到视口内，再确保「指针在框内」。
  // ★ 必须包住指针：弹幕在 120ms 延迟里还在右移，等框定位时指针可能已经落在框外，
  //   下一帧就被判成「离开」→ 框闪没 → 新飘过来的弹幕又建一个新框
  //   （表现为「悬停的信息跟着弹幕跑了」，实测 notStolen=false 就是这个原因）。
  const pw = pin.offsetWidth;
  const ph = pin.offsetHeight;
  const cx = hoverState.x;
  const cy = hoverState.y;
  let left = r.left;
  if (cx < left) left = cx - 8;
  else if (cx > left + pw) left = cx - pw + 8;
  let top = r.top;
  if (cy < top) top = cy - 6;
  else if (cy > top + ph) top = cy - ph + 6;
  left = Math.min(Math.max(left, 4), Math.max(4, window.innerWidth - pw - 4));
  top = Math.min(Math.max(top, 4), Math.max(4, window.innerHeight - ph - 4));
  pin.style.left = Math.round(left) + "px";
  pin.style.top = Math.round(top) + "px";

  // 原元素藏起来（B站 回收它时我们才能感知到并撤遮罩）
  hoverState.pinHiddenEl = el;
  el.style.setProperty("visibility", "hidden", "important");

  hoverState.pinX = cx;
  hoverState.pinY = cy;
  hoverState.anims = null;
  hoverState.fallback = false;
}

function unpinDanmaku() {
  const pin = document.getElementById("bf-pin");
  if (pin) pin.remove();
  const el = hoverState.pinHiddenEl;
  if (el && el.isConnected) {
    // 只有它还「属于」被冻结的那条时才撤 —— 元素可能已被复用给新弹幕
    const st = elState.get(el);
    if (!st || String(st.uid) === String(hoverState.uid)) {
      el.style.removeProperty("visibility");
      el.style.removeProperty("opacity");
    }
  }
  hoverState.pinHiddenEl = null;
}

// 冻结层是 fixed 的，位置不再变；每帧只做两件事：
//   ① 守护原元素的隐藏（B站 会把它改回来，必须持续压住；但一旦被复用就立刻放手）
//   ② 判定指针是否还在「冻结层 / 身份卡」上
function followCursor(el) {
  cancelAnimationFrame(hoverState.rafId);
  const tick = () => {
    if (!hoverState.el || hoverState.el !== el) return;

    // ① 原元素是否已被 B站 回收或复用
    const st = elState.get(el);
    const reused = !el.isConnected || !st || String(st.uid) !== String(hoverState.uid);
    if (reused) {
      // 元素已经是别人的了 —— 必须放手，否则新弹幕会变成隐形弹幕
      if (hoverState.pinHiddenEl === el) {
        el.style.removeProperty("visibility");
        el.style.removeProperty("opacity");
        hoverState.pinHiddenEl = null;
      }
    } else if (hoverState.pinHiddenEl === el) {
      // 还是原来那条：持续压住（B站 重写 style 时会被覆盖，所以每帧补一次，开销极小）
      if (el.style.visibility !== "hidden") el.style.setProperty("visibility", "hidden", "important");
    }

    const card = document.getElementById("bf-card");
    const inCard = cardOpen() && !!card && insideRect(card, 2);
    if (inCard) {
      hoverState.overCard = true;
      if (hoverState.leaveTimer) { clearTimeout(hoverState.leaveTimer); hoverState.leaveTimer = 0; }
      hoverState.rafId = requestAnimationFrame(tick);
      return;
    }
    hoverState.overCard = false;

    const pin = document.getElementById("bf-pin");
    const inPin = !!(pin && pin.classList.contains("bf-pin-on") && insideRect(pin, 3));
    if (inPin) {
      if (hoverState.leaveTimer) { clearTimeout(hoverState.leaveTimer); hoverState.leaveTimer = 0; }
      hoverState.rafId = requestAnimationFrame(tick);
      return;
    }
    // 两个都不在：可能是正在往卡片那边挪，交给过渡窗口判定
    scheduleLeave();
    hoverState.rafId = requestAnimationFrame(tick);
  };
  hoverState.rafId = requestAnimationFrame(tick);
}

function endHover(immediate) {
  cancelAnimationFrame(hoverState.rafId);
  clearTimeout(hoverState.timer);
  clearTimeout(hoverState.leaveTimer);
  hoverState.leaveTimer = 0;
  hoverState.overCard = false;
  unpinDanmaku();
  hideCard();
  hoverState.el = null;
  hoverState.cardShown = false;
  hoverState.deadAt = 0;
  hoverState.uid = "";
  hoverState.pinX = null;
  hoverState.pinY = null;
}

function showCard(el, x, y) {
  const st = elState.get(el);
  if (!st || !st.identity) return;
  const identity = st.identity;
  const meta = state.users[String(st.uid)] || {};
  let card = document.getElementById("bf-card");
  if (!card) {
    card = document.createElement("div");
    card.id = "bf-card";
    card.setAttribute("data-bftheme", state.settings.theme === "light" ? "light" : "dark");
    document.body.appendChild(card);
  }
  card.classList.add("bf-open");
  card.innerHTML = renderCardHtml(identity, meta, null);
  hoverState.cardShown = true;
  hoverState.deadAt = 0;
  hoverState.uid = String(identity.uid);
  placeCard(x, y);

  apiFetchCard(st.uid).then((data) => {
    if (!hoverState.cardShown || hoverState.el !== el || !el.isConnected) return;
    const meta2 = state.users[String(st.uid)] || {};
    card.innerHTML = renderCardHtml(identity, meta2, data);
    // 鼠标已经在卡片上时不要重排，否则卡片从指针底下跳走、点不到「进入空间」
    if (!hoverState.overCard) placeCard(hoverState.x, hoverState.y);
  });
}

function hideCard() {
  const card = document.getElementById("bf-card");
  if (card) card.classList.remove("bf-open");
}

function placeCard(x, y) {
  const card = document.getElementById("bf-card");
  if (!card) return;
  const w = 280;
  const h = card.offsetHeight || 180;
  let left = x + 18;
  let top = y + 20;
  if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 18);
  if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 20);
  card.style.left = left + "px";
  card.style.top = top + "px";
}

function renderCardHtml(identity, meta, cardData) {
  const card = (cardData && cardData.card) || {};
  const face = card.face ? String(card.face).replace(/^http:/, "https:") : "";
  const name = card.name || meta.uname || identity.name || "";
  const fans = card.fans != null ? Number(card.fans) : Number(meta.follower || 0);
  const friend = card.friend != null ? Number(card.friend) : null;
  const level = card.level_info && card.level_info.current_level != null ? Number(card.level_info.current_level) : identity.userLevel;
  const sign = card.sign || "";
  const official = card.Official && card.Official.type >= 0 ? card.Official : null;
  const vip = card.vip || null;
  const medal = identity.medal;
  const u = state.users[String(identity.uid)] || {};
  const followed = u.followed;
  const relation = cardData && cardData.following ? "已关注" : followed ? "已关注" : "未关注";

  const medalHtml = medal
    ? '<span class="bf-cmedal" style="color:' + (normalizeColor(medal.color, "#8a8a99")) + '">Lv.' + medal.level + " " + escapeHtml(medal.name || "") + "</span>"
    : '<span class="bf-cmuted">无粉丝牌</span>';

  const guardHtml = identity.guard
    ? '<span class="bf-cbadge bf-cguard">' + (GUARD_LABEL[identity.guard] || "舰长") + "</span>"
    : "";

  const row = (label, value, cls) =>
    '<div class="bf-crow"><span class="bf-clabel">' + label + '</span><span class="bf-cval ' + (cls || "") + '">' + value + "</span></div>";

  return (
    '<div class="bf-cbody">' +
    '<div class="bf-chead">' +
    (face ? '<img class="bf-cface" src="' + escapeHtml(face) + '@48w_48h_1c.webp" alt="" loading="lazy">' : '<div class="bf-cface bf-cface-ph"></div>') +
    '<div class="bf-cwho"><div class="bf-cname">' + escapeHtml(name) + "</div>" +
    '<div class="bf-cuid">UID ' + escapeHtml(identity.uid) + (official ? ' <span class="bf-cverify">' + escapeHtml(official.desc || "认证") + "</span>" : "") + "</div></div>" +
    guardHtml +
    "</div>" +
    (sign ? '<div class="bf-csign">' + escapeHtml(sign) + "</div>" : "") +
    '<div class="bf-cstats">' +
    row("粉丝", cardData || meta.follower != null ? formatCount(fans) : '<span class="bf-cmuted">查询中…</span>') +
    row("关注", friend == null ? '<span class="bf-cmuted">—</span>' : formatCount(friend)) +
    row("关系", relation) +
    row("等级", "Lv" + level + (vip && vip.vipStatus ? ' <span class="bf-cvip">大会员</span>' : "")) +
    row("本场", speakerCount(identity.uid) + " 条") +
    "</div>" +
    '<div class="bf-cfoot">' + medalHtml +
    '<a class="bf-clink" href="https://space.bilibili.com/' + escapeHtml(identity.uid) + '" target="_blank" rel="noopener">进入空间</a>' +
    "</div>" +
    "</div>"
  );
}

// ===== 45-track.js =====
// ===== 场次统计 / 指定人进场 / 弹幕包分发 =====

const speakers = new Map(); // uid -> {name, count, first}
let rankCache = null;
let rankDirty = true;
let rankAt = 0;

function bumpSpeaker(identity) {
  const uid = String(identity.uid);
  const rec = speakers.get(uid);
  if (rec) {
    rec.count += 1;
    if (identity.name) rec.name = identity.name;
  } else {
    speakers.set(uid, { name: identity.name || "", count: 1, first: Date.now() });
  }
  rankDirty = true;
}

function rebuildRanks() {
  const rows = Array.from(speakers.entries())
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .slice(0, Math.max(1, Number(state.settings.topTalkerCount) || 10));
  rankCache = new Map();
  rows.forEach(([uid], i) => rankCache.set(uid, i + 1));
  rankAt = Date.now();
  rankDirty = false;
}

function topRankOf(uid) {
  if (!state.settings || !state.settings.topTalkerMark) return 0;
  if (!rankCache || rankDirty || Date.now() - rankAt > 1000) rebuildRanks();
  return rankCache.get(String(uid)) || 0;
}

function speakerCount(uid) {
  const rec = speakers.get(String(uid));
  return rec ? rec.count : 0;
}

function resetSession() {
  speakers.clear();
  rankCache = null;
  rankDirty = true;
  state.stats.captured = 0;
  state.stats.matched = 0;
  state.stats.matchFail = 0;
  state.stats.enter = 0;
}

// ===== 弹幕包入口 =====
function handleDanmakuPacket(msg) {
  if (!state.settings || !state.settings.enabled) return;
  trace("danmaku:enter");
  state.stats.dbg.seen += 1;
  if (!state.stats.rawSample && Array.isArray(msg.info)) state.stats.rawSample = msg;
  const identity = parseDanmakuInfo(msg);
  trace("danmaku:parsed uid=" + identity.uid + " text=" + identity.text.slice(0, 8));
  if (!identity.uid || identity.uid === "0") {
    state.stats.dbg.noUid += 1;
    // 诊断：第一条成功样本之外，额外存几条「拿不到 uid」的原始包，
    // 否则只看 rawSample（恒为第一条）永远查不出为什么后面全失败。
    if (!state.stats.noUidSample && Array.isArray(msg.info)) {
      state.stats.noUidSample = msg;
    }
    return;
  }
  if (!identity.text && !identity.emoticonKeys.length) {
    state.stats.dbg.noText += 1;
    return;
  }

  state.stats.captured += 1;
  state.stats.source = "已接收弹幕";
  state.queue.push(identity);
  if (state.queue.length > 400) state.queue.splice(0, state.queue.length - 400);

  const u = userRecord(identity.uid);
  if (identity.name) u.uname = identity.name;

  bumpSpeaker(identity);

  // 先配对、先上昵称——不排队等 API
  trace("danmaku:matcher");
  const hit = danmakuMatcher.onArrival({
    key: identity.matchText || identity.text,
    altKey: identity.text,
    fp: identity.fp,
    emojiKeys: identity.emoticonKeys,
    ts: identity.ts,
    identity: identity,
  });
  if (hit && hit.slot && hit.slot.el && hit.slot.el.isConnected) {
    const el = hit.slot.el;
    const cls = classifyElement(el, elState.get(el));
    trace("arrival:paint cls=" + (cls ? cls.kind + ":" + cls.text.slice(0, 10) : "null"));
    if (cls) paintElement(el, identity, cls);
  }

  // 再按优先级排队查粉丝数/关注关系
  trace("danmaku:api");
  apiEnqueue(identity.uid, apiPriorityFor(identity));
  trace("danmaku:done");
  debugLog("danmaku", { uid: identity.uid, name: identity.name, text: identity.text, medal: identity.medal, guard: identity.guard });
}

function handleInteractPacket(msg) {
  if (!state.settings || !state.settings.enabled) return;
  const data = msg.data || {};
  const uid = String(data.uid || "");
  const uname = String(data.uname || "");
  const msgType = Number(data.msg_type || 0);
  if (!uid) return;
  const u = userRecord(uid);
  if (uname) u.uname = uname;

  // 指定人进场提示（零 API 成本，走 INTERACT_WORD）
  if (msgType === 1 && state.settings.watchEnter && isWatchUid(uid)) {
    state.stats.enter += 1;
    showToast("♥ " + (uname || uid) + " 进入了直播间", "enter");
    debugLog("watch-enter", { uid, uname });
  }
}

// ===== 50-records.js =====
// ===== 高亮记录：收录命中标注的弹幕，支持搜索/筛选/导出/删除/跳空间 =====

const REC_TAGS = ["关注", "粉丝", "自定义", "关键词"];

const recState = {
  records: [],
  seen: new Set(),
  query: "",
  mode: "kw", // kw | exact | regex
  filter: { 关注: true, 粉丝: true, 自定义: true, 关键词: true },
  selectMode: false,
  selected: new Set(),
};

function recLoad() {
  if (!state.settings.recordPersist) return;
  const arr = safeJsonParse(gmGet(HL_KEY, "[]"), []);
  if (!Array.isArray(arr)) return;
  recState.records = arr.filter((h) => h && typeof h === "object");
  recState.seen = new Set(recState.records.map((h) => String(h.uid) + "|" + String(h.text || "")));
}

let recSaveTimer = 0;
function recSaveSoon() {
  if (!state.settings.recordPersist) return;
  clearTimeout(recSaveTimer);
  recSaveTimer = setTimeout(() => {
    gmSet(HL_KEY, JSON.stringify(recState.records.slice(-500)));
  }, 1200);
}

function recordHighlight(identity, display) {
  if (!state.settings.recordEnabled) return;
  if (!state.room.uid || !state.room.name) updateRoomInfo();

  const tags = [];
  if (display.flags.custom) tags.push("自定义");
  if (display.flags.follow) tags.push("关注");
  if (display.flags.fan) tags.push("粉丝");
  if (display.flags.keyword) tags.push("关键词");
  if (!tags.length) return;

  state.stats.recCaptured += 1;
  const key = String(identity.uid) + "|" + String(identity.text || "");
  if (recState.seen.has(key)) {
    state.stats.recDedup += 1;
    return;
  }
  recState.seen.add(key);
  recState.records.push({
    uid: String(identity.uid),
    name: identity.name || (state.users[identity.uid] && state.users[identity.uid].uname) || "",
    text: String(identity.text || ""),
    tags,
    ts: Date.now(),
    roomUid: String(state.room.uid || ""),
    roomName: state.room.name || "",
    roomTitle: state.room.title || "",
  });
  if (recState.records.length > 500) recState.records.splice(0, recState.records.length - 500);
  recSaveSoon();
  recUpdateCount();
}

function recUpdateCount() {
  const el = document.getElementById("bf-rec-n");
  if (el) el.textContent = String(recState.records.length);
}

function recMatcher() {
  const q = String(recState.query || "").trim();
  if (!q) return { ok: true, test: () => true, hi: (s) => escapeHtml(s) };
  if (recState.mode === "exact") return { ok: true, test: (s) => s === q, hi: (s) => escapeHtml(s) };
  if (recState.mode === "regex") {
    try {
      const re = new RegExp(q, "i");
      return {
        ok: true,
        test: (s) => re.test(s),
        hi: (s) => {
          try {
            return escapeHtml(s).replace(new RegExp("(" + q + ")", "ig"), "<mark>$1</mark>");
          } catch (_) {
            return escapeHtml(s);
          }
        },
      };
    } catch (_) {
      return { ok: false };
    }
  }
  const lc = q.toLowerCase();
  return {
    ok: true,
    test: (s) => s.toLowerCase().indexOf(lc) >= 0,
    hi: (s) => {
      const i = s.toLowerCase().indexOf(lc);
      if (i < 0) return escapeHtml(s);
      return escapeHtml(s.slice(0, i)) + "<mark>" + escapeHtml(s.slice(i, i + q.length)) + "</mark>" + escapeHtml(s.slice(i + q.length));
    },
  };
}

function recRows() {
  const m = recMatcher();
  if (!m.ok) return [];
  return recState.records
    .filter((h) => (h.tags || []).some((t) => recState.filter[t]))
    .filter((h) => m.test(h.name || "") || m.test(h.text || ""));
}

function recTime(ts) {
  const t = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate()) + " " + p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
}

function renderRecords() {
  const body = document.getElementById("bf-rec-list");
  if (!body) return;
  recUpdateCount();
  const sf = document.getElementById("bf-rec-sf");
  const m = recMatcher();
  if (sf) {
    sf.classList.toggle("bf-has", !!recState.query);
    sf.classList.toggle("bf-invalid", !m.ok);
  }
  const count = document.getElementById("bf-rec-filtered");
  const rows = recRows();
  const filtering = !!recState.query || Object.values(recState.filter).some((v) => !v);
  if (count) count.textContent = filtering ? "筛选后 " + rows.length + " 条" : "";

  if (!m.ok) {
    body.innerHTML = '<div class="bf-empty">正则表达式有误（搜索框已标红）</div>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="bf-empty">' +
      (recState.records.length
        ? "没有匹配的记录<br><span>试试调整筛选或搜索词</span>"
        : "还没有高亮弹幕记录<br><span>命中关注/粉丝/自定义/关键词的弹幕会自动收进来</span>") +
      "</div>";
    return;
  }

  const html = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const h = rows[i];
    const idx = recState.records.indexOf(h);
    const selKey = String(idx);
    const checked = recState.selected.has(selKey);
    const tags = (h.tags || [])
      .map((t) => '<span class="bf-rtag bf-rt-' + (t === "关注" ? "follow" : t === "粉丝" ? "fan" : t === "自定义" ? "custom" : "kw") + '">' + t + "</span>")
      .join("");
    const room = h.roomUid
      ? ' <a class="bf-croomlink" href="https://space.bilibili.com/' + escapeHtml(h.roomUid) + '" target="_blank" rel="noopener" title="直播间UP">@' + escapeHtml(h.roomName || "未知") + "</a>"
      : "";
    html.push(
      '<div class="bf-ritem' + (recState.selectMode ? " bf-rsel" : "") + '">' +
        '<button class="bf-rchk' + (checked ? " bf-on" : "") + '" data-idx="' + idx + '" title="选择">✓</button>' +
        '<div class="bf-rmeta"><span class="bf-rtime">' + recTime(h.ts) + "</span>" + tags + room +
          '<button class="bf-rcopy" data-idx="' + idx + '" title="复制">⧉</button>' +
          '<button class="bf-rdel" data-idx="' + idx + '" title="删除">🗑</button>' +
        "</div>" +
        '<div class="bf-rline"><a class="bf-rname" href="https://space.bilibili.com/' + escapeHtml(h.uid) + '" target="_blank" rel="noopener">' + m.hi(h.name || "") + "</a>：" + m.hi(h.text || "") + "</div>" +
        (h.roomTitle ? '<div class="bf-rroomtitle">📺 ' + escapeHtml(h.roomTitle) + "</div>" : "") +
      "</div>"
    );
  }
  body.innerHTML = html.join("");
  updateSelBar();
  recBackfillRoomNames();
}

/** 旧记录/抢跑记录只存了 roomUid 没存主播名 → 按 uid 补名、落盘、重绘（每个 uid 只请求一次） */
let recBackfilling = false;
function recBackfillRoomNames() {
  if (recBackfilling) return;
  const uids = [...new Set(recState.records.filter((h) => h.roomUid && !h.roomName).map((h) => String(h.roomUid)))];
  if (!uids.length) return;
  recBackfilling = true;
  Promise.all(uids.map((uid) => fetchUpName(uid).then((name) => [uid, name])))
    .then((pairs) => {
      let changed = 0;
      for (const [uid, name] of pairs) {
        if (!name) continue;
        for (const h of recState.records) {
          if (String(h.roomUid) === uid && !h.roomName) {
            h.roomName = name;
            changed += 1;
          }
        }
      }
      recBackfilling = false;
      if (changed) {
        recSaveSoon();
        renderRecords();
      }
    })
    .catch(() => {
      recBackfilling = false;
    });
}

function updateSelBar() {
  const bar = document.getElementById("bf-rec-selbar");
  if (!bar) return;
  bar.classList.toggle("bf-show", recState.selectMode);
  const c = document.getElementById("bf-rec-selcount");
  if (c) c.textContent = "已选 " + recState.selected.size + " 条";
}

function recExport() {
  const rows = recRows();
  const lines = rows.map(
    (h) =>
      recTime(h.ts) + "\t[" + (h.tags || []).join("/") + "]" +
      (h.roomTitle ? "\t📺" + h.roomTitle : "") +
      (h.roomName ? "\t@" + h.roomName + "(" + h.roomUid + ")" : "") +
      "\t" + (h.name || "") + "：" + (h.text || "")
  );
  const text = "# B站高亮弹幕记录　共 " + rows.length + " 条\n" + lines.join("\n");
  try {
    GM_setClipboard(text);
    showToast("已复制 " + rows.length + " 条记录");
  } catch (_) {
    showToast("复制失败（剪贴板不可用）");
  }
}

function recDelete(idx) {
  const h = recState.records[idx];
  if (!h) return;
  recState.records.splice(idx, 1);
  recState.seen.delete(String(h.uid) + "|" + String(h.text || ""));
  recState.selected.clear();
  recSaveSoon();
  renderRecords();
}

function recDeleteSelected() {
  const idxs = Array.from(recState.selected).map(Number).sort((a, b) => b - a);
  if (!idxs.length) return;
  for (const i of idxs) {
    const h = recState.records[i];
    if (h) recState.seen.delete(String(h.uid) + "|" + String(h.text || ""));
    recState.records.splice(i, 1);
  }
  recState.selected.clear();
  recSaveSoon();
  renderRecords();
  showToast("已删除 " + idxs.length + " 条");
}

function recCopyOne(idx) {
  const h = recState.records[idx];
  if (!h) return;
  try {
    GM_setClipboard(recTime(h.ts) + "\t" + (h.name || "") + "：" + (h.text || ""));
    showToast("已复制这一条");
  } catch (_) {}
}

function recToggleSelect() {
  recState.selectMode = !recState.selectMode;
  if (!recState.selectMode) recState.selected.clear();
  renderRecords();
}

function bindRecordsPanel() {
  const panel = document.getElementById("bf-rec");
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#bf-rec-close")) {
      toggleRecords(false);
      return;
    }
    if (t.closest("#bf-rec-export")) {
      recExport();
      return;
    }
    if (t.closest("#bf-rec-sel")) {
      recToggleSelect();
      return;
    }
    if (t.closest("#bf-rec-delsel")) {
      recDeleteSelected();
      return;
    }
    if (t.closest("#bf-rec-clearq")) {
      recState.query = "";
      const inp = panel.querySelector("#bf-rec-q");
      if (inp) inp.value = "";
      renderRecords();
      return;
    }
    const chip = t.closest(".bf-rchip");
    if (chip) {
      const k = chip.getAttribute("data-k");
      recState.filter[k] = !recState.filter[k];
      chip.setAttribute("data-on", recState.filter[k] ? "1" : "0");
      renderRecords();
      return;
    }
    const modeBtn = t.closest(".bf-rmode button");
    if (modeBtn) {
      recState.mode = modeBtn.getAttribute("data-m");
      panel.querySelectorAll(".bf-rmode button").forEach((b) => b.setAttribute("data-on", b === modeBtn ? "1" : "0"));
      renderRecords();
      return;
    }
    const chk = t.closest(".bf-rchk");
    if (chk) {
      const idx = chk.getAttribute("data-idx");
      if (recState.selected.has(idx)) recState.selected.delete(idx);
      else recState.selected.add(idx);
      chk.classList.toggle("bf-on");
      updateSelBar();
      return;
    }
    const del = t.closest(".bf-rdel");
    if (del) {
      recDelete(Number(del.getAttribute("data-idx")));
      return;
    }
    const cp = t.closest(".bf-rcopy");
    if (cp) {
      recCopyOne(Number(cp.getAttribute("data-idx")));
      return;
    }
  });

  const input = panel.querySelector("#bf-rec-q");
  if (input) {
    input.addEventListener("input", () => {
      recState.query = input.value;
      renderRecords();
    });
  }
}

// ===== ui.css =====
const UI_CSS = "/* ===== 本脚本自有 UI =====\n   2026-11-18 按 Master 圈定重做：跟 B站 主色走、整块浮层偏粉（直播氛围，半透明玻璃，允许轻微发光），\n   展开/收起 200–250ms，尊重 prefers-reduced-motion。\n   约定：正文不铺粉（看直播看久了刺眼）——粉只出现在「玻璃底的粉调 / 强调色 / 轻微粉光 / 语义点」。\n   字号只留 11 / 12 / 13 三档，字重只留 400 / 500 / 600；间距走 4px 格；圆角 8(控件) / 14(浮层)。 */\n\n#bf-panel,\n#bf-rec,\n#bf-card,\n#bf-orb,\n#bf-toast,\n#bf-pin {\n  --bf-bg: rgba(26, 18, 24, 0.88);\n  --bf-bg2: rgba(38, 26, 34, 0.94);\n  --bf-s2: rgba(255, 235, 243, 0.06);\n  --bf-s3: rgba(255, 235, 243, 0.11);\n  --bf-border: rgba(255, 200, 220, 0.13);\n  --bf-border2: rgba(255, 200, 220, 0.22);\n  --bf-text: #f3ecef;\n  --bf-muted: #a797a1;\n  --bf-accent: #fb7299;\n  --bf-accent-ink: #2b0d18;\n  --bf-pink: #fb7299;\n  --bf-fan: #ffd166;\n  --bf-custom: #22d3ee;\n  --bf-danger: #ff5c5c;\n  --bf-radius: 14px;\n  --bf-ctl: 8px;\n  --bf-ease: cubic-bezier(0.22, 0.8, 0.3, 1);\n  --bf-dur: 0.22s;\n  font-family: \"PingFang SC\", \"Microsoft YaHei\", system-ui, -apple-system, sans-serif;\n  color: var(--bf-text);\n  -webkit-font-smoothing: antialiased;\n}\n\n#bf-panel[data-bftheme=\"light\"],\n#bf-rec[data-bftheme=\"light\"],\n#bf-card[data-bftheme=\"light\"],\n#bf-pin[data-bftheme=\"light\"] {\n  --bf-bg: rgba(255, 249, 251, 0.94);\n  --bf-bg2: #ffffff;\n  --bf-s2: rgba(70, 20, 40, 0.05);\n  --bf-s3: rgba(70, 20, 40, 0.10);\n  --bf-border: rgba(70, 20, 40, 0.12);\n  --bf-border2: rgba(70, 20, 40, 0.20);\n  --bf-text: #2a1a21;\n  --bf-muted: #7b6a72;\n  --bf-accent: #e2597f;\n  --bf-accent-ink: #ffffff;\n  --bf-pink: #d83b78;\n  --bf-fan: #a97100;\n  --bf-custom: #0e7490;\n}\n\n/* ---------- 画面弹幕上的昵称 ---------- */\n/* 左沿渐隐：弹幕滚出画面时昵称先出界，只剩半截正文贴着容器边缘排成一列，很脏。\n   用 mask 让最后 7% 逐渐透明，观感上是「淡出」而不是「被切断」。 */\n.danmaku-item-container {\n  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 7%);\n  mask-image: linear-gradient(to right, transparent 0, #000 7%);\n}\n\n/* 昵称字号/宽度由 35-decorate.js 的 fitAllNicks 逐帧决定（放不下先缩字、再截断、最后才藏）。 */\n.bf-nick {\n  white-space: nowrap !important;\n  margin-right: 0.25em !important;\n  font-size: 12px;\n  line-height: 1;\n  font-weight: 600;\n  display: inline;\n}\n.bf-nick .bf-b {\n  font-style: normal;\n  margin-right: 0.14em;\n  opacity: 0.95;\n}\n.bf-nick .bf-n {\n  font-weight: 600;\n}\n/* 长昵称（超过 8 字）打的标记：字号由 JS 决定，这里只把亮度压一点，长名字不那么抢正文 */\n.bf-nick.bf-small {\n  opacity: 0.88;\n}\n/* 纯表情弹幕：**不动容器尺寸**（撑开会把表情图放大成巨图），只放开裁剪，\n   把昵称绝对定位到容器左侧外溢出去。 */\n.bili-danmaku-x-dm.bf-emoji-open,\n[class*=\"bili-danmaku-x-dm\"].bf-emoji-open {\n  overflow: visible !important;\n}\n/* 文字弹幕：昵称绝对定位在正文左侧（不占布局宽度，否则会吃掉 B站 给下一条留的 ~70px 间隔）。 */\n.bili-danmaku-x-dm.bf-nick-open,\n[class*=\"bili-danmaku-x-dm\"].bf-nick-open {\n  overflow: visible !important;\n}\n.bili-danmaku-x-dm.bf-emoji-open > .bf-nick,\n[class*=\"bili-danmaku-x-dm\"].bf-emoji-open > .bf-nick {\n  position: absolute !important;\n  right: 100% !important;\n  left: auto !important;\n  top: 50% !important;\n  transform: translateY(-50%) !important;\n  margin: 0 4px 0 0 !important;\n  display: block !important;\n  width: max-content !important;\n}\n.bili-danmaku-x-dm.bf-emoji-open > img,\n[class*=\"bili-danmaku-x-dm\"].bf-emoji-open > img {\n  max-width: 100% !important;\n  max-height: 100% !important;\n}\n.bili-danmaku-x-dm.bf-hit,\n[class*=\"bili-danmaku-x-dm\"].bf-hit {\n  pointer-events: auto !important;\n}\n\n/* ---------- 高光效果层（v2.6）----------\n   挂在弹幕元素内部、z-index:-1：画在正文后面、视频前面（弹幕元素自带 transform，自成层叠上下文）。\n   左边界 = 昵称实测宽（--bf-nw，JS 写）+ 4px 昵称间距 + 6px 内边距 → 框把「昵称 + 正文」一起包住。\n   绝对定位不占布局宽度，B站 的滚动速度不变。固定弹幕昵称翻到右侧时加 .bf-fx-r 跟着翻。 */\n.bf-fx {\n  position: absolute !important;\n  z-index: -1 !important;\n  top: -3px;\n  bottom: -3px;\n  left: calc(-1 * (var(--bf-nw, 0px) + 10px));\n  right: -5px;\n  border-radius: 6px;\n  box-sizing: border-box;\n  pointer-events: none !important;\n  display: block !important;\n  margin: 0 !important;\n  padding: 0 !important;\n}\n.bf-fx.bf-fx-r {\n  left: -5px;\n  right: calc(-1 * (var(--bf-nw, 0px) + 10px));\n}\n/* 底牌：档位色混深色压底，亮场/花哨画面上也立得住；左侧 3px 色条是「中途看过来」的常驻识别点。\n   原生「自己发的弹幕」是白色细框，底牌是实心色块，语义上撞不到一起。 */\n.bf-fx.bf-fx-card {\n  /* ★ 档位色只占 22%：正文本身也是档位色，底牌混得太浓会变成「蓝字压蓝底」（无头截图实测） */\n  background: color-mix(in srgb, var(--bf-c) 22%, rgba(0, 0, 0, 0.72));\n  box-shadow: inset 3px 0 0 var(--bf-c), 0 0 0 1px color-mix(in srgb, var(--bf-c) 55%, transparent);\n}\n/* 绕行光段：两段光沿圆角框转圈；底下垫一道深色粗描边，亮场上才看得见 */\n.bf-fx .bf-fx-orb {\n  position: absolute;\n  inset: 0;\n  width: 100%;\n  height: 100%;\n  overflow: visible;\n  display: block;\n}\n.bf-fx .bf-fx-orb rect {\n  width: calc(100% - 2px);\n  height: calc(100% - 2px);\n  fill: none;\n  stroke-dasharray: 18 32;\n  animation: bf-orb 1.6s linear infinite;\n}\n.bf-fx .bf-fx-orb .o1 {\n  stroke: rgba(0, 0, 0, 0.7);\n  stroke-width: 5;\n}\n.bf-fx .bf-fx-orb .o2 {\n  stroke: var(--bf-c);\n  stroke-width: 2.5;\n  stroke-linecap: round;\n}\n@keyframes bf-orb {\n  to {\n    stroke-dashoffset: -100;\n  }\n}\n/* 入场涟漪：出现那一刻向外扩两圈就收（注意力抓的是「突然出现」，持续动效会被习惯掉） */\n.bf-fx .bf-fx-rip {\n  position: absolute;\n  inset: 0;\n  border: 2px solid var(--bf-c);\n  border-radius: inherit;\n  box-sizing: border-box;\n  opacity: 0;\n  animation: bf-rip 0.7s cubic-bezier(0.2, 0.7, 0.3, 1) 2;\n}\n@keyframes bf-rip {\n  0% {\n    transform: scale(1);\n    opacity: 1;\n  }\n  100% {\n    transform: scale(1.22, 1.9);\n    opacity: 0;\n  }\n}\n@media (prefers-reduced-motion: reduce) {\n  .bf-fx .bf-fx-orb rect,\n  .bf-fx .bf-fx-rip {\n    animation: none;\n  }\n}\n\n/* 面板里的「多选」分段按钮（高光效果）：沿用 .bf-seg 外观，可同时点亮多个 */\n.bf-seg.bf-multi button[data-on=\"1\"] {\n  background: var(--bf-accent);\n  color: var(--bf-accent-ink);\n  font-weight: 600;\n}\n\n/* ---------- 悬停冻结层 ----------\n   悬停时把那条弹幕「钉」在这里。B站 的弹幕元素是池化复用的，它按自己的计时器\n   回收并复用元素；只有把我们自己的一份 fixed 浮层留住，卡片才不会被连带消失。\n   配色不跟页面主题走：它贴在视频画面上，用深色半透明底 + 浅色字，\n   看起来就是「这条弹幕自己停住了」，而不是压了一块白板。 */\n#bf-pin {\n  position: fixed;\n  z-index: 2147482998;\n  display: inline-flex;\n  align-items: center;\n  padding: 3px 8px;\n  margin: 0;\n  border-radius: 8px;\n  background: rgba(16, 11, 15, 0.78);\n  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.16);\n  pointer-events: none;\n  white-space: nowrap;\n  max-width: calc(100vw - 16px);\n  overflow: visible;\n  font-size: 12px;\n  line-height: 1.35;\n  animation: bf-pin-in 0.14s var(--bf-ease);\n}\n#bf-pin .bf-pin-nick,\n#bf-pin .bf-pin-text {\n  display: inline;\n  white-space: nowrap;\n  font-size: 12px;\n  line-height: 1.35;\n  vertical-align: baseline;\n  color: #fff;\n}\n#bf-pin .bf-pin-nick {\n  margin-right: 4px;\n  font-weight: 600;\n}\n#bf-pin .bf-pin-text {\n  font-weight: 400;\n}\n@keyframes bf-pin-in {\n  from { opacity: 0; transform: scale(0.96); }\n  to { opacity: 1; transform: scale(1); }\n}\n\n/* ---------- 悬浮球 ---------- */\n#bf-orb {\n  position: fixed;\n  z-index: 2147483000;\n  width: 40px;\n  height: 40px;\n  display: grid;\n  place-items: center;\n  border: 0;\n  border-radius: 12px;\n  padding: 0;\n  background: var(--bf-accent);\n  color: var(--bf-accent-ink);\n  box-shadow: 0 8px 20px rgba(251, 114, 153, 0.32);\n  cursor: pointer;\n  touch-action: none;\n  transition: box-shadow var(--bf-dur) var(--bf-ease), transform 0.12s var(--bf-ease);\n}\n#bf-orb svg {\n  width: 21px;\n  height: 21px;\n}\n#bf-orb:hover {\n  box-shadow: 0 8px 26px rgba(251, 114, 153, 0.48);\n}\n#bf-orb:active {\n  transform: scale(0.97);\n}\n\n/* ---------- 设置面板 ---------- */\n#bf-panel {\n  position: fixed;\n  z-index: 2147483001;\n  width: 320px;\n  max-width: calc(100vw - 12px);\n  max-height: 78vh;\n  display: flex;\n  flex-direction: column;\n  background: var(--bf-bg);\n  border: 1px solid var(--bf-border);\n  border-radius: var(--bf-radius);\n  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.52), 0 0 0 1px rgba(255, 200, 220, 0.04);\n  backdrop-filter: blur(16px) saturate(1.15);\n  overflow: hidden;\n  /* 关闭态：visibility + pointer-events 双保险。绝不靠 display 过渡收尾 ——\n     实测 allow-discrete 可能停在 display:flex/opacity:0，面板看不见却继续吞点击。 */\n  visibility: hidden;\n  pointer-events: none;\n  opacity: 0;\n  transform: translateY(-6px) scale(0.985);\n  transition:\n    opacity var(--bf-dur) var(--bf-ease),\n    transform var(--bf-dur) var(--bf-ease),\n    visibility var(--bf-dur) allow-discrete;\n}\n#bf-panel.bf-open {\n  visibility: visible;\n  pointer-events: auto;\n  opacity: 1;\n  transform: none;\n}\n#bf-panel,\n#bf-panel * {\n  box-sizing: border-box;\n}\n.bf-head {\n  height: 44px;\n  flex: 0 0 auto;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 0 8px 0 16px;\n  background: var(--bf-bg2);\n  border-bottom: 1px solid var(--bf-border);\n  cursor: move;\n}\n.bf-title {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 13px;\n  font-weight: 600;\n}\n.bf-dot {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--bf-accent);\n  box-shadow: 0 0 8px rgba(251, 114, 153, 0.55);\n}\n.bf-dot.bf-pink {\n  background: var(--bf-pink);\n  box-shadow: 0 0 8px rgba(251, 114, 153, 0.55);\n}\n.bf-hright {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n}\n.bf-ver {\n  font-size: 11px;\n  color: var(--bf-muted);\n  font-variant-numeric: tabular-nums;\n}\n.bf-x {\n  width: 28px;\n  height: 28px;\n  display: grid;\n  place-items: center;\n  border: 0;\n  border-radius: var(--bf-ctl);\n  background: transparent;\n  color: var(--bf-muted);\n  cursor: pointer;\n  font-size: 13px;\n}\n.bf-x:hover {\n  background: var(--bf-s3);\n  color: var(--bf-text);\n}\n.bf-body {\n  padding: 8px 16px 12px;\n  overflow: auto;\n  overscroll-behavior: contain;\n}\n.bf-sec {\n  padding: 12px 0;\n  border-bottom: 1px solid var(--bf-border);\n}\n.bf-sec:last-child {\n  border-bottom: 0;\n}\n.bf-row {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  min-height: 36px;\n  margin: 0;\n  font-size: 13px;\n  cursor: pointer;\n}\n.bf-lab {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n}\n.bf-sub {\n  font-size: 11px;\n  color: var(--bf-muted);\n  font-weight: 400;\n}\n.bf-right {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex: 0 0 auto;\n}\n.bf-in {\n  height: 32px;\n  width: 108px;\n  padding: 0 10px;\n  color: var(--bf-text);\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  outline: none;\n  font-size: 12px;\n  font-family: inherit;\n  transition: border-color 0.16s var(--bf-ease);\n}\n.bf-in:focus {\n  border-color: var(--bf-accent);\n}\n.bf-in.bf-num {\n  width: 96px;\n  font-variant-numeric: tabular-nums;\n}\n.bf-in.bf-mini {\n  width: 48px;\n  text-align: center;\n}\n/* ---------- 分段按钮（API 查询范围这类二选一） ----------\n   原来用原生 <select>：展开弹层由系统绘制，深色下选中项是系统浅蓝、浅色下白字白底，\n   option:checked / appearance:base-select 全压不住（实测）。自绘弹层又会透出下层控件。\n   只有两个选项本来就不该用下拉 —— 改用分段按钮，没有弹层就没有这些问题。 */\n/* 标签在上、分段按钮占满整行：两个选项并排放在 320px 面板里，跟标签同行必然被裁 */\n.bf-row-sel {\n  flex-direction: column;\n  align-items: stretch;\n  gap: 8px;\n  padding: 8px 0 4px;\n  cursor: default;\n}\n.bf-seg {\n  display: flex;\n  width: 100%;\n  height: 32px;\n  padding: 2px;\n  gap: 2px;\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n}\n.bf-seg button {\n  flex: 1 1 0;\n  min-width: 0;\n  height: 100%;\n  padding: 0 8px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  border: 0;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--bf-muted);\n  font-size: 12px;\n  font-family: inherit;\n  cursor: pointer;\n  white-space: nowrap;\n  transition: background 0.16s var(--bf-ease), color 0.16s var(--bf-ease);\n}\n.bf-seg button:hover {\n  color: var(--bf-text);\n  background: var(--bf-s3);\n}\n.bf-seg button[data-on=\"1\"] {\n  background: var(--bf-accent);\n  color: var(--bf-accent-ink);\n  font-weight: 600;\n}\n.bf-seg button[data-on=\"1\"]:hover {\n  background: var(--bf-accent);\n  color: var(--bf-accent-ink);\n}\n\n.bf-color {\n  width: 36px;\n  height: 28px;\n  padding: 2px;\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  cursor: pointer;\n}\n.bf-field {\n  padding: 8px 0 4px;\n}\n.bf-ta {\n  width: 100%;\n  min-height: 64px;\n  margin-top: 8px;\n  padding: 8px 10px;\n  resize: vertical;\n  color: var(--bf-text);\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  outline: none;\n  font-size: 12px;\n  line-height: 1.5;\n  font-family: inherit;\n  transition: border-color 0.16s var(--bf-ease);\n}\n.bf-ta:focus {\n  border-color: var(--bf-accent);\n}\n.bf-sw {\n  position: relative;\n  width: 36px;\n  height: 20px;\n  min-width: 36px;\n  cursor: pointer;\n}\n.bf-sw input {\n  position: absolute;\n  opacity: 0;\n  inset: 0;\n  margin: 0;\n  cursor: pointer;\n}\n.bf-track {\n  position: absolute;\n  inset: 0;\n  border-radius: var(--bf-ctl);\n  background: var(--bf-s3);\n  transition: background var(--bf-dur) var(--bf-ease);\n}\n.bf-track::before {\n  content: \"\";\n  position: absolute;\n  width: 16px;\n  height: 16px;\n  left: 2px;\n  top: 2px;\n  border-radius: 50%;\n  background: #fff;\n  transition: transform var(--bf-dur) var(--bf-ease);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);\n}\n.bf-sw input:checked + .bf-track {\n  background: var(--bf-accent);\n}\n.bf-sw input:checked + .bf-track::before {\n  transform: translateX(16px);\n}\n.bf-expand {\n  width: 100%;\n  height: 32px;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 0 4px;\n  border: 0;\n  background: transparent;\n  color: var(--bf-muted);\n  font-size: 12px;\n  cursor: pointer;\n  font-family: inherit;\n}\n.bf-expand:hover {\n  color: var(--bf-text);\n}\n.bf-more {\n  display: none;\n}\n.bf-more.bf-open {\n  display: block;\n}\n.bf-grp {\n  padding: 8px 0 4px;\n  border-top: 1px solid var(--bf-border);\n}\n.bf-gt {\n  font-size: 11px;\n  font-weight: 600;\n  color: var(--bf-accent);\n  margin: 0 0 8px;\n}\n.bf-actions {\n  display: flex;\n  gap: 8px;\n  flex-wrap: wrap;\n  margin-top: 8px;\n}\n.bf-btn {\n  height: 30px;\n  padding: 0 12px;\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  background: var(--bf-s2);\n  color: var(--bf-text);\n  font-size: 12px;\n  cursor: pointer;\n  font-family: inherit;\n  transition: border-color 0.16s var(--bf-ease), background 0.16s var(--bf-ease);\n}\n.bf-btn:hover {\n  border-color: var(--bf-accent);\n}\n.bf-btn.bf-danger:hover {\n  border-color: var(--bf-danger);\n  color: var(--bf-danger);\n}\n.bf-status {\n  flex: 0 0 auto;\n  position: relative;\n  padding: 8px 26px 8px 16px;\n  border-top: 1px solid var(--bf-border);\n  background: var(--bf-bg2);\n  color: var(--bf-muted);\n  font-size: 11px;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n  overflow: hidden;\n}\n.bf-stext {\n  display: block;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n/* 右下角缩放手柄：双层折角（外层大括号 + 内层小括号），一眼能认出是可拖拽缩放，\n   不用斜线（斜线在小尺寸下像渲染划痕，Master 2026-11-18 反馈过） */\n.bf-grip {\n  position: absolute;\n  right: 4px;\n  bottom: 4px;\n  width: 15px;\n  height: 15px;\n  cursor: nwse-resize;\n  touch-action: none;\n  color: var(--bf-muted);\n  opacity: 0.85;\n  transition: opacity 0.15s ease, color 0.15s ease;\n}\n.bf-grip::before,\n.bf-grip::after {\n  content: \"\";\n  position: absolute;\n  right: 0;\n  bottom: 0;\n  border-right: 1.5px solid currentColor;\n  border-bottom: 1.5px solid currentColor;\n  border-radius: 0 0 3px 0;\n}\n.bf-grip::before { width: 15px; height: 15px; }\n.bf-grip::after { width: 8px; height: 8px; }\n.bf-grip:hover { opacity: 1; color: var(--bf-accent); }\n\n/* ---------- 记录面板 ---------- */\n#bf-rec {\n  position: fixed;\n  z-index: 2147483001;\n  width: 460px;\n  max-width: calc(100vw - 12px);\n  max-height: 74vh;\n  display: flex;\n  flex-direction: column;\n  background: var(--bf-bg);\n  border: 1px solid var(--bf-border);\n  border-radius: var(--bf-radius);\n  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.52), 0 0 0 1px rgba(255, 200, 220, 0.04);\n  backdrop-filter: blur(16px) saturate(1.15);\n  overflow: hidden;\n  visibility: hidden;\n  pointer-events: none;\n  opacity: 0;\n  transform: translateY(-6px) scale(0.985);\n  transition:\n    opacity var(--bf-dur) var(--bf-ease),\n    transform var(--bf-dur) var(--bf-ease),\n    visibility var(--bf-dur) allow-discrete;\n}\n#bf-rec.bf-open {\n  visibility: visible;\n  pointer-events: auto;\n  opacity: 1;\n  transform: none;\n}\n#bf-rec,\n#bf-rec * {\n  box-sizing: border-box;\n}\n.bf-count {\n  font-size: 11px;\n  color: var(--bf-muted);\n  font-weight: 400;\n}\n.bf-count b {\n  color: var(--bf-text);\n  font-weight: 600;\n}\n.bf-rectool {\n  padding: 12px 14px;\n  border-bottom: 1px solid var(--bf-border);\n  flex: 0 0 auto;\n}\n.bf-filters {\n  display: flex;\n  gap: 8px;\n  margin-bottom: 12px;\n  flex-wrap: wrap;\n}\n.bf-rchip {\n  height: 28px;\n  padding: 0 10px;\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  border-radius: var(--bf-ctl);\n  border: 1px solid var(--bf-border2);\n  background: transparent;\n  color: var(--bf-muted);\n  font-size: 11px;\n  cursor: pointer;\n  user-select: none;\n  font-family: inherit;\n  transition: background 0.16s var(--bf-ease), border-color 0.16s var(--bf-ease), color 0.16s var(--bf-ease);\n}\n.bf-rchip[data-on=\"1\"] {\n  color: var(--bf-text);\n  background: var(--bf-s2);\n  border-color: var(--bf-border);\n}\n.bf-rdot {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n}\n.bf-rd-follow {\n  background: var(--bf-pink);\n}\n.bf-rd-fan {\n  background: var(--bf-fan);\n}\n.bf-rd-custom {\n  background: var(--bf-custom);\n}\n.bf-rd-kw {\n  background: var(--bf-danger);\n}\n.bf-sbar {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n.bf-sf {\n  position: relative;\n  flex: 1;\n  display: flex;\n  align-items: center;\n}\n.bf-sf input {\n  width: 100%;\n  height: 32px;\n  padding: 0 28px 0 10px;\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  color: var(--bf-text);\n  outline: none;\n  font-size: 12px;\n  font-family: inherit;\n  transition: border-color 0.16s var(--bf-ease);\n}\n.bf-sf input:focus {\n  border-color: var(--bf-accent);\n}\n.bf-sf.bf-invalid input {\n  border-color: var(--bf-danger);\n}\n.bf-clearq {\n  position: absolute;\n  right: 4px;\n  width: 20px;\n  height: 20px;\n  display: none;\n  place-items: center;\n  border: 0;\n  background: transparent;\n  color: var(--bf-muted);\n  cursor: pointer;\n  border-radius: 6px;\n  font-size: 11px;\n}\n.bf-sf.bf-has .bf-clearq {\n  display: grid;\n}\n.bf-rmode {\n  display: flex;\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  overflow: hidden;\n  height: 32px;\n}\n.bf-rmode button {\n  height: 100%;\n  padding: 0 10px;\n  border: 0;\n  background: transparent;\n  color: var(--bf-muted);\n  cursor: pointer;\n  font-size: 11px;\n  font-family: inherit;\n  transition: background 0.16s var(--bf-ease), color 0.16s var(--bf-ease);\n}\n.bf-rmode button[data-on=\"1\"] {\n  background: var(--bf-accent);\n  color: var(--bf-accent-ink);\n  font-weight: 600;\n}\n.bf-toolrow {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-top: 8px;\n  gap: 8px;\n}\n.bf-acts {\n  display: flex;\n  gap: 4px;\n}\n.bf-linkbtn {\n  height: 28px;\n  padding: 0 10px;\n  border: 0;\n  background: transparent;\n  color: var(--bf-muted);\n  cursor: pointer;\n  font-size: 11px;\n  border-radius: 6px;\n  font-family: inherit;\n  transition: background 0.16s var(--bf-ease), color 0.16s var(--bf-ease);\n}\n.bf-linkbtn:hover {\n  background: var(--bf-s3);\n  color: var(--bf-text);\n}\n.bf-reclist {\n  flex: 1 1 auto;\n  overflow: auto;\n  overscroll-behavior: contain;\n  padding: 4px 6px 8px;\n}\n.bf-ritem {\n  position: relative;\n  padding: 10px 8px;\n  border-bottom: 1px solid var(--bf-border);\n}\n.bf-ritem:last-child {\n  border-bottom: 0;\n}\n.bf-ritem:hover {\n  background: var(--bf-s2);\n}\n.bf-rmeta {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 11px;\n  color: var(--bf-muted);\n  margin-bottom: 4px;\n}\n.bf-rtime {\n  font-variant-numeric: tabular-nums;\n}\n.bf-rtag {\n  padding: 0 6px;\n  border-radius: 6px;\n  font-size: 11px;\n  font-weight: 500;\n  line-height: 16px;\n}\n.bf-rt-follow {\n  color: var(--bf-pink);\n  background: rgba(251, 114, 153, 0.16);\n}\n.bf-rt-fan {\n  color: var(--bf-fan);\n  background: rgba(255, 209, 102, 0.16);\n}\n.bf-rt-custom {\n  color: #8b93ff;\n  background: rgba(0, 17, 255, 0.22);\n}\n.bf-rt-kw {\n  color: var(--bf-danger);\n  background: rgba(255, 92, 92, 0.16);\n}\n.bf-croomlink {\n  color: var(--bf-accent);\n  text-decoration: none;\n}\n.bf-rline {\n  font-size: 13px;\n  line-height: 1.55;\n  padding-right: 48px;\n}\n.bf-rname {\n  color: var(--bf-fan);\n  font-weight: 600;\n  text-decoration: none;\n}\n#bf-rec[data-bftheme=\"light\"] .bf-rname {\n  color: #9a6306;\n}\n.bf-rroomtitle {\n  font-size: 11px;\n  color: var(--bf-muted);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.bf-ritem mark {\n  background: rgba(251, 114, 153, 0.28);\n  color: inherit;\n  border-radius: 3px;\n  padding: 0 1px;\n}\n.bf-rcopy,\n.bf-rdel {\n  position: absolute;\n  top: 8px;\n  width: 26px;\n  height: 24px;\n  display: none;\n  place-items: center;\n  border: 0;\n  border-radius: 6px;\n  background: var(--bf-s2);\n  color: var(--bf-muted);\n  cursor: pointer;\n  font-size: 11px;\n}\n.bf-rcopy {\n  right: 4px;\n}\n.bf-rdel {\n  right: 32px;\n}\n.bf-ritem:hover .bf-rcopy,\n.bf-ritem:hover .bf-rdel {\n  display: grid;\n}\n.bf-rdel:hover {\n  color: var(--bf-danger);\n}\n.bf-rchk {\n  position: absolute;\n  left: 8px;\n  top: 50%;\n  transform: translateY(-50%);\n  width: 18px;\n  height: 18px;\n  display: none;\n  align-items: center;\n  justify-content: center;\n  border: 1.5px solid var(--bf-border2);\n  border-radius: 4px;\n  background: transparent;\n  color: transparent;\n  cursor: pointer;\n  font-size: 11px;\n  padding: 0;\n}\n.bf-ritem.bf-rsel {\n  padding-left: 32px;\n}\n.bf-ritem.bf-rsel .bf-rchk {\n  display: flex;\n}\n.bf-rchk.bf-on {\n  background: var(--bf-accent);\n  border-color: var(--bf-accent);\n  color: var(--bf-accent-ink);\n}\n.bf-selbar {\n  display: none;\n  align-items: center;\n  gap: 8px;\n  padding: 6px 10px;\n  margin-top: 8px;\n  border-radius: var(--bf-ctl);\n  background: var(--bf-s2);\n}\n.bf-selbar.bf-show {\n  display: flex;\n}\n.bf-selbar .bf-count {\n  flex: 1;\n}\n.bf-empty {\n  padding: 40px 20px;\n  text-align: center;\n  color: var(--bf-muted);\n  font-size: 12px;\n  line-height: 1.8;\n}\n.bf-empty span {\n  font-size: 11px;\n}\n\n/* ---------- 身份卡 ---------- */\n#bf-card {\n  position: fixed;\n  z-index: 2147483002;\n  width: 280px;\n  display: block;\n  background: var(--bf-bg);\n  border: 1px solid var(--bf-border);\n  border-radius: var(--bf-radius);\n  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 200, 220, 0.05);\n  backdrop-filter: blur(16px) saturate(1.15);\n  overflow: hidden;\n  pointer-events: auto;\n  visibility: hidden;\n  opacity: 0;\n  transform: scale(0.97);\n  transition:\n    opacity 0.2s var(--bf-ease),\n    transform 0.2s var(--bf-ease),\n    visibility 0.2s allow-discrete;\n}\n#bf-card.bf-open {\n  visibility: visible;\n  opacity: 1;\n  transform: none;\n}\n.bf-cbody {\n  padding: 12px 14px 10px;\n  font-size: 12px;\n}\n.bf-chead {\n  display: flex;\n  gap: 10px;\n  align-items: center;\n}\n.bf-cface {\n  width: 44px;\n  height: 44px;\n  border-radius: 50%;\n  object-fit: cover;\n  flex: 0 0 auto;\n  background: var(--bf-s3);\n}\n.bf-cface-ph {\n  background: var(--bf-s3);\n}\n.bf-cwho {\n  min-width: 0;\n  flex: 1;\n}\n.bf-cname {\n  font-size: 13px;\n  font-weight: 600;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.bf-cuid {\n  font-size: 11px;\n  color: var(--bf-muted);\n  font-variant-numeric: tabular-nums;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n.bf-cverify {\n  color: var(--bf-fan);\n  border: 1px solid rgba(255, 209, 102, 0.4);\n  border-radius: 4px;\n  padding: 0 4px;\n  font-size: 11px;\n}\n.bf-cbadge {\n  font-size: 11px;\n  padding: 1px 6px;\n  border-radius: 6px;\n  flex: 0 0 auto;\n}\n.bf-cguard {\n  color: #ff9f43;\n  background: rgba(255, 159, 67, 0.16);\n}\n.bf-csign {\n  margin: 8px 0;\n  font-size: 11px;\n  color: var(--bf-muted);\n  line-height: 1.5;\n  max-height: 34px;\n  overflow: hidden;\n}\n.bf-cstats {\n  border-top: 1px solid var(--bf-border);\n  padding-top: 8px;\n}\n.bf-crow {\n  display: flex;\n  justify-content: space-between;\n  gap: 10px;\n  font-size: 12px;\n  line-height: 1.9;\n}\n.bf-clabel {\n  color: var(--bf-muted);\n}\n.bf-cval {\n  font-variant-numeric: tabular-nums;\n}\n.bf-cmuted {\n  color: var(--bf-muted);\n}\n.bf-cvip {\n  color: var(--bf-pink);\n  font-size: 11px;\n}\n.bf-cfoot {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  margin-top: 8px;\n  padding-top: 8px;\n  border-top: 1px solid var(--bf-border);\n}\n.bf-cmedal {\n  font-size: 11px;\n}\n.bf-clink {\n  font-size: 12px;\n  color: var(--bf-accent);\n  text-decoration: none;\n}\n.bf-clink:hover {\n  text-decoration: underline;\n}\n\n/* ---------- toast ---------- */\n#bf-toast {\n  position: fixed;\n  left: 50%;\n  bottom: 56px;\n  transform: translateX(-50%) translateY(8px);\n  opacity: 0;\n  z-index: 2147483003;\n  padding: 10px 16px;\n  border-radius: 12px;\n  background: var(--bf-bg2);\n  border: 1px solid var(--bf-border2);\n  color: var(--bf-text);\n  font-size: 12px;\n  pointer-events: none;\n  transition: opacity var(--bf-dur) var(--bf-ease), transform var(--bf-dur) var(--bf-ease);\n  backdrop-filter: blur(12px);\n}\n#bf-toast.bf-show {\n  opacity: 1;\n  transform: translateX(-50%) translateY(0);\n}\n#bf-toast[data-kind=\"enter\"] {\n  border-color: rgba(251, 114, 153, 0.5);\n}\n\n/* 拖拽期间不选字；标题栏本身也不该被选中。\n   ★ v2.5.4：这里原来是一条 `.bf-dragging, .bf-dragging *` 的通配规则，\n     拖动开始/结束各挂一次类。真机实测（B站 直播页 5900+ 节点）：\n       · 挂/摘这一次类 → 强制样式重算 90.9ms（拆掉规则后只要 5.9ms）\n       · 用户感受就是「按下顿一下、松开又顿一下」\n     根因：`*` 展开到每个后代，user-select 又是继承属性，整棵树都要更新 computed style。\n     改法：不再给 <html> 挂通配类。拖动时只写两处 inline（面板自身 user-select、\n     手柄自身 cursor，共 ~1ms），手柄有 pointer capture，光标一定跟手。 */\n.bf-head {\n  user-select: none;\n  -webkit-user-select: none;\n}\n\n/* 滚动条：系统默认的浅色条在玻璃面板上同样割裂 */\n/* ---------- 滚动条 ----------\n   Chromium 156 实测：只要样式里出现 ::-webkit-scrollbar，就退回「传统滚动条」渲染，\n   Windows 会画出上下 ▲▼ 按钮；而 ::-webkit-scrollbar-button{display:none} 在这个版本\n   上不生效（A/B 强制染绿都没出现绿色像素）。标准属性 scrollbar-width/color 走的是现代细条，\n   但没法给 thumb 精确上色/加圆角。\n   结论：**原生滚动条整体隐藏，自己画一根指示条**（.bf-sbthumb），彻底不依赖 OS 渲染。 */\n#bf-panel .bf-body,\n#bf-rec .bf-reclist {\n  scrollbar-width: none;\n  -ms-overflow-style: none;\n}\n#bf-panel .bf-body::-webkit-scrollbar,\n#bf-rec .bf-reclist::-webkit-scrollbar {\n  width: 0;\n  height: 0;\n  display: none;\n}\n.bf-sbthumb {\n  position: absolute;\n  right: 4px;\n  width: 6px;\n  border-radius: 999px;\n  background: rgba(251, 114, 153, 0.55);\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.18s var(--bf-ease);\n  will-change: transform, height;\n}\n.bf-sbthumb.bf-sbthumb-on {\n  opacity: 1;\n}\n.bf-sbthumb.bf-sbthumb-fade {\n  opacity: 0.35;\n}\n#bf-panel[data-bftheme=\"light\"] .bf-sbthumb,\n#bf-rec[data-bftheme=\"light\"] .bf-sbthumb {\n  background: rgba(226, 89, 127, 0.5);\n}\n/* 文本框自己的滚动条也藏掉（内容少时几乎不出现） */\n.bf-ta {\n  scrollbar-width: thin;\n  scrollbar-color: rgba(251, 114, 153, 0.45) transparent;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  #bf-panel,\n  #bf-rec,\n  #bf-card,\n  #bf-toast,\n  #bf-orb,\n  .bf-track,\n  .bf-track::before,\n  .bf-in,\n  .bf-ta,\n  .bf-btn,\n  .bf-rchip,\n  .bf-rmode button,\n  .bf-linkbtn {\n    transition: none !important;\n  }\n}\n\n/* ---------- 自绘下拉 ----------\n   原生 <select> 的展开弹层由浏览器/系统绘制：深色主题下选中项是系统浅蓝、浅色主题下是白底，\n   option:checked 的 background 会被 UA 高亮盖掉（appearance:base-select 也压不住，实测）。\n   所以这一项改成 button + 挂在 body 上的 listbox，颜色全部走主题 token。 */\n.bf-row-sel {\n  align-items: flex-start;\n  padding: 4px 0;\n}\n.bf-dd {\n  position: relative;\n  flex: 0 0 auto;\n  display: inline-block;\n}\n.bf-dd-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n  min-width: 136px;\n  height: 32px;\n  padding: 0 10px;\n  background: var(--bf-s2);\n  border: 1px solid var(--bf-border2);\n  border-radius: var(--bf-ctl);\n  color: var(--bf-text);\n  font-size: 12px;\n  font-family: inherit;\n  cursor: pointer;\n  transition: border-color 0.16s var(--bf-ease), background 0.16s var(--bf-ease);\n}\n.bf-dd-btn:hover {\n  background: var(--bf-s3);\n}\n.bf-dd.bf-open .bf-dd-btn,\n.bf-dd-btn:focus-visible {\n  border-color: var(--bf-accent);\n  outline: none;\n}\n.bf-dd-val {\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.bf-dd-caret {\n  flex: 0 0 auto;\n  color: var(--bf-muted);\n  transition: transform 0.18s var(--bf-ease);\n}\n.bf-dd.bf-open .bf-dd-caret {\n  transform: rotate(180deg);\n}\n/* 菜单挂在 body 上（面板 overflow:hidden 会把它裁掉），所以这里必须自带全部颜色 */\n.bf-dd-menu {\n  position: fixed;\n  z-index: 2147483004;\n  padding: 4px;\n  background: #241a21;\n  border: 1px solid rgba(255, 200, 220, 0.22);\n  border-radius: 10px;\n  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55);\n  backdrop-filter: blur(16px) saturate(1.15);\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  animation: bf-dd-in 0.16s cubic-bezier(0.22, 0.8, 0.3, 1);\n}\n@keyframes bf-dd-in {\n  from {\n    opacity: 0;\n    transform: translateY(-4px);\n  }\n}\n.bf-dd-menu .bf-dd-opt {\n  display: block;\n  width: 100%;\n  padding: 8px 10px;\n  border: 0;\n  border-radius: 6px;\n  background: transparent;\n  color: #f3ecef;\n  font-size: 12px;\n  font-family: inherit;\n  text-align: left;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.bf-dd-menu .bf-dd-opt:hover {\n  background: rgba(255, 235, 243, 0.12);\n}\n.bf-dd-menu .bf-dd-opt.bf-on {\n  background: #fb7299;\n  color: #2b0d18;\n  font-weight: 600;\n}\nbody.bf-theme-light .bf-dd-menu {\n  background: #ffffff;\n  border-color: rgba(70, 20, 40, 0.18);\n  box-shadow: 0 16px 36px rgba(70, 20, 40, 0.18);\n}\nbody.bf-theme-light .bf-dd-menu .bf-dd-opt {\n  color: #2a1a21;\n}\nbody.bf-theme-light .bf-dd-menu .bf-dd-opt:hover {\n  background: rgba(70, 20, 40, 0.07);\n}\nbody.bf-theme-light .bf-dd-menu .bf-dd-opt.bf-on {\n  background: #e2597f;\n  color: #ffffff;\n}\n@media (prefers-reduced-motion: reduce) {\n  .bf-dd-menu {\n    animation: none;\n  }\n  .bf-dd-caret {\n    transition: none;\n  }\n}\n";

// ===== 55-panel.js =====
// ===== 面板：悬浮球 + 精简设置面板 + 记录面板 =====

const ORB_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4V7a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 11h8M8 8.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

let statusTimer = 0;
let watchResolveTimer = 0;

function showToast(msg, kind) {
  let el = document.getElementById("bf-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "bf-toast";
    document.body.appendChild(el);
  }
  el.setAttribute("data-kind", kind || "info");
  el.textContent = msg;
  el.classList.add("bf-show");
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => el.classList.remove("bf-show"), 2200);
}

function injectStyle() {
  try {
    GM_addStyle(UI_CSS);
  } catch (_) {
    const st = document.createElement("style");
    st.textContent = UI_CSS;
    document.head.appendChild(st);
  }
}

function applyTheme() {
  const t = state.settings.theme === "light" ? "light" : "dark";
  for (const id of ["bf-panel", "bf-rec", "bf-card"]) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("data-bftheme", t);
  }
  const orb = document.getElementById("bf-orb");
  if (orb) orb.setAttribute("data-bftheme", t);
}

function openPanel(force) {
  const panel = document.getElementById("bf-panel");
  if (!panel) return;
  const open = typeof force === "boolean" ? force : !panel.classList.contains("bf-open");
  panel.classList.toggle("bf-open", open);
  state.settings.panelOpen = open;
  saveSettings();
  if (open) {
    syncPanelValues();
    ensureInViewport(panel);   // ★ v2.5.0：不再 clampPanel() 重算位置，避免把用户拖的位置拽回去
    applyTheme();
    renderStatus();
    const body = panel.querySelector(".bf-body");
    if (body && body.__bfSbar) setTimeout(() => body.__bfSbar.refresh(), 240);
    clearInterval(statusTimer);
    statusTimer = setInterval(renderStatus, 1000);
  } else {
    clearInterval(statusTimer);
  }
}

function toggleRecords(force) {
  const rec = document.getElementById("bf-rec");
  if (!rec) return;
  const open = typeof force === "boolean" ? force : !rec.classList.contains("bf-open");
  rec.classList.toggle("bf-open", open);
  state.recordOpen = open;
  if (open) {
    renderRecords();
    clampOne(rec, "recX", "recY");
    applyTheme();
    const list = rec.querySelector(".bf-reclist");
    if (list && list.__bfSbar) setTimeout(() => list.__bfSbar.refresh(), 240);
  }
}

// ===== 面板尺寸：手柄拖动 + 记忆（Master 2026-11-18 报「无大小记忆」）=====
function sizeBounds() {
  return {
    w: { min: 280, max: Math.max(280, Math.min(560, window.innerWidth - 16)) },
    h: { min: 220, max: Math.max(220, window.innerHeight - 16) }
  };
}
function applyStoredSize(el, kw, kh) {
  const b = sizeBounds();
  const w = Number((state.settings && state.settings[kw]) || 0);
  const h = Number((state.settings && state.settings[kh]) || 0);
  if (w > 0) el.style.width = clamp(w, b.w.min, b.w.max) + "px";
  if (h > 0) {
    el.style.height = clamp(h, b.h.min, b.h.max) + "px";
    el.style.maxHeight = b.h.max + "px";
  }
}
function makeResizable(el, kw, kh) {
  const grip = document.getElementById("bf-grip");
  if (!grip || !el) return;
  let st = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    st = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight, id: e.pointerId };
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    setDragVisual(true, grip, el);
  });
  grip.addEventListener("pointermove", (e) => {
    if (!st) return;
    const b = sizeBounds();
    el.style.width = clamp(st.w + (e.clientX - st.x), b.w.min, b.w.max) + "px";
    el.style.height = clamp(st.h + (e.clientY - st.y), b.h.min, b.h.max) + "px";
    el.style.maxHeight = b.h.max + "px";
  });
  grip.addEventListener("pointerup", () => {
    if (!st) return;
    st = null;
    setDragVisual(false, grip, el);
    state.settings[kw] = el.offsetWidth;
    state.settings[kh] = el.offsetHeight;
    saveSettings();
    clampOne(el, "panelX", "panelY");
  });
  grip.addEventListener("pointercancel", () => {
    st = null;
    setDragVisual(false, grip, el);
  });
}

function clampOne(el, kx, ky) {
  const w = el.offsetWidth || 460;
  const h = el.offsetHeight || 420;
  const x = clamp(Number(state.settings[kx] || 120), 8, Math.max(8, window.innerWidth - w - 8));
  const y = clamp(Number(state.settings[ky] || 100), 8, Math.max(8, window.innerHeight - h - 8));
  el.style.left = x + "px";
  el.style.top = y + "px";
  // ★ v2.5.0：绝不写回 state.settings。原来这里把 clamp 后的值写回存储，
  //   用户把面板拖到屏幕下方后，下次打开就被「夹回上沿」并悄悄改写掉他拖的位置 ——
  //   真机四步实测：拖到 (660,254)、存储却是 (460,421)，再打开变成 (460,246)。
  //   clamp 只负责「首次/重载时把存储值套到视口内」，不该成为位置的第二来源。
}

/** 打开面板时只保证「不越出视口」，不重算位置、不碰存储。
 *  原来 openPanel 每次都调 clampPanel()（会用存储值重算 + 写回），
 *  正是 Master 报的「每次点开都在同一个位置」的根因。 */
function ensureInViewport(el) {
  if (!el) return;
  const w = el.offsetWidth || 320;
  const h = el.offsetHeight || 420;
  const x = clamp(parseFloat(el.style.left) || 0, 8, Math.max(8, window.innerWidth - w - 8));
  const y = clamp(parseFloat(el.style.top) || 0, 8, Math.max(8, window.innerHeight - h - 8));
  el.style.left = x + "px";
  el.style.top = y + "px";
}

function clampPanel() {
  const panel = document.getElementById("bf-panel");
  if (panel) { applyStoredSize(panel, "panelW", "panelH"); clampOne(panel, "panelX", "panelY"); }
  const orb = document.getElementById("bf-orb");
  if (orb) {
    const size = 40;
    const x = clamp(Number(state.settings.toggleX || 24), 4, Math.max(4, window.innerWidth - size - 4));
    const y = clamp(Number(state.settings.toggleY || 96), 4, Math.max(4, window.innerHeight - size - 4));
    orb.style.left = x + "px";
    orb.style.top = y + "px";
    state.settings.toggleX = x;
    state.settings.toggleY = y;
  }
}

// ★ 2026-11-19 v2.5.0 修「拖动悬浮球/面板卡顿」（真机实测：拖动窗口 rAF p95 50ms、
//   2 帧 >50ms，576ms 内 GM_setValue 同步写盘 5 次；位置其实跟手 lagSpread=0）。
//   两条根因一起修：
//   ① 尺寸/视口只在 pointerdown 读一次，pointermove 里只写 left/top、绝不读布局量 ——
//      原来每个事件都读 offsetWidth/offsetHeight，在直播页大 DOM 上每次都触发强制同步重排。
//      实测 rAF 合并写入反而让位置滞后 6px（正是「延迟」感），所以保持立即写入。
//   ② 拖动途中落盘改成 setTimeout(0) 异步 + 800ms 节流，别让同步 JSON.stringify+GM_setValue
//      卡住当前这一帧；pointerup 仍同步落一次，防丢事件（skill 铁律 68）。
const DRAG_IGNORE = "button, a, input, select, textarea, label, option";

/** 把「元素此刻真实显示的 style.left/top」收敛成存储值。
 *  拖动时 state.settings 会被别的路径覆盖，只有 DOM 上的 style 是唯一可信来源。 */
function syncDragSettings(el, kx, ky) {
  const x = parseFloat(el.style.left);
  const y = parseFloat(el.style.top);
  if (isFinite(x)) state.settings[kx] = x;
  if (isFinite(y)) state.settings[ky] = y;
}

/** 拖动期间压住选字与光标。
 *  ★ v2.5.4：原来靠给 <html> 挂 `.bf-dragging` + 通配规则，实测「挂一次类 = 90.9ms 样式重算」
 *  （5900 节点全树重算），按下和松开各卡一下。改成只写两个 inline：
 *    · 目标元素自身 user-select:none —— 拖动时鼠标扫过的就是它自己，够用
 *    · 手柄自身 cursor:grabbing —— 有 pointer capture，光标一直停在手柄上
 *  实测代价 ~1ms。不动 <html>，也不碰任何后代。 */
function setDragVisual(on, handle, target) {
  try {
    if (on) {
      if (target) target.style.setProperty("user-select", "none");
      if (handle) handle.style.setProperty("cursor", "grabbing");
    } else {
      if (target) target.style.removeProperty("user-select");
      if (handle) handle.style.removeProperty("cursor");
    }
  } catch (_) {}
}

function makeDraggable(handle, target, kx, ky, onClick) {
  let drag = null;
  let captured = false;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // ★ 只拦「手柄内部的控件」。手柄自己就是按钮（悬浮球）时 closest 会命中它自己 ——
    //   v2.4.0 正是被这条挡死的：拖拽和点击一起失效（Master 2026-11-18 报「悬浮按钮点击无效果」）。
    const hit = e.target && e.target.closest ? e.target.closest(DRAG_IGNORE) : null;
    if (hit && hit !== handle) return;
    // 手柄本身是按钮（悬浮球）时不拦默认：没有要选的字，拦了反而影响 click/focus
    const handleIsButton = handle.tagName === "BUTTON";
    // ★ 拖拽会顺手选中标题栏/面板里的文字（Master 2026-11-18 报）。pointerdown 就 preventDefault，
    //   压根不进入「选字」状态（v2.5.4 起不再依赖 <html> 上的通配类）。
    if (!handleIsButton) e.preventDefault();
    // 尺寸与视口只在按下这一刻取一次，之后整段拖动不再触碰布局
    // 起点用元素当前的 style.left/top（绝对定位值），不用 offsetLeft ——
    // 后者是相对 offsetParent 的偏移，在 fixed + 变换祖先下可能与存储值不一致，
    // 实测拖完「style 与存储值对不上」正是从这里带出来的。
    const startLeft = parseFloat(target.style.left);
    const startTop = parseFloat(target.style.top);
    drag = {
      x: e.clientX, y: e.clientY,
      left: isFinite(startLeft) ? startLeft : target.offsetLeft,
      top: isFinite(startTop) ? startTop : target.offsetTop,
      w: target.offsetWidth, h: target.offsetHeight,
      vw: window.innerWidth, vh: window.innerHeight,
      lastLeft: isFinite(startLeft) ? startLeft : target.offsetLeft,
      lastTop: isFinite(startTop) ? startTop : target.offsetTop,
      moved: false, id: e.pointerId, savedAt: 0,
    };
    captured = false;
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      drag.moved = true;
      setDragVisual(true, handle, target);
      try { handle.setPointerCapture(drag.id); captured = true; } catch (_) {}
    }
    if (!drag.moved) return;
    // 与 clampOne / ensureInViewport 同一套边距，避免「拖到 254、一打开又被夹回 246」
    const left = clamp(drag.left + dx, 8, Math.max(8, drag.vw - drag.w - 8));
    const top = clamp(drag.top + dy, 8, Math.max(8, drag.vh - drag.h - 8));
    // 立即写入：每个 pointermove 只改两个定位属性，不读任何布局量（不强制重排）
    target.style.left = left + "px";
    target.style.top = top + "px";
    drag.lastLeft = left;
    drag.lastTop = top;
    if (Date.now() - drag.savedAt > 800) {
      drag.savedAt = Date.now();
      try { setTimeout(() => { syncDragSettings(target, kx, ky); saveSettings(); }, 0); } catch (_) {}
    }
  });
  const endDrag = (e, cancelled) => {
    if (!drag) return;
    setDragVisual(false, handle, target);
    if (captured) {
      try { handle.releasePointerCapture(drag.id); } catch (_) {}
      captured = false;
    }
    if (drag.moved) {
      // ★ 存储只认「元素此刻真实显示的 style」这一个来源。
      //   实测拖动中 state.settings 会被别的路径覆盖（style=920 但 storage=460），
      //   导致关→开→重载全跑偏；收敛后 style 与 storage 必然一致。
      syncDragSettings(target, kx, ky);
      saveSettings();
    } else if (!cancelled && onClick) {
      onClick(e);
    }
    drag = null;
  };
  handle.addEventListener("pointerup", (e) => endDrag(e, false));
  handle.addEventListener("pointercancel", () => endDrag(null, true));
  // 极少数情况下 pointerup 会丢（窗口失焦等）：兜底恢复光标/选字
  window.addEventListener("blur", () => setDragVisual(false, handle, target));
}

// ---------- 行组件 ----------
function rowSwitch(label, sub, key) {
  return (
    '<label class="bf-row"><span class="bf-lab">' + label + (sub ? '<span class="bf-sub">' + sub + "</span>" : "") + "</span>" +
    '<span class="bf-sw"><input type="checkbox" data-key="' + key + '"><span class="bf-track"></span></span></label>'
  );
}

function rowNumber(label, key, min, max, step) {
  return (
    '<label class="bf-row"><span class="bf-lab">' + label + "</span>" +
    '<input class="bf-in bf-num" type="number" data-key="' + key + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '"></label>'
  );
}

function rowColor(label, key, extra) {
  return (
    '<label class="bf-row"><span class="bf-lab">' + label + "</span>" +
    '<span class="bf-right">' + (extra || "") + '<input class="bf-color" type="color" data-key="' + key + '"></span></label>'
  );
}

function rowText(label, key, placeholder) {
  return (
    '<label class="bf-row"><span class="bf-lab">' + label + "</span>" +
    '<input class="bf-in" type="text" data-key="' + key + '" placeholder="' + escapeHtml(placeholder || "") + '"></label>'
  );
}

// ★ 2026-11-18：这个选项原来用原生 <select>，但它的展开弹层由浏览器/系统绘制 ——
//   深色主题下选中项是系统浅蓝、浅色主题下白底灰字看不清，option:checked 的 background
//   会被 UA 高亮盖掉（连 appearance:base-select 也压不住，实测）。自绘弹层又会透出下层开关。
//   只有两个选项，本来就不该用下拉：改成跟记录面板「关键词/完全/正则」同款分段按钮，
//   没有弹层、没有层级、没有滚动条问题。
function rowSeg(label, sub, key, options) {
  return (
    '<div class="bf-row bf-row-sel"><span class="bf-lab">' + label + (sub ? '<span class="bf-sub">' + sub + "</span>" : "") + "</span>" +
    '<span class="bf-seg" data-key="' + key + '">' +
    options
      .map((o, idx) => '<button type="button" data-v="' + escapeHtml(o[0]) + '"' + (idx === 0 ? ' data-on="1"' : "") + ">" + escapeHtml(o[1]) + "</button>")
      .join("") +
    "</span></div>"
  );
}

function rowArea(label, key, placeholder, rows) {
  return (
    '<div class="bf-field"><div class="bf-lab">' + label + "</div>" +
    '<textarea class="bf-ta" data-key="' + key + '" rows="' + (rows || 3) + '" placeholder="' + escapeHtml(placeholder || "") + '"></textarea></div>'
  );
}

// 高光效果多选：底牌 / 绕圈 / 涟漪，可以全选也可以全不选（全不选 = 只换色）
const FX_OPTIONS = [["card", "底牌"], ["orbit", "绕圈光段"], ["ripple", "入场涟漪"]];
function rowFx(label, sub, key) {
  return (
    '<div class="bf-row bf-row-sel"><span class="bf-lab">' + label + (sub ? '<span class="bf-sub">' + sub + "</span>" : "") + "</span>" +
    '<span class="bf-seg bf-multi" data-key="' + key + '">' +
    FX_OPTIONS.map((o) => '<button type="button" data-v="' + o[0] + '">' + o[1] + "</button>").join("") +
    "</span></div>"
  );
}

function rowAction(label, action, cls) {
  return '<button class="bf-btn ' + (cls || "") + '" data-action="' + action + '">' + label + "</button>";
}

const BADGE_SETTINGS = [
  ["customFollowBadge", "customFollowColor", "customFollowGlow", "自定义"],
  ["followBadge", "followColor", "followGlow", "已关注"],
  ["fanBadge", "fanColor", "fanGlow", "粉丝数"],
];

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = "bf-panel";
  panel.setAttribute("data-bftheme", "dark");
  panel.innerHTML =
    '<div class="bf-head" id="bf-drag">' +
      '<span class="bf-title"><i class="bf-dot"></i>弹幕昵称标注</span>' +
      '<span class="bf-hright"><span class="bf-ver">v' + VERSION + '</span>' +
      '<button class="bf-x" id="bf-panel-close" title="收起">✕</button></span>' +
    "</div>" +
    '<div class="bf-body">' +
      '<div class="bf-sec">' +
        rowSwitch("总开关", "关掉后不连弹幕、不标注", "enabled") +
        rowSwitch("显示昵称", "在弹幕前插入「昵称+分隔符」", "showNick") +
        rowSwitch("粉丝数标注", "超过阈值标 ⭐", "fanMark") +
        rowNumber("粉丝数阈值", "fanThreshold", 0, 100000000, 1000) +
        rowSwitch("已关注标注", "你关注的人标 ❤", "followMark") +
        rowSwitch("自定义名单", "名单里的人标 ◆（按昵称或 UID）", "customFollowMark") +
        rowArea("名单内容", "customFollowNames", "一行一个昵称或 UID，逗号/空格分隔也可以", 3) +
      "</div>" +
      '<div class="bf-sec">' +
        '<button class="bf-expand" id="bf-more">展开更多 <span class="bf-arrow">▾</span></button>' +
        '<div class="bf-more" id="bf-morebox">' +
          '<div class="bf-grp"><div class="bf-gt">标注细节</div>' +
            rowText("分隔符", "nickSeparator", ":") +
            rowNumber("昵称小字阈值", "nickSmallChars", 1, 40, 1) +
            rowNumber("小字字号 px", "nickSmallSize", 8, 20, 1) +
            rowSwitch("粉丝牌等级", "显示 Lv.N 牌名", "medalMark") +
            rowNumber("粉丝牌最小等级", "medalMinLevel", 0, 60, 1) +
            rowSwitch("B站等级", "Lv6 很普遍，默认关", "levelMark") +
            rowNumber("等级阈值", "levelMinLevel", 0, 6, 1) +
            rowSwitch("舰长/提督/总督", "", "guardMark") +
            rowSwitch("房管", "", "adminMark") +
            rowSwitch("表情弹幕昵称", "纯表情与图文混排都标", "emojiNick") +
            rowSwitch("熟面孔排名", "本场发言前 N 名标 #N", "topTalkerMark") +
            rowNumber("熟面孔取前 N", "topTalkerCount", 1, 50, 1) +
          "</div>" +
          '<div class="bf-grp"><div class="bf-gt">徽章与颜色</div>' +
            BADGE_SETTINGS.map(([bk, ck, gk, label]) => rowColor(label + "徽章", ck, '<input class="bf-in bf-mini" type="text" data-key="' + bk + '" maxlength="4">')).join("") +
            rowSwitch("自定义发光", "", "customFollowGlow") +
            rowSwitch("关注发光", "", "followGlow") +
            rowSwitch("粉丝发光", "", "fanGlow") +
          "</div>" +
          '<div class="bf-grp"><div class="bf-gt">高光效果（可多选，全不选 = 只换色）</div>' +
            rowFx("自定义 / 指定人", "最显眼的一档", "customFollowFx") +
            rowFx("已关注", "", "followFx") +
            rowFx("粉丝数", "", "fanFx") +
            rowFx("关键词", "命中面广，加框易满屏", "keywordFx") +
          "</div>" +
          '<div class="bf-grp"><div class="bf-gt">提醒</div>' +
            rowArea("关键词高亮", "keywordRules", "一行一个关键词，可用 关键词:#ff0000 指定颜色；# 开头是注释", 3) +
            rowColor("关键词颜色", "keywordColor") +
            rowSwitch("关键词发光", "", "keywordGlow") +
            rowArea("指定人", "watchNames", "一行一个昵称，保存后自动解析 UID", 3) +
            rowSwitch("指定人进场提示", "走 INTERACT_WORD，零成本", "watchEnter") +
          "</div>" +
          '<div class="bf-grp"><div class="bf-gt">查询与记录</div>' +
            rowSeg("API 查询范围", "worthy = 只查舰长/房管/高牌/名单", "apiMode", [["all", "都查"], ["worthy", "只查值得的人"]]) +
            rowSwitch("高亮记录", "命中标注的弹幕收进记录", "recordEnabled") +
            rowSwitch("记录持久化", "关掉后刷新即丢", "recordPersist") +
            '<div class="bf-actions">' + rowAction("打开记录面板", "records") + rowAction("诊断导出", "diag") + "</div>" +
            '<div class="bf-actions">' + rowAction("清空用户缓存", "clearcache", "bf-danger") + rowAction("清空匹配队列", "clearqueue") + "</div>" +
          "</div>" +
          '<div class="bf-grp"><div class="bf-gt">外观</div>' +
            '<div class="bf-actions">' + rowAction("切换深浅主题", "theme") + "</div>" +
          "</div>" +
        "</div>" +
      "</div>" +
    "</div>" +
    '<div class="bf-status" id="bf-status"><span class="bf-stext">就绪</span>' +
    '<span class="bf-grip" id="bf-grip" title="拖动调整面板大小"></span></div>';

  const orb = document.createElement("button");
  orb.id = "bf-orb";
  orb.title = "弹幕昵称标注";
  orb.innerHTML = ORB_SVG;
  orb.setAttribute("data-bftheme", "dark");
  document.body.appendChild(orb);

  const rec = document.createElement("div");
  rec.id = "bf-rec";
  rec.setAttribute("data-bftheme", "dark");
  rec.innerHTML =
    '<div class="bf-head" id="bf-rec-drag">' +
      '<span class="bf-title"><i class="bf-dot bf-pink"></i>高亮记录 <span class="bf-count">共 <b id="bf-rec-n">0</b> 条</span></span>' +
      '<span class="bf-hright"><button class="bf-x" id="bf-rec-close" title="收起">✕</button></span>' +
    "</div>" +
    '<div class="bf-rectool">' +
      '<div class="bf-filters">' +
        REC_TAGS.map((t) => '<button class="bf-rchip" data-k="' + t + '" data-on="1"><i class="bf-rdot bf-rd-' + (t === "关注" ? "follow" : t === "粉丝" ? "fan" : t === "自定义" ? "custom" : "kw") + '"></i>' + t + "</button>").join("") +
      "</div>" +
      '<div class="bf-sbar">' +
        '<span class="bf-sf" id="bf-rec-sf"><input id="bf-rec-q" type="text" placeholder="搜索昵称或内容"><button class="bf-clearq" id="bf-rec-clearq">✕</button></span>' +
        '<span class="bf-rmode"><button data-m="kw" data-on="1">关键词</button><button data-m="exact">完全</button><button data-m="regex">正则</button></span>' +
      "</div>" +
      '<div class="bf-toolrow">' +
        '<span class="bf-count" id="bf-rec-filtered"></span>' +
        '<span class="bf-acts">' +
          '<button class="bf-linkbtn" id="bf-rec-sel">多选</button>' +
          '<button class="bf-linkbtn" id="bf-rec-export">导出</button>' +
        "</span>" +
      "</div>" +
      '<div class="bf-selbar" id="bf-rec-selbar"><span class="bf-count" id="bf-rec-selcount">已选 0 条</span><button class="bf-btn bf-danger" id="bf-rec-delsel">删除所选</button></div>' +
    "</div>" +
    '<div class="bf-reclist" id="bf-rec-list"></div>';

  const toast = document.createElement("div");
  toast.id = "bf-toast";

  document.body.appendChild(panel);
  document.body.appendChild(rec);
  document.body.appendChild(toast);

  document.getElementById("bf-panel-close").addEventListener("click", () => openPanel(false));
  const orbBtn = document.getElementById("bf-orb");
  makeDraggable(orbBtn, orbBtn, "toggleX", "toggleY", () => openPanel());
  makeDraggable(document.getElementById("bf-drag"), panel, "panelX", "panelY");
  makeResizable(panel, "panelW", "panelH");
  makeDraggable(document.getElementById("bf-rec-drag"), rec, "recX", "recY");

  document.getElementById("bf-more").addEventListener("click", () => {
    const box = document.getElementById("bf-morebox");
    const on = box.classList.toggle("bf-open");
    document.querySelector("#bf-more .bf-arrow").textContent = on ? "▴" : "▾";
    state.settings.moreOpen = on;
    saveSettings();
  });

  bindPanelInputs(panel);
  bindRecordsPanel();
  // 自绘滚动条：原生滚动条已被 CSS 隐藏（Chromium 156 会给它画 ▲▼ 按钮，压不住）
  attachScrollbar(panel.querySelector(".bf-body"), panel);
  const recList = rec.querySelector(".bf-reclist");
  if (recList) attachScrollbar(recList, rec);
  applyTheme();
  clampPanel();
  if (state.settings.panelOpen) openPanel(true);
}

// ---------- 自绘滚动条 ----------
// 根因：Chromium 156 只要见到 ::-webkit-scrollbar 就退回传统滚动条渲染，
// Windows 会画出上下 ▲▼ 按钮，而 ::-webkit-scrollbar-button{display:none} 在这个版本不生效
// （实测：把它染绿都不出现绿色像素，箭头照样在）。
// 做法：原生滚动条整体隐藏（scrollbar-width:none），自己画一根 6px 指示条。
function attachScrollbar(scroller, host) {
  if (!scroller || !host) return null;
  if (scroller.__bfSbar) return scroller.__bfSbar;
  const bar = document.createElement("div");
  bar.className = "bf-sbthumb";
  host.appendChild(bar);
  let hideTimer = 0;
  let rafId = 0;

  const render = () => {
    const sh = scroller.scrollHeight;
    const ch = scroller.clientHeight;
    if (sh <= ch + 2) {
      bar.classList.remove("bf-sbthumb-on");
      return;
    }
    const sr = scroller.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const track = ch - 8; // 上下各留 4px
    const h = Math.max(28, Math.round((ch / sh) * track));
    const maxTop = track - h;
    const ratio = scroller.scrollTop / (sh - ch);
    const top = Math.round(sr.top - hr.top + 4 + ratio * maxTop);
    bar.style.height = h + "px";
    bar.style.top = top + "px";
    bar.style.transform = "none";
  };

  const onScroll = () => {
    bar.classList.add("bf-sbthumb-on");
    bar.classList.remove("bf-sbthumb-fade");
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.add("bf-sbthumb-fade"), 900);
  };

  scroller.addEventListener("scroll", onScroll, { passive: true });
  const api = {
    refresh: () => {
      bar.classList.add("bf-sbthumb-on");
      bar.classList.remove("bf-sbthumb-fade");
      render();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => bar.classList.add("bf-sbthumb-fade"), 900);
    },
    hide: () => bar.classList.remove("bf-sbthumb-on"),
    el: bar,
    onScroll
  };
  scroller.__bfSbar = api;
  return api;
}

function bindPanelInputs(panel) {
  panel.addEventListener("input", (e) => {
    const el = e.target;
    if (!el || !el.getAttribute) return;
    const key = el.getAttribute("data-key");
    if (!key) return;
    // ★ 2026-11-18 修：TEXTAREA 一直没被处理 —— 自定义名单 / 关键词高亮两个多行框
    //   打了字也不落设置（change 分支也只认 checkbox/select/number/color）。这是真功能缺陷。
    if (el.type === "text" || el.type === "number" || el.type === "color" || el.tagName === "TEXTAREA") {
      applySetting(key, el.value);
      if (el.type === "text" || el.tagName === "TEXTAREA") debouncedLightRefresh();
    }
  });
  panel.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || !el.getAttribute) return;
    const key = el.getAttribute("data-key");
    if (!key) return;
    if (el.type === "checkbox") applySetting(key, el.checked);
    else if (el.tagName === "SELECT") applySetting(key, el.value);
    else if (el.type === "number" || el.type === "color") applySetting(key, el.value);
  });
  panel.addEventListener("click", (e) => {
    const segBtn = e.target && e.target.closest && e.target.closest(".bf-seg button");
    if (segBtn && segBtn.parentElement.classList.contains("bf-multi")) {
      // 多选：点一下切换这一项，值存成 "card,orbit" 这种逗号串
      const seg = segBtn.parentElement;
      if (segBtn.getAttribute("data-on") === "1") segBtn.removeAttribute("data-on");
      else segBtn.setAttribute("data-on", "1");
      const on = [...seg.querySelectorAll("button")].filter((b) => b.getAttribute("data-on") === "1").map((b) => b.getAttribute("data-v"));
      applySetting(seg.getAttribute("data-key"), on.join(","));
      return;
    }
    if (segBtn) {
      const seg = segBtn.parentElement;
      const key = seg.getAttribute("data-key");
      for (const b of seg.querySelectorAll("button")) {
        if (b === segBtn) b.setAttribute("data-on", "1");
        else b.removeAttribute("data-on");
      }
      applySetting(key, segBtn.getAttribute("data-v"));
      return;
    }
    const btn = e.target && e.target.closest && e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "records") {
      toggleRecords(true);
      openPanel(false);
    } else if (action === "diag") {
      dumpDiag();
    } else if (action === "clearcache") {
      state.users = {};
      saveUserCacheSoon();
      showToast("用户缓存已清空，命中的人会重新查");
    } else if (action === "clearqueue") {
      state.queue.length = 0;
      showToast("匹配队列已清空");
    } else if (action === "theme") {
      state.settings.theme = state.settings.theme === "light" ? "dark" : "light";
      saveSettings();
      applyTheme();
    }
  });
}

const DISPLAY_KEYS = [
  "showNick", "nickSeparator", "nickSmallChars", "nickSmallSize", "fanMark", "fanThreshold",
  "followMark", "customFollowMark", "customFollowNames", "medalMark", "medalMinLevel",
  "levelMark", "levelMinLevel", "guardMark", "adminMark", "topTalkerMark", "topTalkerCount",
  "keywordRules", "keywordColor", "keywordGlow", "watchNames", "watchUids",
  "fanBadge", "fanColor", "fanGlow", "followBadge", "followColor", "followGlow",
  "customFollowBadge", "customFollowColor", "customFollowGlow",
  "customFollowFx", "followFx", "fanFx", "keywordFx",
];

const debouncedLightRefresh = debounce(() => {
  repaintOnScreen();
}, 400);

function applySetting(key, raw) {
  const s = state.settings;
  const numeric = ["fanThreshold", "nickSmallChars", "nickSmallSize", "medalMinLevel", "levelMinLevel", "topTalkerCount", "apiConcurrency", "apiIntervalMs"];
  if (numeric.indexOf(key) >= 0) s[key] = Number(raw) || 0;
  else if (typeof s[key] === "boolean") s[key] = !!raw;
  else s[key] = String(raw);

  saveSettings();

  if (key === "enabled") {
    if (s.enabled) startDanmakuClient();
    else {
      closeSocket();
      clearTimeout(state.sockets.reconnect);
      state.stats.source = "已关闭";
    }
  }
  if (key === "theme") applyTheme();
  if (key === "watchNames") scheduleWatchResolve();
  if (key === "customFollowNames" || key === "watchNames") {
    nameSetCache.src = null;
    watchCache.src = null;
    watchNameCache.src = null;
  }
  if (key === "keywordRules" || key === "keywordColor") keywordCache.src = null;
  if (DISPLAY_KEYS.indexOf(key) >= 0 || key === "apiMode") {
    // 改标注判据后，屏幕上已有弹幕按新设置重画（一次性，用户主动操作）
    debouncedLightRefresh();
  }
  renderStatus();
}

function syncPanelValues() {
  const panel = document.getElementById("bf-panel");
  if (!panel) return;
  const s = state.settings;
  panel.querySelectorAll("[data-key]").forEach((el) => {
    const key = el.getAttribute("data-key");
    const v = s[key];
    if (el.classList && el.classList.contains("bf-multi")) {
      const on = new Set(parseFx(v));
      for (const b of el.querySelectorAll("button")) {
        if (on.has(b.getAttribute("data-v"))) b.setAttribute("data-on", "1");
        else b.removeAttribute("data-on");
      }
      return;
    }
    if (el.classList && el.classList.contains("bf-seg")) {
      const btns = [...el.querySelectorAll("button")];
      const hit = btns.find((b) => b.getAttribute("data-v") === String(v)) || btns[0];
      for (const b of btns) {
        if (b === hit) b.setAttribute("data-on", "1");
        else b.removeAttribute("data-on");
      }
      return;
    }
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.type === "color") el.value = normalizeColor(v, "#ffffff");
    else el.value = v == null ? "" : String(v);
  });
  const box = document.getElementById("bf-morebox");
  if (box && s.moreOpen) {
    box.classList.add("bf-open");
    const arrow = document.querySelector("#bf-more .bf-arrow");
    if (arrow) arrow.textContent = "▴";
  }
}

function renderStatus() {
  trace("status:render");
  const box = document.getElementById("bf-status");
  if (!box || !state.settings) return;
  // ★ 只写文字节点。写容器 textContent 会把右下角的缩放手柄一起抹掉（v2.4.1 踩过）
  const el = box.querySelector(".bf-stext") || box;
  const s = state.stats;
  const parts = [];
  parts.push(s.source || "未连接");
  parts.push("捕获 " + s.captured + " / 匹配 " + s.matched);
  if (s.apiQueued - s.api > 0) parts.push("待查 " + Math.max(0, s.apiQueued - s.api));
  parts.push("API " + s.api + (s.apiFail ? "（失败 " + s.apiFail + "）" : ""));
  if (Date.now() < API.riskUntil) parts.push("⚠ 风控退避中");
  el.textContent = parts.join(" · ");
}

// ===== 指定人：昵称 → UID 解析 =====
function scheduleWatchResolve() {
  clearTimeout(watchResolveTimer);
  watchResolveTimer = setTimeout(resolveWatchNames, 700);
}

function resolveWatchNames() {
  const names = String(state.settings.watchNames || "")
    .split(/[\n,，;；、\t]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!names.length) {
    state.settings.watchUids = "";
    saveSettings();
    watchCache.src = null;
    return;
  }
  const resolved = new Set(String(state.settings.watchUids || "").split(/[\s,，;；]+/).filter(Boolean));
  let pending = names.length;
  let ok = 0;

  const done = () => {
    pending -= 1;
    if (pending > 0) return;
    state.settings.watchUids = Array.from(resolved).join(",");
    saveSettings();
    watchCache.src = null;
    showToast("指定人已解析 " + ok + "/" + names.length + " 个 UID");
    renderStatus();
  };

  names.forEach((name) => {
    searchUserByName(name)
      .then((info) => {
        if (info && info.mid) {
          resolved.add(String(info.mid));
          ok += 1;
        }
      })
      .finally(done);
  });
}

function searchUserByName(name) {
  const endpoint = "https://api.bilibili.com/x/web-interface/search/type";
  const params = { search_type: "bili_user", keyword: name, page: 1 };
  return wbiQuery(params)
    .then((q) => requestJson(endpoint + "?" + q))
    .catch(() => requestJson(endpoint + "?search_type=bili_user&keyword=" + encodeURIComponent(name)))
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) return null;
      const rows = json.data.result || [];
      const want = normalizeName(name);
      const exact = rows.find((r) => normalizeName(String(r.uname || "").replace(/<[^>]+>/g, "")) === want);
      if (exact) return exact;
      return rows.length === 1 ? rows[0] : null;
    })
    .catch(() => null);
}

function registerMenu() {
  try {
    GM_registerMenuCommand("打开设置面板", () => openPanel(true));
    GM_registerMenuCommand("打开高亮记录", () => toggleRecords(true));
    GM_registerMenuCommand("诊断导出（复制到剪贴板）", () => dumpDiag());
  } catch (_) {}
}

// ===== 70-main.js =====
// ===== 装配入口 =====

let domObserver = null;
let domTarget = null;
let urlTimer = 0;
let lastHref = "";

function findDanmakuContainer() {
  return (
    document.querySelector(".danmaku-item-container") ||
    document.querySelector("[class*='danmaku-item-container']") ||
    null
  );
}

function scanNode(node) {
  if (!node || node.nodeType !== 1) return;
  try {
    if (isDanmakuElement(node)) handleElement(node);
    if (node.firstElementChild && node.querySelectorAll) {
      const items = node.querySelectorAll(DANMAKU_ITEM_SELECTOR);
      for (const el of items) if (isDanmakuElement(el)) handleElement(el);
    }
  } catch (_) {}
}

// ★ v2.6.2 回收判定：B站 飘完把元素 class 收成光秃秃的 "bili-danmaku-x-dm" 丢回池子，
//   下一条弹幕再拿出来：换子节点 → "-dm -roll" → "-dm -roll -show"（2026-11-27 生命周期探针实测）。
//   回收和下一次 render 常在同一批记录里，回调触发时元素看上去「一直是活的」，
//   而纯表情的正文是空串、同一个表情的 <img> 也一模一样 —— 旧的「文字变了才算复用」永远判不出来，
//   于是上一位发同款表情的人（ILA）的身份快照被原样补画到 Master 的新弹幕上。
//   唯一可靠的痕迹在 MutationRecord.oldValue：某次 class 变更的旧值里没有活动标记（-roll/-show/-center），说明它刚从池子里出来。
//   isPooledClass 放在 05-util.js（逻辑层，可单测）。

function onMutations(mutations) {
  if (mutations.length) trace("mut:" + mutations.length + ":" + mutations[0].type);
  // 先整批扫一遍回收痕迹：同一批里排在前面的记录会先把旧身份补画回去，必须在处理任何记录之前撤掉
  for (const m of mutations) {
    if (m.type !== "attributes" || !m.target || m.target.nodeType !== 1) continue;
    if (!isPooledClass(m.oldValue)) continue;
    const st = elState.get(m.target);
    if (!st) continue;
    trace("recycle:" + st.uid);
    cleanupDecor(m.target, st);
    state.stats.recycled = (state.stats.recycled || 0) + 1;
  }
  for (const m of mutations) {
    try {
      // ① 属性变化：B站在插入后才补 -roll/-show 类名（也用于池子回收复用）
      //    带着我们装饰的元素离开活动池时也要进 handleElement，否则昵称会挂在池里的空壳上
      if (m.type === "attributes") {
        const t = m.target;
        if (t.nodeType === 1 && (isDanmakuElement(t) || elState.has(t))) handleElement(t);
        continue;
      }
      // ② 文字变化：文本节点是后加进去的（插入瞬间 textContent 还是空的），
      //    只盯 addedNodes 会整晚漏标，所以要看 target 是不是弹幕元素。
      if (m.type === "characterData") {
        const p = m.target.parentElement;
        if (p && p.nodeType === 1 && isDanmakuElement(p)) handleElement(p);
        continue;
      }
      if (!m.addedNodes || !m.addedNodes.length) continue;
      for (const node of m.addedNodes) {
        if (node.nodeType === 3) {
          const p = node.parentElement;
          if (p && isDanmakuElement(p)) handleElement(p);
        } else {
          scanNode(node);
        }
      }
    } catch (_) {}
  }
}

function attachObserver() {
  const container = findDanmakuContainer();
  const target = container || document.body;
  if (!target) return;
  if (domTarget === target && domObserver) return;
  if (domObserver) domObserver.disconnect();
  domTarget = target;
  domObserver = new MutationObserver(onMutations);
  domObserver.observe(target, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
    attributeOldValue: true, // ★ v2.6.2 回收判定靠 class 旧值（见 isPooledClass）
  });
  state.stats.selector = container ? "danmaku-item-container" : "body(fallback)";
  log("observer attached", state.stats.selector);
  // 首次挂载时把已在屏幕上的弹幕补一遍
  try {
    document.querySelectorAll(DANMAKU_ITEM_SELECTOR).forEach((el) => {
      if (isDanmakuElement(el)) handleElement(el);
    });
  } catch (_) {}
}

function watchUrl() {
  clearInterval(urlTimer);
  lastHref = location.href;
  urlTimer = setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    log("url changed", lastHref);
    restartForRoom();
  }, 1000);
}

function restartForRoom() {
  closeSocket();
  state.queue.length = 0;
  state.room = { uid: 0, name: "", title: "" };
  resetSession();
  initMatcher();
  elsByUid.clear();
  state.cards.clear();
  attachObserver();
  if (state.settings.enabled) startDanmakuClient();
}

function initMatcher() {
  danmakuMatcher = createMatcher({
    ttl: 3000,
    ahead: 500,
    // 必须「连着 + 还在滚」才算活：飘完回收的空壳虽然还连在 DOM 上，但它不配再吃掉新弹幕
    isAlive: (slot) => !!(slot && slot.el && slot.el.isConnected && isDanmakuElement(slot.el)),
    // 选槽前验明正身：元素此刻的文字必须仍等于这条 key（被复用换内容的空壳直接作废）
    liveKeyOf: (el) => {
      if (!isDanmakuElement(el)) return null;
      const cls = classifyElement(el, elState.get(el));
      return cls ? cls.key : null;
    },
  });
}

// ===== 诊断 =====
function dumpDiag() {
  const s = state.settings;
  const st = state.stats;
  const out = [];
  out.push("=== BFNN 诊断 v" + VERSION + " ===");
  out.push("时间 " + new Date().toISOString());
  out.push("开关 enabled=" + s.enabled + " showNick=" + s.showNick + " fan=" + s.fanMark + "/" + s.fanThreshold +
    " follow=" + s.followMark + " custom=" + s.customFollowMark + " emoji=" + s.emojiNick +
    " medal=" + s.medalMark + " hover=" + s.hoverCard + " record=" + s.recordEnabled + "/" + s.recordPersist +
    " api=" + s.apiMode + " theme=" + s.theme);
  out.push("连接 源=" + st.source + " 包=" + st.packets + "/" + st.msgPackets + " brotli丢=" + st.brotli + " 选择器=" + st.selector);
  out.push("调试 seen=" + st.dbg.seen + " 无UID=" + st.dbg.noUid + " 无文本=" + st.dbg.noText + " raw=" + (st.rawSample ? JSON.stringify(st.rawSample).slice(0, 300) : "无"));
  out.push("命令 " + Object.keys(st.cmds).map((k) => k + "×" + st.cmds[k]).join(" ") + " 解压失败=" + st.inflateFail + " JSON失败=" + st.jsonFail + " 处理异常=" + st.handleFail);
  out.push("数据 捕获=" + st.captured + " 匹配=" + st.matched + " 配对失败=" + st.matchFail +
    " 队列=" + state.queue.length + " 发言者=" + speakers.size + " 用户缓存=" + Object.keys(state.users).length);
  out.push("API 次数=" + st.api + " 失败=" + st.apiFail + " 排队=" + Math.max(0, st.apiQueued - st.api) +
    " 风控退避剩余=" + Math.max(0, Math.round((API.riskUntil - Date.now()) / 1000)) + "s 等级=" + API.riskLevel);
  const ms = danmakuMatcher ? danmakuMatcher.stats : {};
  out.push("配对器 到达=" + (ms.arrivals || 0) + " 元素=" + (ms.elements || 0) + " 成功=" + (ms.matched || 0) +
    " 待等=" + (ms.failed || 0) + " 空壳作废=" + (ms.staleSlot || 0) + " 重复槽=" + (ms.dupSlot || 0) +
    " 指纹命中=" + (ms.fpKeyed || 0));
  out.push("绘制 成功=" + st.paintOk + " 无身份=" + st.paintNoId + " 无名=" + st.paintNoName + " 同签名跳过=" + st.paintSame +
    " 隐藏=" + (st.nickHidden || 0) + " 熔断补跑=" + (st.runaway || 0) + " 回收撤装饰=" + (st.recycled || 0));
  out.push("记录 条数=" + recState.records.length + " 触发=" + st.recCaptured + " 去重挡=" + st.recDedup + " 进场提示=" + st.enter);
  out.push("UP uid=" + state.room.uid + " name=\"" + (state.room.name || "(空)") + "\" title=\"" + (state.room.title || "(空)") + "\"");

  // 画面盘点
  let nText = 0, missText = 0, nEmoji = 0, missEmoji = 0, nMixed = 0, missMixed = 0, nOther = 0;
  let nFixedTop = 0, missFixedTop = 0, nFixedBottom = 0, missFixedBottom = 0;
  let hiddenSpan = 0, noSpan = 0;
  const samples = [];
  const contEl = findDanmakuContainer();
  const contRect = contEl ? contEl.getBoundingClientRect() : null;
  document.querySelectorAll(DANMAKU_ITEM_SELECTOR).forEach((el) => {
    if (!isDanmakuElement(el)) {
      nOther += 1;
      return;
    }
    const stt = elState.get(el);
    const cls = classifyElement(el, stt);
    if (!cls) {
      nOther += 1;
      return;
    }
    // ★ v2.5.0：只判「span 存在」会把 display:none 的隐藏昵称也算成已标注
    //   （真机 60s：dump 报漏 0，实际 13.9% 被藏）。改成按「真实可见」判。
    const span = stt && stt.span;
    const attached = !!(span && span.parentNode === el);
    const visible = attached && getComputedStyle(span).display !== "none" && span.getBoundingClientRect().width > 2;
    if (attached && !visible) hiddenSpan += 1;
    else if (!attached) noSpan += 1;
    const ok = !!(stt && stt.uid && visible);
    // ★ v2.5.1：顶部/底部固定弹幕（-center）单独统计——以前被算进「其它」，
    //   于是诊断永远报「漏 0」，底部弹幕漏标根本看不见。
    if (isFixedDanmaku(el)) {
      const r = el.getBoundingClientRect();
      const isTop = contRect ? r.top - contRect.top < 40 : false;
      if (isTop) { nFixedTop += 1; if (!ok) missFixedTop += 1; }
      else { nFixedBottom += 1; if (!ok) missFixedBottom += 1; }
      if (!ok && samples.length < 6) {
        samples.push((isTop ? "固定顶 未标" : "固定底 未标") + " txt=" + cls.text.slice(0, 14) + " cls=" + String(el.className).slice(0, 40));
      }
      return;
    }
    if (cls.kind === "emoji") {
      nEmoji += 1;
      if (!ok) {
        missEmoji += 1;
        if (samples.length < 6) samples.push("表情 未标 key=" + cls.key.slice(2, 14) + " 在队列=" + state.queue.some((q) => q.emoticonKeys && q.emoticonKeys.indexOf(cls.key.slice(2)) >= 0) + " outer=" + el.outerHTML.slice(0, 100).replace(/\s+/g, " "));
      }
    } else if (cls.kind === "mixed") {
      nMixed += 1;
      if (!ok) {
        missMixed += 1;
        if (samples.length < 6) samples.push("混排 未标 txt=" + cls.text.slice(0, 14) + " 在队列=" + state.queue.some((q) => q.text === cls.text || q.matchText === cls.text));
      }
    } else {
      nText += 1;
      if (!ok) {
        missText += 1;
        if (samples.length < 6) samples.push("文字 未标 txt=" + cls.text.slice(0, 14) + " 在队列=" + state.queue.some((q) => q.text === cls.text || q.matchText === cls.text));
      }
    }
  });
  out.push("画面 文字=" + nText + "(漏" + missText + ") 表情=" + nEmoji + "(漏" + missEmoji + ") 混排=" + nMixed + "(漏" + missMixed + ") 其它=" + nOther);
  out.push("固定弹幕 顶部=" + nFixedTop + "(漏" + missFixedTop + ") 底部=" + nFixedBottom + "(漏" + missFixedBottom + ")");
  out.push("可见 隐藏span=" + hiddenSpan + " 无span=" + noSpan + " 累计隐藏=" + (st.nickHidden || 0) + " 熔断补跑=" + (st.runaway || 0));
  if (samples.length) {
    out.push("未标样本:");
    samples.forEach((x) => out.push("  " + x));
  }

  // 悬停/动画现场事实
  const probe = document.querySelector(DANMAKU_ITEM_SELECTOR);
  if (probe) {
    const cs = getComputedStyle(probe);
    out.push("弹幕元素 pointer-events=" + cs.pointerEvents + " animation=" + cs.animationName + "/" + cs.animationDuration +
      " fontSize=" + cs.fontSize + " 动画数=" + (probe.getAnimations ? probe.getAnimations().length : -1));
  }
  out.push("容器 " + (domTarget === document.body ? "body(fallback)" : "danmaku-item-container") + " 已挂观察器=" + !!domObserver);
  out.push("缓存名单 custom=" + customNameSet(s).size + " watchUid=" + watchUidSet(s).size);

  const text = out.join("\n");
  try {
    GM_setClipboard(text);
  } catch (_) {}
  console.log("[" + SCRIPT + "] 诊断:\n" + text);
  if (document.getElementById("bf-panel")) showToast("诊断已复制到剪贴板");
  return text;
}

// ===== 启动 =====
function initApp() {
  if (state.started) return;
  state.started = true;

  state.settings = loadSettings();
  state.users = loadUserCache();
  recLoad();
  initMatcher();

  injectStyle();
  buildPanel();
  registerMenu();
  initHover();

  attachObserver();
  watchUrl();
  if (state.settings.enabled) startDanmakuClient();

  // 调试出口：给自己排障/给未来的人取证（只调已有函数，不绕安全门）
  const api = {
    version: VERSION,
    state,
    dump: dumpDiag,
    openPanel,
    records: () => recState.records,
    matcherStats: () => danmakuMatcher && danmakuMatcher.stats,
    settings: () => state.settings,
    repaint: repaintOnScreen,
    hover: () => ({ el: !!hoverState.el, shown: hoverState.cardShown, anims: hoverState.anims ? hoverState.anims.length : 0, fallback: !!hoverState.fallback }),
    inspect: (el) => {
      const st = elState.get(el);
      return st ? { uid: st.uid, orig: st.orig, sig: st.sig, hasSpan: !!(st.span && st.span.parentNode === el), nick: st.span ? st.span.textContent : "" } : null;
    },
  };
  try {
    W.__bf = api;
  } catch (_) {}
  log("app started", VERSION);
}

function boot() {
  if (document.body) {
    initApp();
    return;
  }
  document.addEventListener("DOMContentLoaded", initApp, { once: true });
}

boot();
})();
