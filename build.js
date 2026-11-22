#!/usr/bin/env node
/**
 * 构建器：把 src/*.js 拼装成单文件 userscript。
 *
 * 纪律（踩过的坑，别省）：
 *  - 版本号单一来源 version.js，同时注入 @version 与代码里的 VERSION 常量，两处不一致就非零退出；
 *  - 产物写完回读正则校验，不只看内存里的字符串；
 *  - 用 vm.Script 做语法检查，语法错直接非零退出；
 *  - @name / @namespace 必须与 v1.0.41 字节一致（Tampermonkey 靠这两个认「同一个脚本的升级」）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

// 拼接顺序 = 依赖顺序（同一个 IIFE 作用域里共享 const/function）
const ORDER = [
  "00-base.js",
  "05-util.js",
  "10-config.js",
  "12-md5.js",
  "15-protocol.js",
  "20-api.js",
  "25-identity.js",
  "30-matcher.js",
  "35-decorate.js",
  "40-hover.js",
  "45-track.js",
  "50-records.js",
  "55-panel.js",
  "70-main.js",
];

const NAME = "B站(bilibili)直播画面弹幕昵称标注";
const NAMESPACE = "https://live.bilibili.com/";

// 发布通道：GitHub 公开仓库的 raw 直链，Tampermonkey 靠 @updateURL 自动提示更新。
// ★ 这个 URL 必须指向真正被提交进仓库的 dist 产物，否则装的人会「检查更新成功但内容没变」。
const REPO = "Loki-kiki/bili-danmaku-nickname";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/dist/bili-danmaku-nickname.user.js`;

function readVersion() {
  const raw = fs.readFileSync(path.join(ROOT, "version.js"), "utf8");
  const m = raw.match(/module\.exports\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("version.js 里找不到导出的版本号");
  return m[1];
}

function build() {
  const version = readVersion();

  const parts = [];
  for (const file of ORDER) {
    const p = path.join(SRC, file);
    if (!fs.existsSync(p)) throw new Error("缺少源文件：" + file);
    parts.push(`// ===== ${file} =====\n` + fs.readFileSync(p, "utf8").trim());
  }

  // 样式单独成文件：注入为字符串常量，避免模板字符串里的反引号冲突
  const cssPath = path.join(SRC, "ui.css");
  if (!fs.existsSync(cssPath)) throw new Error("缺少 src/ui.css");
  const css = fs.readFileSync(cssPath, "utf8");
  parts.splice(parts.findIndex((p) => p.indexOf("// ===== 55-panel.js =====") === 0),
    0, "// ===== ui.css =====\nconst UI_CSS = " + JSON.stringify(css) + ";");

  const header = [
    "// ==UserScript==",
    "// @name         " + NAME,
    "// @namespace    " + NAMESPACE,
    "// @version      " + version,
    "// @description  仅增强B站直播画面上的飘动弹幕：显示发送者昵称，标注粉丝数/已关注/自定义名单/粉丝牌/等级/舰长/房管，悬停出身份卡。",
    "// @author       Loki-kiki",
    "// @homepageURL  https://github.com/" + REPO,
    "// @supportURL   https://github.com/" + REPO + "/issues",
    "// @updateURL    " + RAW,
    "// @downloadURL  " + RAW,
    "// @match        https://live.bilibili.com/*",
    "// @icon         https://static.hdslb.com/images/favicon.ico",
    "// @run-at       document-start",
    "// @grant        unsafeWindow",
    "// @grant        GM_addStyle",
    "// @grant        GM_getValue",
    "// @grant        GM_setValue",
    "// @grant        GM_registerMenuCommand",
    "// @grant        GM_setClipboard",
    "// @grant        GM_xmlhttpRequest",
    "// @connect      api.bilibili.com",
    "// @connect      api.live.bilibili.com",
    "// @connect      broadcastlv.chat.bilibili.com",
    "// @connect      *.chat.bilibili.com",
    "// @connect      i0.hdslb.com",
    "// @connect      *.hdslb.com",
    "// @license      MIT",
    "// ==/UserScript==",
    "",
  ].join("\n");

  const body = [
    "(function () {",
    '  "use strict";',
    "  const VERSION = " + JSON.stringify(version) + ";",
    parts.join("\n\n"),
    "})();",
    "",
  ].join("\n");

  const code = header + body;

  // 1) 语法检查
  new vm.Script(code, { filename: "built.user.js" });

  // 2) 版本一致性（三处：version.js / header / 代码常量）
  const codeVersion = (code.match(/const VERSION = "([^"]+)"/) || [])[1];
  const headerVersion = (header.match(/@version\s+(\S+)/) || [])[1];
  if (codeVersion !== version || headerVersion !== version) {
    throw new Error(
      `版本不一致: version.js=${version} header=${headerVersion} code=${codeVersion}`
    );
  }

  // 3) 名字与命名空间必须与基线一致（数据继承的命门）
  if (code.indexOf("// @name         " + NAME) !== 0 && code.indexOf("// @name         " + NAME) < 0) {
    throw new Error("@name 与基线不一致");
  }
  if (code.indexOf("// @namespace    " + NAMESPACE) < 0) {
    throw new Error("@namespace 与基线不一致");
  }

  // 3.5) 发布通道必须在（没有 @updateURL 装的人就永远收不到更新）
  for (const key of ["@updateURL", "@downloadURL"]) {
    const line = code.split("\n").find((l) => l.indexOf("// " + key) === 0);
    if (!line || line.indexOf(RAW) < 0) {
      throw new Error(key + " 缺失或没指向仓库 raw：" + RAW);
    }
  }

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, "bili-danmaku-nickname.user.js");
  fs.writeFileSync(out, code, "utf8");

  // 4) 回读校验（不信任内存里的字符串）
  const back = fs.readFileSync(out, "utf8");
  const backVersion = (back.match(/const VERSION = "([^"]+)"/) || [])[1];
  if (backVersion !== version) throw new Error("回读版本不一致：" + backVersion);

  const siteDir = path.join(ROOT, "tests", "site", "dist");
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, "bili-danmaku-nickname.user.js"), code, "utf8");

  const bytes = fs.statSync(out).size;
  console.log(`built ${out}: ${bytes} bytes, version ${version}`);
  return { out, bytes, version };
}

if (require.main === module) {
  try {
    build();
  } catch (err) {
    console.error("BUILD FAILED:", err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { build, ORDER };