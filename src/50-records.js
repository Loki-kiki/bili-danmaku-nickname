// ===== 高亮记录：收录命中标注的弹幕，支持搜索/筛选/导出/删除/跳空间 =====

const REC_TAGS = ["关注", "粉丝", "自定义", "关键词"];

const recState = {
  records: [],
  seen: new Set(),
  query: "",
  mode: "kw", // kw | exact | regex
  filter: { 关注: true, 粉丝: true, 自定义: true, 关键词: true },
  selectMode: false,
  selected: new Set(),
};

function recLoad() {
  if (!state.settings.recordPersist) return;
  const arr = safeJsonParse(gmGet(HL_KEY, "[]"), []);
  if (!Array.isArray(arr)) return;
  recState.records = arr.filter((h) => h && typeof h === "object");
  recState.seen = new Set(recState.records.map((h) => String(h.uid) + "|" + String(h.text || "")));
}

let recSaveTimer = 0;
function recSaveSoon() {
  if (!state.settings.recordPersist) return;
  clearTimeout(recSaveTimer);
  recSaveTimer = setTimeout(() => {
    gmSet(HL_KEY, JSON.stringify(recState.records.slice(-500)));
  }, 1200);
}

function recordHighlight(identity, display) {
  if (!state.settings.recordEnabled) return;
  if (!state.room.uid || !state.room.name) updateRoomInfo();

  const tags = [];
  if (display.flags.custom) tags.push("自定义");
  if (display.flags.follow) tags.push("关注");
  if (display.flags.fan) tags.push("粉丝");
  if (display.flags.keyword) tags.push("关键词");
  if (!tags.length) return;

  state.stats.recCaptured += 1;
  const key = String(identity.uid) + "|" + String(identity.text || "");
  if (recState.seen.has(key)) {
    state.stats.recDedup += 1;
    return;
  }
  recState.seen.add(key);
  recState.records.push({
    uid: String(identity.uid),
    name: identity.name || (state.users[identity.uid] && state.users[identity.uid].uname) || "",
    text: String(identity.text || ""),
    tags,
    ts: Date.now(),
    roomUid: String(state.room.uid || ""),
    roomName: state.room.name || "",
    roomTitle: state.room.title || "",
  });
  if (recState.records.length > 500) recState.records.splice(0, recState.records.length - 500);
  recSaveSoon();
  recUpdateCount();
}

function recUpdateCount() {
  const el = document.getElementById("bf-rec-n");
  if (el) el.textContent = String(recState.records.length);
}

function recMatcher() {
  const q = String(recState.query || "").trim();
  if (!q) return { ok: true, test: () => true, hi: (s) => escapeHtml(s) };
  if (recState.mode === "exact") return { ok: true, test: (s) => s === q, hi: (s) => escapeHtml(s) };
  if (recState.mode === "regex") {
    try {
      const re = new RegExp(q, "i");
      return {
        ok: true,
        test: (s) => re.test(s),
        hi: (s) => {
          try {
            return escapeHtml(s).replace(new RegExp("(" + q + ")", "ig"), "<mark>$1</mark>");
          } catch (_) {
            return escapeHtml(s);
          }
        },
      };
    } catch (_) {
      return { ok: false };
    }
  }
  const lc = q.toLowerCase();
  return {
    ok: true,
    test: (s) => s.toLowerCase().indexOf(lc) >= 0,
    hi: (s) => {
      const i = s.toLowerCase().indexOf(lc);
      if (i < 0) return escapeHtml(s);
      return escapeHtml(s.slice(0, i)) + "<mark>" + escapeHtml(s.slice(i, i + q.length)) + "</mark>" + escapeHtml(s.slice(i + q.length));
    },
  };
}

function recRows() {
  const m = recMatcher();
  if (!m.ok) return [];
  return recState.records
    .filter((h) => (h.tags || []).some((t) => recState.filter[t]))
    .filter((h) => m.test(h.name || "") || m.test(h.text || ""));
}

function recTime(ts) {
  const t = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate()) + " " + p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
}

