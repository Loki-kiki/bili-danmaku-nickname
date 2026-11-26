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
    cleanupDecor(el, elState.get(el));
    return;
  }

  let st = elState.get(el);
  const cur = normalizeText(ownText(el, st));

  // ① 元素被复用：内容变了 → 清干净当新元素处理
  if (st && st.uid && cur && cur !== st.orig) {
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