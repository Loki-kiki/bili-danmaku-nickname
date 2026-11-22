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