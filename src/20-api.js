// ===== API 队列：并发 + 优先级 + 风控退避 + 6 小时缓存 =====
// B站没有可用的批量身份接口（relations 批量实测 data:null），只能逐个查；
// 单个 stat/relation 约 90ms，60ms 起一个即可轻松追上大直播间的人流。

const API = {
  items: [],
  running: 0,
  lastStart: 0,
  timer: 0,
  riskUntil: 0,
  riskLevel: 0,
  seq: 0,
};

const RISK_CODES = new Set([-412, -352, -509, -799]);

function apiConcurrency() {
  return clamp(Number(state.settings.apiConcurrency) || 5, 1, 8);
}

function apiInterval() {
  return clamp(Number(state.settings.apiIntervalMs) || 60, 10, 2000);
}

function userRecord(uid) {
  uid = String(uid);
  let u = state.users[uid];
  if (!u) {
    u = { uid, uname: "", follower: 0, followed: false, attribute: 0, statTs: 0, followTs: 0, retry: 0 };
    state.users[uid] = u;
  }
  // 老缓存格式（只有 fetched/ts）→ 迁移成字段级时间戳
  if (u.fetched && u.ts && !u.statTs) u.statTs = u.ts;
  if (u.fetched && u.ts && !u.followTs) u.followTs = u.ts;
  return u;
}

function statFresh(u) {
  return !!u && u.statTs > 0 && Date.now() - u.statTs < 6 * 60 * 60 * 1000;
}

function followFresh(u) {
  return !!u && u.followTs > 0 && Date.now() - u.followTs < 6 * 60 * 60 * 1000;
}

// 队列里是否已有这个人（避免重复排队：同一 uid 一晚上只查一次）
function apiQueued(uid) {
  for (const job of API.items) if (job.uid === uid) return job;
  return null;
}

/**
 * 给一个人排队查身份。priority 0 最高（自定义/指定人），3 最低（普通观众）。
 */
function apiEnqueue(uid, priority) {
  uid = String(uid || "");
  if (!uid || uid === "0") return;
  const s = state.settings;
  if (!s.fanMark && !s.followMark) return;
  // 「只查值得的人」：普通观众（优先级 3）不查，省请求
  if (s.apiMode === "worthy" && Number(priority) >= 3) return;

  const u = userRecord(uid);
  const needFan = s.fanMark && !statFresh(u);
  const needFollow = s.followMark && !followFresh(u);
  if (!needFan && !needFollow) {
    debugLog("api-cache-hit", { uid, follower: u.follower, followed: u.followed });
    return;
  }
  if (Number(u.retry || 0) >= 3) return;

  const existing = apiQueued(uid);
  if (existing) {
    if (priority < existing.priority) existing.priority = priority;
    return;
  }
  API.items.push({ uid, priority: Number(priority) || 3, needFan, needFollow, at: Date.now(), seq: API.seq++ });
  state.stats.apiQueued += 1;
  apiPump();
}

function apiNextJob() {
  if (!API.items.length) return null;
  let bestIdx = 0;
  for (let i = 1; i < API.items.length; i += 1) {
    const a = API.items[i];
    const b = API.items[bestIdx];
    if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) bestIdx = i;
  }
  return API.items.splice(bestIdx, 1)[0];
}

function apiPump() {
  trace("api:pump");
  if (state.destroyed) return;
  clearTimeout(API.timer);
  const now = Date.now();
  if (now < API.riskUntil) {
    API.timer = setTimeout(apiPump, Math.min(30000, API.riskUntil - now));
    return;
  }
  const gap = Math.max(0, apiInterval() - (now - API.lastStart));
  const max = apiConcurrency();
  let started = false;
  while (API.running < max && API.items.length) {
    if (Date.now() - API.lastStart < apiInterval()) break;
    const job = apiNextJob();
    if (!job) break;
    API.running += 1;
    API.lastStart = Date.now();
    started = true;
    apiRunJob(job)
      .catch((err) => debugLog("api-job-crash", { uid: job.uid, err: shortError(err) }))
      .then(() => {
        trace("api:job-done");
        API.running = Math.max(0, API.running - 1);
        apiPump();
      });
  }
  if (!started && API.items.length) API.timer = setTimeout(apiPump, Math.max(16, gap));
}

function apiNoteRisk(code) {
  API.riskLevel = Math.min(6, API.riskLevel + 1);
  const wait = Math.min(60000, 1000 * Math.pow(2, API.riskLevel - 1));
  API.riskUntil = Date.now() + wait;
  state.stats.apiRisk += 1;
  warn("API 风控命中 code=" + code + "，退避 " + Math.round(wait / 1000) + "s");
  if (typeof renderStatus === "function") renderStatus();
}

function apiNoteOk() {
  if (API.riskLevel > 0) API.riskLevel = Math.max(0, API.riskLevel - 1);
  API.riskUntil = 0;
}

