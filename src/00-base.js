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