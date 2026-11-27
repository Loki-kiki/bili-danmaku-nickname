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