function apiRunJob(job) {
  const u = userRecord(job.uid);
  const steps = [];
  if (job.needFan && !statFresh(u)) steps.push(() => apiFetchFollower(job.uid));
  if (job.needFollow && !followFresh(u)) steps.push(() => apiFetchFollow(job.uid));
  return steps.reduce(
    (p, step) => p.then(() => step()),
    Promise.resolve()
  ).then(() => {
    API.riskLevel = 0;
    if (typeof renderStatus === "function") renderStatus();
  }).catch((err) => {
    u.retry = Number(u.retry || 0) + 1;
    throw err;
  });
}

function apiFetchFollower(uid) {
  state.stats.api += 1;
  return requestJson("https://api.bilibili.com/x/relation/stat?vmid=" + encodeURIComponent(uid))
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) {
        if (json && RISK_CODES.has(Number(json.code))) {
          apiNoteRisk(json.code);
          // 风控期间把这条放回队列（不消耗重试次数）
          const u = userRecord(uid);
          u.retry = Math.max(0, Number(u.retry || 0) - 1);
          API.items.push({ uid, priority: 3, needFan: true, needFollow: false, at: Date.now(), seq: API.seq++ });
          return;
        }
        throw new Error("stat code " + (json && json.code));
      }
      trace("api:follower-ok");
      const u = userRecord(uid);
      u.follower = Number(json.data.follower || 0);
      u.statTs = Date.now();
      u.retry = 0;
      state.stats.apiFail = Math.max(0, state.stats.apiFail - 1);
      apiNoteOk();
      saveUserCacheSoon();
      onUserMeta(uid);
      debugLog("api-follower", { uid, follower: u.follower });
    })
    .catch((err) => {
      // ★ 风控（HTTP 412 / JSON -412）走退避重排，不能算普通失败：
      //   算成 apiFail 会让退避机制看起来没生效，实际是被这条覆盖掉了。
      if (err && err.riskCode != null) {
        apiNoteRisk(err.riskCode);
        const u = userRecord(uid);
        u.retry = Math.max(0, Number(u.retry || 0) - 1);
        API.items.push({ uid, priority: 3, needFan: true, needFollow: false, at: Date.now(), seq: API.seq++ });
        return;
      }
      state.stats.apiFail += 1;
      trace("api:follower-fail " + shortError(err));
      debugLog("api-follower-fail", { uid, err: shortError(err) });
      throw err;
    });
}

function apiFetchFollow(uid) {
  state.stats.api += 1;
  return requestJson("https://api.bilibili.com/x/relation?fid=" + encodeURIComponent(uid))
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) {
        if (json && RISK_CODES.has(Number(json.code))) {
          apiNoteRisk(json.code);
          const u = userRecord(uid);
          u.retry = Math.max(0, Number(u.retry || 0) - 1);
          API.items.push({ uid, priority: 3, needFan: false, needFollow: true, at: Date.now(), seq: API.seq++ });
          return;
        }
        throw new Error("relation code " + (json && json.code));
      }
      const attr = Number(json.data.attribute || 0);
      const u = userRecord(uid);
      u.attribute = attr;
      u.followed = (attr & 2) === 2; // bit2 = 已关注（6=互粉 也含 2）
      u.followTs = Date.now();
      u.retry = 0;
      apiNoteOk();
      saveUserCacheSoon();
      onUserMeta(uid);
      debugLog("api-follow", { uid, attribute: attr, followed: u.followed });
    })
    .catch((err) => {
      if (err && err.riskCode != null) {
        apiNoteRisk(err.riskCode);
        const u = userRecord(uid);
        u.retry = Math.max(0, Number(u.retry || 0) - 1);
        API.items.push({ uid, priority: 3, needFan: false, needFollow: true, at: Date.now(), seq: API.seq++ });
        return;
      }
      state.stats.apiFail += 1;
      debugLog("api-follow-fail", { uid, err: shortError(err) });
      throw err;
    });
}

// ===== 身份卡：悬停才查，独立缓存（30 分钟）=====
function apiFetchCard(uid) {
  uid = String(uid || "");
  if (!uid) return Promise.resolve(null);
  const cached = state.cards.get(uid);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return Promise.resolve(cached.data);

  return requestJson("https://api.bilibili.com/x/web-interface/card?mid=" + encodeURIComponent(uid) + "&photo=false")
    .then((json) => {
      if (!json || Number(json.code) !== 0 || !json.data) throw new Error("card code " + (json && json.code));
      const data = {
        card: json.data.card || {},
        following: !!json.data.following,
        relation: json.data.relation || null,
      };
      state.cards.set(uid, { data, ts: Date.now() });
      if (state.cards.size > 200) {
        const oldest = Array.from(state.cards.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) state.cards.delete(oldest[0]);
      }
      return data;
    })
    .catch((err) => {
      debugLog("card-fail", { uid, err: shortError(err) });
      return null;
    });
}

/** 值得优先查的人：自定义/指定人=0，舰长/房管/高粉丝牌/高等级=2，其他人=3 */
function apiPriorityFor(identity) {
  if (!identity) return 3;
  if (isWatchUid(identity.uid)) return 0;
  if (identity.guard > 0 || identity.admin) return 2;
  if (identity.medal && identity.medal.level >= Number(state.settings.medalMinLevel || 10)) return 2;
  return 3;
}