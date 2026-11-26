// ===== 协议层：HTTP / WBI 签名 / WS 弹幕流 =====
// 本层完全沿用 v1.0.41 里跑通的实现（WBI 签名、protover 2、心跳、重连），只把回调解耦出去。

function requestJson(url) {
  return new Promise((resolve, reject) => {
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        anonymous: false,
        withCredentials: true,
        timeout: 8000,
        headers: { Referer: "https://live.bilibili.com/" },
        onload: (res) => {
          const status = Number(res && res.status) || 0;
          // ★ B站 风控有两种形态，必须都认：
          //   ① JSON 里 code: -412（接口层限流）
          //   ② HTTP 412 + HTML 响应体（网关层拦截，实测 api.bilibili.com 直接返回 <!DOCTYPE html>）
          //   只认 ① 的话，② 会被当成「bad json」计入 apiFail，退避机制永远不触发 ——
          //   真机实测：一个房间 314 次请求 293 次失败，全是 412 打回来的 HTML。
          if (status === 412 || status === 429) {
            const riskErr = new Error("http risk " + status);
            riskErr.riskCode = -412;
            reject(riskErr);
            return;
          }
          const text = typeof res.responseText === "string" ? res.responseText : String(res.response || "");
          if (!text) {
            reject(new Error("empty response: " + url));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error("bad json: " + url));
          }
        },
        onerror: (err) => reject(new Error("request error: " + url + " " + ((err && err.status) || ""))),
        ontimeout: () => reject(new Error("request timeout: " + url)),
      });
    } catch (err) {
      reject(err);
    }
  });
}

