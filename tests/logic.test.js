/**
 * 纯逻辑回归（不需要浏览器）：配对、配置迁移、身份解析、昵称拼装、构建一致性。
 * 跑法：node tests/logic.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (err) {
    failed += 1;
    failures.push(name + " → " + (err && err.message ? err.message : err));
    console.log("  ✗ " + name + " → " + (err && err.message ? err.message : err));
  }
}

function loadLogic(files) {
  const code =
    files.map((f) => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n;\n") +
    "\n;globalThis.__t = { createMatcher, migrateSettings, composeNick, parseDanmakuInfo," +
    " normalizeText, emoticonFileKey, customNameSet, watchNameSet, watchUidSet, matchKeyword," +
    " formatCount, DEFAULTS, state, setSettings: (s) => { state.settings = s; } };";

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    GM_getValue: () => undefined,
    GM_setValue: () => {},
    GM_addStyle: () => {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "logic-bundle.js" });
  return sandbox.__t;
}

const lib = loadLogic(["00-base.js", "05-util.js", "10-config.js", "25-identity.js", "30-matcher.js"]);
const DEFAULTS = lib.DEFAULTS;

function settingsWith(over) {
  return Object.assign({}, DEFAULTS, over);
}

console.log("\n[1] 配对层：同文本 FIFO / 时间窗 / 双向匹配 / 表情 key");
test("五条同文本按到达顺序分配给五个元素（不串人）", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  const uids = ["A", "B", "C", "D", "E"];
  uids.forEach((uid, i) => {
    m.onArrival({ key: "嘉门", altKey: "嘉门", ts: 1000 + i, identity: { uid } });
  });
  const got = [];
  uids.forEach((_, i) => {
    const r = m.onElement({ key: "嘉门", altKey: "嘉门", seenAt: 1010 + i });
    assert.ok(r, "第 " + (i + 1) + " 条应当配上");
    got.push(r.arrival.identity.uid);
  });
  assert.strictEqual(JSON.stringify(got), JSON.stringify(uids));
});

test("太老的弹幕不充数（宁可漏标不可错标）", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  m.onArrival({ key: "笑死", altKey: "笑死", ts: 1000, identity: { uid: "OLD" } });
  const r = m.onElement({ key: "笑死", altKey: "笑死", seenAt: 5000 });
  assert.strictEqual(r, null);
});

test("固定弹幕（-center）晚 6 秒上屏仍能配上，滚动弹幕同一时刻必须拒绝", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  m.onArrival({ key: "底部文案", altKey: "底部文案", ts: 1000, identity: { uid: "F1" } });
  const fixedHit = m.onElement({ key: "底部文案", altKey: "底部文案", seenAt: 7000, fixed: true });
  assert.ok(fixedHit, "固定弹幕 6s 后上屏应当配上");
  assert.strictEqual(fixedHit.arrival.identity.uid, "F1");

  const m2 = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  m2.onArrival({ key: "滚动文案", altKey: "滚动文案", ts: 1000, identity: { uid: "R1" } });
  assert.strictEqual(m2.onElement({ key: "滚动文案", altKey: "滚动文案", seenAt: 7000, fixed: false }), null, "滚动弹幕 6s 后不该配上");
});

test("固定弹幕：元素先出现、WS 晚到 8 秒也能配上（反向）", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  assert.strictEqual(m.onElement({ key: "顶部队列", altKey: "顶部队列", seenAt: 1000, fixed: true }), null);
  const hit = m.onArrival({ key: "顶部队列", altKey: "顶部队列", ts: 9000, identity: { uid: "F2" } });
  assert.ok(hit, "WS 晚 8s 仍应命中待匹配的固定弹幕元素");
  assert.strictEqual(hit.arrival.identity.uid, "F2");
});

test("元素先出现、弹幕后到达（WS 比渲染慢）也能配上", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  const miss = m.onElement({ key: "666", altKey: "666", seenAt: 1000 });
  assert.strictEqual(miss, null);
  const hit = m.onArrival({ key: "666", altKey: "666", ts: 1200, identity: { uid: "U1" } });
  assert.ok(hit, "应当在待匹配元素里命中");
  assert.strictEqual(hit.arrival.identity.uid, "U1");
});

test("纯表情：WS 的图片 key 与 DOM 的图片 key 对得上", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  m.onArrival({ key: "嗯", altKey: "嗯", emojiKeys: ["abc123"], ts: 2000, identity: { uid: "E1" } });
  const r = m.onElement({ key: "e:abc123", altKey: "", seenAt: 2010 });
  assert.ok(r);
  assert.strictEqual(r.arrival.identity.uid, "E1");
});

test("一条弹幕不会被两个元素重复消费", () => {
  const m = lib.createMatcher({ ttl: 3000, ahead: 500, isAlive: () => true });
  m.onArrival({ key: "唯一", altKey: "唯一", ts: 1000, identity: { uid: "U" } });
  assert.ok(m.onElement({ key: "唯一", altKey: "唯一", seenAt: 1000 }));
  assert.strictEqual(m.onElement({ key: "唯一", altKey: "唯一", seenAt: 1001 }), null);
});

console.log("\n[2] 配置迁移：老配置原样继承，只改旧默认残留");
test("没有 cfgVer 的老配置 → 补 cfgVer、保留他自己调过的值", () => {
  const out = lib.migrateSettings({ nickSeparator: ":", fanThreshold: 50000, customFollowNames: "" });
  assert.strictEqual(out.cfgVer, 3);
  assert.strictEqual(out.nickSeparator, ":");
  assert.strictEqual(out.fanThreshold, 50000);
});
test("老默认 emojiNick=false 一次性打开（新版表情昵称是必须项）", () => {
  const out = lib.migrateSettings({ emojiNick: false });
  assert.strictEqual(out.emojiNick, true);
});
test("已经写明 cfgVer=3 的不再改（用户主动关掉就尊重）", () => {
  const out = lib.migrateSettings({ cfgVer: 3, emojiNick: false, medalMark: true });
  assert.strictEqual(out.emojiNick, false);
  assert.strictEqual(out.medalMark, true);
});
test("cfgVer=2 的老用户升级：长前缀默认关掉（治同轨压字）", () => {
  const out = lib.migrateSettings({ cfgVer: 2, medalMark: true, guardMark: true, adminMark: true, topTalkerMark: true });
  assert.strictEqual(out.cfgVer, 3);
  assert.strictEqual(out.medalMark, false);
  assert.strictEqual(out.guardMark, false);
  assert.strictEqual(out.adminMark, false);
  assert.strictEqual(out.topTalkerMark, false);
});
test("空配置 → 全套默认值，且默认分隔符是 \":\"", () => {
  const out = lib.migrateSettings({});
  assert.strictEqual(out.nickSeparator, ":");
  assert.strictEqual(out.fanThreshold, 50000);
  assert.strictEqual(out.showNick, true);
});

console.log("\n[3] 弹幕包字段解析（零成本身份）");
test("粉丝牌 / 等级 / 舰长 / 房管 / 大表情 全部读出来", () => {
  const msg = {
    cmd: "DANMU_MSG",
    info: [
      [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, { url: "https://i0.hdslb.com/bfs/emote/abc.png" }, 0, { extra: JSON.stringify({ emots: { "[dog]": { url: "https://i0.hdslb.com/bfs/emote/def.png" } } }) }],
      "你好[dog]",
      ["12345", "阿琳", 1, 0, 0],
      [18, "嘉心糖", "嘉然", 22637261, 12646386],
      [6, 0, 1, 0],
      "",
      "",
      3,
    ],
  };
  const id = lib.parseDanmakuInfo(msg);
  assert.strictEqual(id.uid, "12345");
  assert.strictEqual(id.name, "阿琳");
  assert.strictEqual(id.text, "你好[dog]");
  assert.strictEqual(id.matchText, "你好");
  assert.strictEqual(id.medal.level, 18);
  assert.strictEqual(id.medal.name, "嘉心糖");
  assert.strictEqual(id.userLevel, 6);
  assert.strictEqual(id.guard, 3);
  assert.strictEqual(id.admin, true);
  assert.strictEqual(JSON.stringify(id.emoticonKeys), JSON.stringify(["abc", "def"]));
});

console.log("\n[4] 昵称拼装：徽章顺序 / 阈值 / 长昵称缩字 / 关键词");
const idBase = {
  uid: "1",
  name: "普通观众",
  text: "哈哈哈",
  matchText: "哈哈哈",
  medal: { level: 12, name: "嘉心糖", color: "#00aeec" },
  userLevel: 6,
  guard: 0,
  admin: false,
};
test("徽章顺序：◆自定义 → ❤关注 → ⭐粉丝 → 粉丝牌 → 舰长 → 房管", () => {
  const s = settingsWith({ customFollowMark: true, customFollowNames: "普通观众", fanMark: true, fanThreshold: 1000, medalMark: true, topTalkerMark: true });
  lib.setSettings(s);
  const id = Object.assign({}, idBase, { medal: { level: 12, name: "牌", color: "" } });
  const d = lib.composeNick(id, { uname: "普通观众", follower: 5000, followed: true }, s, {
    customSet: lib.customNameSet(s),
    watchUidSet: lib.watchUidSet(s),
    topRank: 3,
  });
  assert.strictEqual(JSON.stringify(d.badges.map((b) => b.kind)), JSON.stringify(["custom", "follow", "fan", "medal", "top"]));
  assert.strictEqual(d.color, s.customFollowColor);
});
test("粉丝数没到阈值就不标 ⭐（50000 门槛）", () => {
  const s = settingsWith({ customFollowMark: false, fanThreshold: 50000 });
  lib.setSettings(s);
  const d = lib.composeNick(idBase, { uname: "普通观众", follower: 49999, followed: false }, s, {});
  assert.ok(!d.badges.some((b) => b.kind === "fan"));
});
// v2.3.0 起改成「完整交给渲染层」：Master 要能看全，宽度由 fitAllNicks 按真实间隙决定，
// 所以 composeNick 不许再按 8 字截断。硬断言保留：昵称串里绝不能出现省略号（截断只发生在渲染层）。
test("长昵称不再按 8 字截断（v2.3.0 起），截断只发生在渲染层", () => {
  const s = settingsWith({ nickSmallChars: 8, showNick: true });
  lib.setSettings(s);
  const id = Object.assign({}, idBase, { name: "一二三四五六七八九十" });
  const d = lib.composeNick(id, { uname: "一二三四五六七八九十" }, s, {});
  assert.strictEqual(d.nick, "一二三四五六七八九十:");
  assert.strictEqual(d.nick.indexOf("…"), -1, "昵称串里不许出现省略号，否则就又变回截断了");
  assert.strictEqual(d.small, true);
  assert.strictEqual(d.smallSize, 12);
});
test("8 字及以内的昵称原样显示", () => {
  const s = settingsWith({ nickSmallChars: 8, showNick: true });
  lib.setSettings(s);
  const id = Object.assign({}, idBase, { name: "一二三四五六七八" });
  const d = lib.composeNick(id, { uname: "一二三四五六七八" }, s, {});
  assert.strictEqual(d.nick, "一二三四五六七八:");
  assert.strictEqual(d.small, false);
});
test("关键词命中给颜色，但人名高亮优先", () => {
  const s = settingsWith({ customFollowMark: true, customFollowNames: "普通观众", keywordRules: "哈哈", keywordColor: "#ff0000" });
  lib.setSettings(s);
  const d = lib.composeNick(idBase, { uname: "普通观众", follower: 0, followed: false }, s, { customSet: lib.customNameSet(s) });
  assert.strictEqual(d.flags.keyword, true);
  assert.strictEqual(d.color, s.customFollowColor);
});
test("showNick 关掉后只剩徽章", () => {
  const s = settingsWith({ showNick: false, customFollowMark: true, customFollowNames: "普通观众" });
  lib.setSettings(s);
  const d = lib.composeNick(idBase, { uname: "普通观众" }, s, { customSet: lib.customNameSet(s) });
  assert.strictEqual(d.nick, "");
  assert.ok(d.badges.length > 0);
});
// ★ 2026-11-22：guardMark 打开时 GUARD_SHORT 曾被引用却从未定义 → 抛 ReferenceError，
//   被 onMutations 的 try/catch 吞掉 → 舰长/提督/总督的弹幕**永远标不上**。
//   用户默认关着这项所以一直没暴露。这条断言就是防它再断。
test("舰长/提督/总督标注打开时能正常出徽章（不许抛异常）", () => {
  const s = settingsWith({ guardMark: true, adminMark: true });
  lib.setSettings(s);
  const cases = [[3, "舰"], [2, "提"], [1, "督"]];
  for (const [guard, expect] of cases) {
    const id = Object.assign({}, idBase, { guard, admin: false });
    const d = lib.composeNick(id, { uname: "舰长本人" }, s, {});
    const b = d.badges.find((x) => x.kind === "guard");
    assert.ok(b, "guard=" + guard + " 必须出 guard 徽章");
    assert.strictEqual(b.text, expect, "guard=" + guard + " 应压缩成单字 " + expect);
    assert.ok(d.nick, "昵称不能被吞掉");
  }
  // 未知等级不许崩，也不许瞎标
  const weird = lib.composeNick(Object.assign({}, idBase, { guard: 9 }), { uname: "x" }, s, {});
  assert.ok(!weird.badges.some((x) => x.kind === "guard"));
});

console.log("\n[5] 工具函数");
test("表情文件名归一（去 query / @缩放 / 扩展名）", () => {
  assert.strictEqual(lib.emoticonFileKey("https://i0.hdslb.com/bfs/emote/abcDEF.png@100w_100h.webp"), "abcdef");
  assert.strictEqual(lib.emoticonFileKey(""), "");
});
test("零宽字符与多空白归一", () => {
  assert.strictEqual(lib.normalizeText(" 你\u200b好 \n 啊 "), "你好 啊");
});
test("粉丝数缩写", () => {
  assert.strictEqual(lib.formatCount(1234), "1234");
  assert.strictEqual(lib.formatCount(50000), "5万");
  assert.strictEqual(lib.formatCount(123456789), "1.2亿");
});

console.log("\n[6] 构建与版本一致性");
test("dist 产物存在、@name/@namespace/存储键与基线一致", () => {
  const dist = path.join(ROOT, "dist", "bili-danmaku-nickname.user.js");
  assert.ok(fs.existsSync(dist), "先跑 node build.js");
  const code = fs.readFileSync(dist, "utf8");
  const base = fs.readFileSync(path.join(ROOT, "baseline", "v1.0.41-greasyfork.user.js"), "utf8");
  const pick = (src, re) => (src.match(re) || [])[1];
  assert.strictEqual(
    pick(code, /@name\s+(.+)/),
    pick(base, /@name\s+(.+)/),
    "@name 必须与基线完全一致"
  );
  assert.strictEqual(
    pick(code, /@namespace\s+(.+)/),
    pick(base, /@namespace\s+(.+)/),
    "@namespace 必须与基线完全一致"
  );
  for (const key of ["STORE_KEY", "USER_CACHE_KEY", "HL_KEY"]) {
    const re = new RegExp(key + ' = "([^"]+)"');
    assert.strictEqual(pick(code, re), pick(base, re), key + " 必须与基线一致，否则老数据读不到");
  }
});
test("版本号三处一致（version.js / @version / 代码常量）", () => {
  const version = require("../version.js");
  const code = fs.readFileSync(path.join(ROOT, "dist", "bili-danmaku-nickname.user.js"), "utf8");
  assert.strictEqual((code.match(/@version\s+(\S+)/) || [])[1], version);
  assert.strictEqual((code.match(/const VERSION = "([^"]+)"/) || [])[1], version);
});

console.log("\n[7] 性能纪律：源码里不许出现全量 DOM 扫描定时器");
test("没有 setInterval 里的 querySelectorAll 全量扫描", () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));
  let total = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    const re = /setInterval\s*\(\s*(?:\([^)]*\)\s*=>\s*\{[\s\S]{0,400}?document\.querySelectorAll|function[\s\S]{0,300}?document\.querySelectorAll)/g;
    const hits = src.match(re) || [];
    total += hits.length;
  }
  assert.strictEqual(total, 0, "发现 setInterval 里扫全 DOM：" + total + " 处");
});

console.log("\n[8] 防死循环：写 DOM 前必须比对，内容没变不许重写");
test("paintDisplay 对同一份 display 只写一次 innerHTML（防 MutationObserver 自激）", () => {
  const src = fs.readFileSync(path.join(SRC, "35-decorate.js"), "utf8");
  // 静态断言：写 innerHTML 必须在 __bfHtml 比对之后（这是修掉主线程锁死的关键）
  const guard = src.indexOf("if (span.__bfHtml !== html)");
  const write = src.indexOf("span.innerHTML = html;");
  assert.ok(guard > 0 && write > guard, "innerHTML 写入前没有 __bfHtml 比对，页面会被自激锁死");
});

test("handleElement 的补画分支必须有签名闸门（否则写 DOM→mutation→再补画 死循环）", () => {
  const src = fs.readFileSync(path.join(SRC, "35-decorate.js"), "utf8");
  const branch = src.slice(src.indexOf("// ② 已经认过身份"), src.indexOf("// ③ 全新元素"));
  assert.ok(branch.length > 0, "找不到 ② 分支");
  assert.ok(branch.includes("sig === st.sig"), "② 分支没有签名比对");
  assert.ok(branch.includes("spanAlive"), "② 分支没有检查 span 是否还活着");
});

test("classList 加类必须幂等（addClass 包一层）", () => {
  const src = fs.readFileSync(path.join(SRC, "35-decorate.js"), "utf8");
  const body = src.slice(src.indexOf("function paintDisplay"));
  const raw = body.match(/el\.classList\.add\(/g) || [];
  assert.strictEqual(raw.length, 0, "paintDisplay 里还有裸 classList.add，会持续喂 mutation");
});

console.log("\n[9] 固定弹幕与昵称宽度纪律（v2.5.2）");
test("白名单必须认 -center（顶部/底部固定弹幕的真类名）", () => {
  const src = fs.readFileSync(path.join(SRC, "35-decorate.js"), "utf8");
  assert.ok(src.includes("bili-danmaku-x-center"), "isDanmakuElement 白名单里没有 -center，固定弹幕会进不来");
  assert.ok(src.includes("function isFixedDanmaku"), "缺少固定弹幕识别函数");
});
test("昵称宽度不再由「同轨间隙」决定（不许退回截成 3 字）", () => {
  const src = fs.readFileSync(path.join(SRC, "35-decorate.js"), "utf8");
  assert.ok(src.indexOf("Math.min(avail, NICK_CAP_W)") < 0, "又按间隙收窄昵称了：底部/顶部弹幕会只剩两三个字");
  assert.ok(src.includes("const fullW = Math.min(cur.st.nickM.w12, NICK_CAP_W)"), "缺少「按自然宽度显示」的实现");
  assert.ok(src.includes("const needBg = !cur.fixed && fullW > avail + 4"), "放不下时必须加底衬，否则压字看不清");
});
test("配对器给固定弹幕留了更宽的时间窗，滚动弹幕的 3s 不许放宽", () => {
  const src = fs.readFileSync(path.join(SRC, "30-matcher.js"), "utf8");
  assert.ok(src.includes("ttlFixed"), "缺少固定弹幕独立时间窗");
  assert.ok(src.includes("const ttlFor = (slot) => (slot && slot.fixed ? TTLF : TTL)"), "时间窗没有按类型区分");
});
test("诊断必须单独统计顶部/底部固定弹幕（否则永远显示漏 0）", () => {
  const src = fs.readFileSync(path.join(SRC, "70-main.js"), "utf8");
  assert.ok(src.includes("固定弹幕 顶部="), "dumpDiag 没有固定弹幕统计行");
  assert.ok(src.includes("isFixedDanmaku(el)"), "dumpDiag 没有把固定弹幕分流");
});

console.log("\n结果：" + passed + " 通过 / " + failed + " 失败");
if (failed) {
  console.log("失败项：");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}