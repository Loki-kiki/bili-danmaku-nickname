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