function renderRecords() {
  const body = document.getElementById("bf-rec-list");
  if (!body) return;
  recUpdateCount();
  const sf = document.getElementById("bf-rec-sf");
  const m = recMatcher();
  if (sf) {
    sf.classList.toggle("bf-has", !!recState.query);
    sf.classList.toggle("bf-invalid", !m.ok);
  }
  const count = document.getElementById("bf-rec-filtered");
  const rows = recRows();
  const filtering = !!recState.query || Object.values(recState.filter).some((v) => !v);
  if (count) count.textContent = filtering ? "筛选后 " + rows.length + " 条" : "";

  if (!m.ok) {
    body.innerHTML = '<div class="bf-empty">正则表达式有误（搜索框已标红）</div>';
    return;
  }
  if (!rows.length) {
    body.innerHTML = '<div class="bf-empty">' +
      (recState.records.length
        ? "没有匹配的记录<br><span>试试调整筛选或搜索词</span>"
        : "还没有高亮弹幕记录<br><span>命中关注/粉丝/自定义/关键词的弹幕会自动收进来</span>") +
      "</div>";
    return;
  }

  const html = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const h = rows[i];
    const idx = recState.records.indexOf(h);
    const selKey = String(idx);
    const checked = recState.selected.has(selKey);
    const tags = (h.tags || [])
      .map((t) => '<span class="bf-rtag bf-rt-' + (t === "关注" ? "follow" : t === "粉丝" ? "fan" : t === "自定义" ? "custom" : "kw") + '">' + t + "</span>")
      .join("");
    const room = h.roomUid
      ? ' <a class="bf-croomlink" href="https://space.bilibili.com/' + escapeHtml(h.roomUid) + '" target="_blank" rel="noopener" title="直播间UP">@' + escapeHtml(h.roomName || "未知") + "</a>"
      : "";
    html.push(
      '<div class="bf-ritem' + (recState.selectMode ? " bf-rsel" : "") + '">' +
        '<button class="bf-rchk' + (checked ? " bf-on" : "") + '" data-idx="' + idx + '" title="选择">✓</button>' +
        '<div class="bf-rmeta"><span class="bf-rtime">' + recTime(h.ts) + "</span>" + tags + room +
          '<button class="bf-rcopy" data-idx="' + idx + '" title="复制">⧉</button>' +
          '<button class="bf-rdel" data-idx="' + idx + '" title="删除">🗑</button>' +
        "</div>" +
        '<div class="bf-rline"><a class="bf-rname" href="https://space.bilibili.com/' + escapeHtml(h.uid) + '" target="_blank" rel="noopener">' + m.hi(h.name || "") + "</a>：" + m.hi(h.text || "") + "</div>" +
        (h.roomTitle ? '<div class="bf-rroomtitle">📺 ' + escapeHtml(h.roomTitle) + "</div>" : "") +
      "</div>"
    );
  }
  body.innerHTML = html.join("");
  updateSelBar();
  recBackfillRoomNames();
}

/** 旧记录/抢跑记录只存了 roomUid 没存主播名 → 按 uid 补名、落盘、重绘（每个 uid 只请求一次） */
let recBackfilling = false;
function recBackfillRoomNames() {
  if (recBackfilling) return;
  const uids = [...new Set(recState.records.filter((h) => h.roomUid && !h.roomName).map((h) => String(h.roomUid)))];
  if (!uids.length) return;
  recBackfilling = true;
  Promise.all(uids.map((uid) => fetchUpName(uid).then((name) => [uid, name])))
    .then((pairs) => {
      let changed = 0;
      for (const [uid, name] of pairs) {
        if (!name) continue;
        for (const h of recState.records) {
          if (String(h.roomUid) === uid && !h.roomName) {
            h.roomName = name;
            changed += 1;
          }
        }
      }
      recBackfilling = false;
      if (changed) {
        recSaveSoon();
        renderRecords();
      }
    })
    .catch(() => {
      recBackfilling = false;
    });
}

function updateSelBar() {
  const bar = document.getElementById("bf-rec-selbar");
  if (!bar) return;
  bar.classList.toggle("bf-show", recState.selectMode);
  const c = document.getElementById("bf-rec-selcount");
  if (c) c.textContent = "已选 " + recState.selected.size + " 条";
}

