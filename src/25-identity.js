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