function shortError(err) {
  const text = String((err && err.message) || err || "unknown");
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

function getRoomIdFromUrl() {
  const m = location.pathname.match(/^\/(\d+)/);
  return m ? m[1] : "";
}

function getRealRoomId(id) {
  return requestJson("https://api.live.bilibili.com/room/v1/Room/room_init?id=" + encodeURIComponent(id)).then(
    (json) => (json && json.code === 0 && json.data && json.data.room_id ? Number(json.data.room_id) : Number(id))
  );
}

// ===== WBI 签名（getDanmuInfo 必须带）=====
const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function extractFileKey(url) {
  const m = String(url || "").match(/\/([^/?#]+)\.(?:png|jpg|webp)$/);
  return m ? m[1] : "";
}

function getWbiKeys() {
  if (state.wbi && Date.now() - state.wbi.ts < 30 * 60 * 1000) return Promise.resolve(state.wbi);
  return requestJson("https://api.bilibili.com/x/web-interface/nav").then((json) => {
    const img = json && json.data && json.data.wbi_img;
    const imgKey = extractFileKey(img && img.img_url);
    const subKey = extractFileKey(img && img.sub_url);
    if (!imgKey || !subKey) throw new Error("Wbi keys missing");
    state.wbi = { imgKey, subKey, ts: Date.now() };
    return state.wbi;
  });
}

function wbiQuery(params) {
  return getWbiKeys().then(({ imgKey, subKey }) => {
    const mixinKey = WBI_MIXIN_TABLE.map((n) => `${imgKey}${subKey}`[n]).join("").slice(0, 32);
    const signed = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
    const query = Object.keys(signed)
      .sort()
      .map((key) => {
        const value = String(signed[key]).replace(/[!'()*]/g, "");
        return encodeURIComponent(key) + "=" + encodeURIComponent(value);
      })
      .join("&");
    return query + "&w_rid=" + md5(query + mixinKey);
  });
}

function getDanmuConfFallback(roomId) {
  return requestJson(
    "https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=" + encodeURIComponent(roomId) + "&platform=pc&player=web"
  ).then((json) => {
    if (!json || json.code !== 0 || !json.data) throw new Error("getConf failed (" + (json && json.code) + ")");
    const d = json.data;
    return {
      token: d.token || "",
      host_list: normalizeHostList(d.host_server_list || d.host_list || [{ host: d.host, wss_port: d.wss_port }]),
    };
  });
}

function getDanmuInfo(roomId) {
  const endpoint = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
  const validate = (json, tag) => {
    if (!json || Number(json.code) !== 0 || !json.data) {
      throw new Error(tag + " getDanmuInfo failed (" + (json && json.code) + ")");
    }
    return json.data;
  };
  // 签到（WBI）→ 不签名 → getConf，三级兜底；三级都要真正「拿到 data」才算成功
  return wbiQuery({ id: roomId, type: 0 })
    .then((query) => requestJson(endpoint + "?" + query))
    .then((json) => validate(json, "signed"))
    .catch((err) => {
      state.stats.signedErr = shortError(err);
      return requestJson(endpoint + "?id=" + encodeURIComponent(roomId) + "&type=0").then((json) => validate(json, "unsigned"));
    })
    .catch((err) => {
      state.stats.connectErr = shortError(err);
      return getDanmuConfFallback(roomId);
    });
}

// ===== 房间信息（主播名/标题）=====
function extractRoomTitle() {
  try {
    const t = (document.title || "").replace(/\s*[-—–]\s*哔哩哔哩.*$/, "");
    const parts = t.split(/[-—–]/);
    if (parts.length >= 2) return parts.slice(0, -1).join("-").trim();
    return t.trim();
  } catch (_) {
    return "";
  }
}

function applyRoomInfo(uid, name, title) {
  if (!uid) return;
  const prev = state.room || {};
  state.room = {
    uid: Number(uid) || prev.uid || 0,
    name: name || prev.name || "",
    title: title || prev.title || "",
  };
}

function updateRoomInfo() {
  const neptune = W.__NEPTUNE_IS_MY_WAIFU__;
  try {
    const info = neptune && neptune.roomInfoRes && neptune.roomInfoRes.data;
    if (info && info.uid) {
      applyRoomInfo(info.uid, String(info.uname || ""), String(info.title || extractRoomTitle()));
      if (state.room.name) return;
    }
    const init = neptune && neptune.roomInitRes && neptune.roomInitRes.data;
    if (init && init.uid) {
      let uname = "";
      const parts = (document.title || "").split(" - ");
      if (parts.length >= 3) uname = parts[parts.length - 2].trim();
      if (!uname) {
        const el = document.querySelector(".room-owner-name, .anchor-name, .initiator-name, [class*='anchor']");
        if (el) uname = (el.textContent || "").trim();
      }
      applyRoomInfo(init.uid, uname, extractRoomTitle());
    }
  } catch (_) {}

  // 已有主播名就不再请求；请求中/刚失败也不重发（recordHighlight 每条命中都会调到这里）
  if (state.room.uid && state.room.name) return;
  if (roomInfoInflight || Date.now() - roomInfoLastTry < 30000) return;
  const roomId = getRoomIdFromUrl();
  if (!roomId) return;
  roomInfoInflight = true;
  roomInfoLastTry = Date.now();
  // ★ get_info 只给 uid/title，不给 uname（2026-11 实测）→ 主播名另用 Master/info 按 uid 取
  requestJson("https://api.live.bilibili.com/room/v1/Room/get_info?room_id=" + encodeURIComponent(roomId))
    .then((json) => {
      if (json && json.code === 0 && json.data && json.data.uid) {
        applyRoomInfo(json.data.uid, String(json.data.uname || ""), String(json.data.title || ""));
      }
      if (state.room.uid && !state.room.name) {
        return fetchUpName(state.room.uid).then((name) => {
          if (name) applyRoomInfo(state.room.uid, name, "");
        });
      }
    })
    .catch(() => {})
    .then(() => {
      roomInfoInflight = false;
    });
}

let roomInfoInflight = false;
let roomInfoLastTry = 0;
const upNameCache = new Map(); // uid → Promise<string>

/** 按 UP 主 uid 取昵称（Master/info，免签名免登录）；失败返回 ""，失败结果不缓存 */
function fetchUpName(uid) {
  const key = String(uid || "");
  if (!key || key === "0") return Promise.resolve("");
  if (upNameCache.has(key)) return upNameCache.get(key);
  const p = requestJson("https://api.live.bilibili.com/live_user/v1/Master/info?uid=" + encodeURIComponent(key))
    .then((json) => {
      const name = (json && json.code === 0 && json.data && json.data.info && json.data.info.uname) || "";
      if (!name) upNameCache.delete(key);
      return String(name);
    })
    .catch(() => {
      upNameCache.delete(key);
      return "";
    });
  upNameCache.set(key, p);
  return p;
}

// ===== 自家 WS 客户端（不劫持页面，独立连接）=====
function pickDanmakuHost(info) {
  const hosts = normalizeHostList(info && (info.host_list || info.host_server_list));
  if (!hosts.length) return { host: "broadcastlv.chat.bilibili.com", wss_port: 443 };
  const idx = state.sockets.hostCursor % hosts.length;
  state.stats.selector = hosts[idx].host;
  return hosts[idx];
}

function normalizeHostList(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || !item.host) continue;
    const host = String(item.host);
    const key = host;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, wss_port: 443 });
  }
  if (!out.length) out.push({ host: "broadcastlv.chat.bilibili.com", wss_port: 443 });
  return out;
}

function sendPacket(ws, operation, body) {
  if (!ws || ws.readyState !== 1) return;
  const encoded = new TextEncoder().encode(body || "");
  const packetLen = 16 + encoded.length;
  const buffer = new ArrayBuffer(packetLen);
  const view = new DataView(buffer);
  view.setUint32(0, packetLen);
  view.setUint16(4, 16);
  view.setUint16(6, 1);
  view.setUint32(8, operation);
  view.setUint32(12, 1);
  new Uint8Array(buffer, 16).set(encoded);
  ws.send(buffer);
}

function getCookie(name) {
  const re = new RegExp("(?:^|; )" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)");
  const m = document.cookie.match(re);
  return m ? decodeURIComponent(m[1]) : "";
}

function closeSocket() {
  clearInterval(state.sockets.heartbeat);
  const ws = state.sockets.live;
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch (_) {}
  }
  state.sockets.live = null;
}

function scheduleReconnect(reason) {
  clearTimeout(state.sockets.reconnect);
  state.stats.source = reason || "已断开，5秒后重连";
  state.sockets.reconnect = setTimeout(startDanmakuClient, 5000);
}

function startDanmakuClient() {
  if (!state.settings || !state.settings.enabled) return;
  clearTimeout(state.sockets.reconnect);
  closeSocket();
  updateRoomInfo();

  const roomIdFromUrl = getRoomIdFromUrl();
  if (!roomIdFromUrl) {
    state.stats.source = "未识别房间号";
    return;
  }
  state.stats.source = "连接中";

  getRealRoomId(roomIdFromUrl)
    .then((roomId) => getDanmuInfo(roomId).then((info) => ({ roomId, info })))
    .then(({ roomId, info }) => connectDanmakuServer(roomId, info))
    .catch((err) => {
      state.stats.source = "连接失败：" + shortError(err);
      state.sockets.hostCursor += 1;
      scheduleReconnect(state.stats.source);
      log("danmaku client init failed", err);
    });
}

function connectDanmakuServer(roomId, info) {
  closeSocket();
  const host = pickDanmakuHost(info);
  const url = "wss://" + host.host + ":" + (host.wss_port || 443) + "/sub";
  let ws;
  try {
    ws = new W.WebSocket(url);
  } catch (err) {
    scheduleReconnect("WS 构造失败：" + shortError(err));
    return;
  }
  state.sockets.live = ws;
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    if (state.sockets.live !== ws) return;
    state.stats.source = "已连接，等待弹幕";
    sendPacket(ws, 7, JSON.stringify({
      uid: Number(getCookie("DedeUserID") || 0),
      roomid: roomId,
      protover: 2,
      buvid: getCookie("buvid3") || getCookie("buvid4") || "",
      platform: "web",
      type: 2,
      key: (info && info.token) || "",
    }));
    clearInterval(state.sockets.heartbeat);
    state.sockets.heartbeat = setInterval(() => sendPacket(ws, 2, ""), 30000);
    sendPacket(ws, 2, "");
    log("danmaku connected", url, roomId);
  };
  ws.onmessage = (event) => consumeWsData(event.data);
  ws.onerror = () => {
    if (state.sockets.live === ws) state.stats.source = "连接异常";
  };
  ws.onclose = () => {
    if (state.sockets.live !== ws) return;
    clearInterval(state.sockets.heartbeat);
    state.sockets.live = null;
    state.sockets.hostCursor += 1;
    scheduleReconnect("已断开，5秒后重连");
  };
}