function recExport() {
  const rows = recRows();
  const lines = rows.map(
    (h) =>
      recTime(h.ts) + "\t[" + (h.tags || []).join("/") + "]" +
      (h.roomTitle ? "\t📺" + h.roomTitle : "") +
      (h.roomName ? "\t@" + h.roomName + "(" + h.roomUid + ")" : "") +
      "\t" + (h.name || "") + "：" + (h.text || "")
  );
  const text = "# B站高亮弹幕记录　共 " + rows.length + " 条\n" + lines.join("\n");
  try {
    GM_setClipboard(text);
    showToast("已复制 " + rows.length + " 条记录");
  } catch (_) {
    showToast("复制失败（剪贴板不可用）");
  }
}

function recDelete(idx) {
  const h = recState.records[idx];
  if (!h) return;
  recState.records.splice(idx, 1);
  recState.seen.delete(String(h.uid) + "|" + String(h.text || ""));
  recState.selected.clear();
  recSaveSoon();
  renderRecords();
}

function recDeleteSelected() {
  const idxs = Array.from(recState.selected).map(Number).sort((a, b) => b - a);
  if (!idxs.length) return;
  for (const i of idxs) {
    const h = recState.records[i];
    if (h) recState.seen.delete(String(h.uid) + "|" + String(h.text || ""));
    recState.records.splice(i, 1);
  }
  recState.selected.clear();
  recSaveSoon();
  renderRecords();
  showToast("已删除 " + idxs.length + " 条");
}

function recCopyOne(idx) {
  const h = recState.records[idx];
  if (!h) return;
  try {
    GM_setClipboard(recTime(h.ts) + "\t" + (h.name || "") + "：" + (h.text || ""));
    showToast("已复制这一条");
  } catch (_) {}
}

function recToggleSelect() {
  recState.selectMode = !recState.selectMode;
  if (!recState.selectMode) recState.selected.clear();
  renderRecords();
}

function bindRecordsPanel() {
  const panel = document.getElementById("bf-rec");
  if (!panel) return;
  panel.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#bf-rec-close")) {
      toggleRecords(false);
      return;
    }
    if (t.closest("#bf-rec-export")) {
      recExport();
      return;
    }
    if (t.closest("#bf-rec-sel")) {
      recToggleSelect();
      return;
    }
    if (t.closest("#bf-rec-delsel")) {
      recDeleteSelected();
      return;
    }
    if (t.closest("#bf-rec-clearq")) {
      recState.query = "";
      const inp = panel.querySelector("#bf-rec-q");
      if (inp) inp.value = "";
      renderRecords();
      return;
    }
    const chip = t.closest(".bf-rchip");
    if (chip) {
      const k = chip.getAttribute("data-k");
      recState.filter[k] = !recState.filter[k];
      chip.setAttribute("data-on", recState.filter[k] ? "1" : "0");
      renderRecords();
      return;
    }
    const modeBtn = t.closest(".bf-rmode button");
    if (modeBtn) {
      recState.mode = modeBtn.getAttribute("data-m");
      panel.querySelectorAll(".bf-rmode button").forEach((b) => b.setAttribute("data-on", b === modeBtn ? "1" : "0"));
      renderRecords();
      return;
    }
    const chk = t.closest(".bf-rchk");
    if (chk) {
      const idx = chk.getAttribute("data-idx");
      if (recState.selected.has(idx)) recState.selected.delete(idx);
      else recState.selected.add(idx);
      chk.classList.toggle("bf-on");
      updateSelBar();
      return;
    }
    const del = t.closest(".bf-rdel");
    if (del) {
      recDelete(Number(del.getAttribute("data-idx")));
      return;
    }
    const cp = t.closest(".bf-rcopy");
    if (cp) {
      recCopyOne(Number(cp.getAttribute("data-idx")));
      return;
    }
  });

  const input = panel.querySelector("#bf-rec-q");
  if (input) {
    input.addEventListener("input", () => {
      recState.query = input.value;
      renderRecords();
    });
  }
}