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