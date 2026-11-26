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

function onMutations(mutations) {
  if (mutations.length) trace("mut:" + mutations.length + ":" + mutations[0].type);
  for (const m of mutations) {
    try {
      // ① 属性变化：B站在插入后才补 -roll/-show 类名（也用于池子回收复用）
      if (m.type === "attributes") {
        if (m.target.nodeType === 1 && isDanmakuElement(m.target)) handleElement(m.target);
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
    " 隐藏=" + (st.nickHidden || 0) + " 熔断补跑=" + (st.runaway || 0));
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