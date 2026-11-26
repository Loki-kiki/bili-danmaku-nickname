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