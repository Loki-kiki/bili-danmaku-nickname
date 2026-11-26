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