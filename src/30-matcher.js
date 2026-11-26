// ===== 配对层：WS 弹幕 ↔ 画面 DOM 元素 =====
// 旧版病根：
//   D1 用 dataset 存状态 → B站重绘清掉标记后无法追回
//   D2 「文本 → 最近一条未使用」→ 同屏 5 条「嘉门」必然串人
// 新方案：状态进 WeakMap；同文本按 FIFO（WS 顺序 == 渲染顺序）；
// 并且**选槽前先验明正身**——元素必须此刻仍在滚、且文字仍等于这条 key，
// 否则它就是被回收复用的空壳，直接作废，绝不拿它吞掉一条新弹幕。

function createMatcher(opt) {
  const options = opt || {};
  const TTL = options.ttl || 3000; // 到达与元素出现允许的最大时间差
  const AHEAD = options.ahead || 500; // WS 允许比渲染晚多少（自家连接常比页面慢几十毫秒）
  // ★ v2.5.1：固定弹幕（顶部/底部，-center）在 B站 上屏前可能被碰撞池推迟，
  //   实测正常 0.1–1.3s，但排队时会超过滚动弹幕的 3s。给它们一条单独的宽窗口，
  //   否则「底部弹幕容易没标注」会一直存在。（宁可多等，错标由 FIFO + liveKey 兜住）
  const TTLF = options.ttlFixed || Math.max(TTL * 4, 12000);
  const isAlive = options.isAlive || (() => true);
  const liveKeyOf = options.liveKeyOf || null; // el → 此刻的配对 key（空壳/已复用返回不同值或 null）
  const ttlFor = (slot) => (slot && slot.fixed ? TTLF : TTL);

  const arrivals = []; // 按到达顺序
  const buckets = new Map(); // key -> arrival[]
  const pending = new Map(); // key -> slot[]
  const slotByEl = new WeakMap(); // el -> slot（一个元素只许有一个未完成的槽）
  let seq = 0;

  const stats = { arrivals: 0, elements: 0, matched: 0, failed: 0, pendingHit: 0, staleSlot: 0, dupSlot: 0, fpKeyed: 0, fpMiss: 0 };

  // 指纹弱化成「兼容」而不是「相等」：任一边缺指纹就放行。
  // 宁可退回纯文本 FIFO（旧口径），也不能因为拿不到 --color 就整条漏标。
  function fpCompatible(a, b) {
    const fa = a && a.fp ? String(a.fp) : "";
    const fb = b && b.fp ? String(b.fp) : "";
    if (!fa || !fb) return true;
    return fa === fb;
  }

  // 强键 → 纯文本键（liveKeyOf 只会返回纯文本，比对前要剥掉指纹前缀）
  function plainKeyOf(key) {
    const s = String(key || "");
    if (s.indexOf("F\u0001") === 0) {
      const rest = s.slice(2);
      const i = rest.indexOf("\u0001");
      return i >= 0 ? rest.slice(i + 1) : rest;
    }
    return s;
  }

  function keysOf(item) {
    const keys = [];
    // ★ 强键优先：指纹 + 文本。同文本多人同时发时，只有它能把人和弹幕对上。
    if (item.key) {
      if (item.fp) keys.push("F\u0001" + item.fp + "\u0001" + item.key);
      keys.push(item.key);
    }
    if (item.altKey && item.altKey !== item.key) {
      if (item.fp) keys.push("F\u0001" + item.fp + "\u0001" + item.altKey);
      keys.push(item.altKey);
    }
    if (Array.isArray(item.emojiKeys)) {
      for (const k of item.emojiKeys) if (k) keys.push("e:" + k);
    }
    return keys;
  }

  function pushBucket(key, item) {
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(item);
  }

  // 这个槽还配得上这条 key 吗？空壳（已飘完）、被复用换了内容的，都不配。
  function slotStillValid(slot, key) {
    if (slot.done) return false;
    if (!isAlive(slot)) {
      slot.done = true;
      stats.staleSlot += 1;
      return false;
    }
    if (liveKeyOf && liveKeyOf(slot.el) !== plainKeyOf(key)) {
      slot.done = true;
      stats.staleSlot += 1;
      return false;
    }
    return true;
  }

  function prune(now) {
    const keep = Math.max(TTL, TTLF) * 2;
    while (arrivals.length && (arrivals[0].used || now - arrivals[0].ts > keep)) {
      const old = arrivals.shift();
      old.dropped = true;
    }
    if (arrivals.length > 2000) arrivals.splice(0, arrivals.length - 2000);
    for (const [key, list] of buckets) {
      let i = 0;
      while (i < list.length && (list[i].used || list[i].dropped)) i += 1;
      if (i > 0) list.splice(0, i);
      if (!list.length) buckets.delete(key);
    }
    for (const [key, list] of pending) {
      const alive = list.filter((slot) => !slot.done && isAlive(slot));
      if (alive.length !== list.length) {
        if (alive.length) pending.set(key, alive);
        else pending.delete(key);
      }
    }
  }

  function takeArrival(key, at, fixed, fp) {
    const list = buckets.get(key);
    if (!list) return null;
    const ttl = fixed ? TTLF : TTL;
    let best = null;
    for (const item of list) {
      if (item.used || item.dropped) continue;
      if (at - item.ts > ttl) continue; // 太老的不能拿来充数
      if (item.ts - at > AHEAD) continue; // 还没到的也不能用
      // ★ 指纹闸：两边都有指纹且不同 → 一定不是同一条（同文本不同人），跳过
      if (!fpCompatible(item, { fp })) continue;
      if (!best || item.ts < best.ts) best = item; // 同文本按 FIFO 取最早
    }
    if (best) best.used = true;
    return best;
  }

  return {
    stats,

    pendingCount() {
      let n = 0;
      for (const list of pending.values()) n += list.filter((s) => !s.done).length;
      return n;
    },

    reset() {
      arrivals.length = 0;
      buckets.clear();
      pending.clear();
      stats.arrivals = 0;
      stats.elements = 0;
      stats.matched = 0;
      stats.failed = 0;
      stats.pendingHit = 0;
      stats.staleSlot = 0;
      stats.dupSlot = 0;
      stats.fpKeyed = 0;
      stats.fpMiss = 0;
    },

    /** WS 到达一条弹幕：先看有没有等它的元素，没有就入队 */
    onArrival(item) {
      const now = item.ts || Date.now();
      const rec = Object.assign({ seq: ++seq, used: false, dropped: false, ts: now }, item);
      stats.arrivals += 1;

      let hit = null;
      let hitKey = "";
      for (const key of keysOf(rec)) {
        const list = pending.get(key);
        if (!list || !list.length) continue;
        for (const slot of list) {
          if (!slotStillValid(slot, key)) continue;
          if (!fpCompatible(slot, rec)) continue;
          if (rec.ts - slot.seenAt > ttlFor(slot)) continue;
          if (slot.seenAt - rec.ts > AHEAD) continue;
          if (!hit || slot.seenAt < hit.seenAt) {
            hit = slot;
            hitKey = key;
          }
        }
        if (hit) break;
      }

      arrivals.push(rec);
      for (const key of keysOf(rec)) pushBucket(key, rec);
      prune(now);

      if (hit) {
        hit.done = true;
        rec.used = true;
        stats.matched += 1;
        return { arrival: rec, slot: hit, key: hitKey };
      }
      return null;
    },

    /** 画面出现（或文字刚到位）一个元素：先看有没有等它的弹幕，没有就登记等后续弹幕 */
    onElement(slot) {
      const seenAt = slot.seenAt || Date.now();
      const rec = Object.assign({ done: false, seenAt }, slot);
      stats.elements += 1;

      // 同一个元素只保留一个未完成槽：B站会在插入后再补文字/类名，会触发好几次
      const hasEl = rec.el && typeof rec.el === "object";
      if (hasEl) {
        const prev = slotByEl.get(rec.el);
        if (prev && !prev.done) {
          if (prev.key === rec.key && prev.fp === rec.fp) {
            stats.dupSlot += 1;
            return null; // 同一个元素同一个 key，重复登记没意义
          }
          prev.done = true;
          stats.dupSlot += 1;
        }
        slotByEl.set(rec.el, rec);
      }

      let arrival = null;
      for (const key of keysOf(rec)) {
        const hit = takeArrival(key, seenAt, rec.fixed, rec.fp);
        if (hit) {
          if (String(key).indexOf("F\u0001") === 0) stats.fpKeyed += 1;
          arrival = hit;
          break;
        }
      }
      if (arrival) {
        rec.done = true;
        stats.matched += 1;
        return { arrival, slot: rec };
      }

      stats.failed += 1;
      for (const key of keysOf(rec)) {
        let list = pending.get(key);
        if (!list) {
          list = [];
          pending.set(key, list);
        }
        if (list.length < 40) list.push(rec);
      }
      return null;
    },

    /** 元素被 B站复用/内容变了：作废它的登记 */
    dropSlot(rec) {
      if (rec) rec.done = true;
    },
  };
}

// 全局配对器：main.js 的 initMatcher() 负责实例化（换房间时会重建）
let danmakuMatcher = null;