function consumeWsData(data) {
  try {
    if (data instanceof ArrayBuffer) parsePackets(data);
    else if (data instanceof Blob) data.arrayBuffer().then(parsePackets, () => {});
  } catch (_) {}
}

function parsePackets(buffer) {
  if (!buffer || buffer.byteLength < 16) return;
  const view = new DataView(buffer);
  let offset = 0;
  while (offset + 16 <= buffer.byteLength) {
    const packetLen = view.getUint32(offset);
    const headerLen = view.getUint16(offset + 4);
    const version = view.getUint16(offset + 6);
    const operation = view.getUint32(offset + 8);
    if (packetLen < headerLen || packetLen <= 0 || offset + packetLen > buffer.byteLength) break;
    state.stats.packets += 1;
    if (operation === 5) {
      state.stats.msgPackets += 1;
      if (state.stats.captured === 0) state.stats.source = "收到弹幕包";
      parseBody(buffer.slice(offset + headerLen, offset + packetLen), version);
    } else if (operation === 8) {
      state.stats.source = "鉴权成功";
    } else if (operation === 3) {
      state.stats.source = state.stats.captured > 0 ? "已接收弹幕" : "已连接，等待弹幕";
    }
    offset += packetLen;
  }
}

function parseBody(body, version) {
  if (version === 0 || version === 1) {
    parseJsonText(decodeUtf8(body));
    return;
  }
  if (version === 2) {
    decompress(body, "deflate")
      .then(parsePackets)
      .catch(() =>
        decompress(body, "deflate-raw").then(parsePackets, (err) => {
          state.stats.inflateFail += 1;
          debugLog("inflate-fail", { err: shortError(err), bytes: body.byteLength });
        })
      );
    return;
  }
  if (version === 3) {
    // 浏览器原生 DecompressionStream 不支持 br；protover:2 已让服务端不发 br，此计数应恒为 0
    state.stats.brotli += 1;
  }
}

function decodeUtf8(buffer) {
  return new TextDecoder("utf-8").decode(new Uint8Array(buffer));
}

function decompress(buffer, format) {
  if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("DecompressionStream unsupported"));
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format));
  return new Response(stream).arrayBuffer();
}

function parseJsonText(text) {
  if (!text) return;
  const parts = text.indexOf("\u0000") >= 0 ? text.split("\u0000") : [text];
  for (const part of parts) {
    const s = part.trim();
    if (!s) continue;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch (_) {
      state.stats.jsonFail += 1;
      continue;
    }
    if (!msg || typeof msg.cmd !== "string") continue;
    const short = msg.cmd.slice(0, 24);
    state.stats.cmds[short] = (state.stats.cmds[short] || 0) + 1;
    try {
      if (msg.cmd.indexOf("DANMU_MSG") === 0) handleDanmakuPacket(msg);
      else if (msg.cmd === "INTERACT_WORD" || msg.cmd === "INTERACT_WORD_V2") handleInteractPacket(msg);
    } catch (err) {
      state.stats.handleFail += 1;
      if (state.stats.handleFail <= 3) warn("handle packet failed", short, err);
    }
  }
}