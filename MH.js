(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MoonHub = factory();
})(this, function () {
  var DEFAULT_WS_URL = "wss://astro.streamelements.com";
  var DEFAULT_EVENT_NAME = "onEventReceived";
  var DEFAULT_TOPICS = ["channel.chat.message", "channel.activities", "channel.session.update"];
  var DEFAULT_CONFIG = {
    websocket: {
      enabled: true,
      url: DEFAULT_WS_URL,
      room: "",
      token: "",
      protocols: [],
      reconnect: true,
      reconnectDelay: 2000,
      reconnectMaxDelay: 15000,
      subscribeOnOpen: true,
      topics: DEFAULT_TOPICS.slice(),
      buildSubscribeMessage: null,
      extraSubscribeMessages: []
    },
    debug: {
      enabled: false,
      tag: "MoonHub",
      level: "debug"
    },
    dispatch: {
      enabled: true,
      target: null,
      eventName: DEFAULT_EVENT_NAME,
      chatAsMessage: true,
      latestListeners: true,
      rawEventListener: false,
      sessionUpdateListeners: false
    },
    filters: {
      chat: true,
      subscriber: true,
      sponsor: true,
      tip: true,
      superchat: true,
      communityGiftPurchase: true,
      sessionUpdate: false,
      mock: true
    },
    dedupe: {
      enabled: true,
      ttl: 15000,
      pendingMs: 350,
      chatSpecialsWaitForActivity: true
    }
  };

  var LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

  var state = {
    config: clone(DEFAULT_CONFIG),
    socket: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    connected: false,
    listeners: {},
    dedupe: {
      seen: new Map(),
      pending: new Map()
    },
    latest: {},
    stats: {
      received: 0,
      normalized: 0,
      dispatched: 0,
      dropped: 0,
      deduped: 0
    }
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function merge(target, source) {
    var out = Array.isArray(target) ? target.slice() : Object.assign({}, target || {});
    if (!source || typeof source !== "object") return out;
    Object.keys(source).forEach(function (key) {
      var sv = source[key];
      var tv = out[key];
      if (Array.isArray(sv)) out[key] = sv.slice();
      else if (sv && typeof sv === "object") out[key] = merge(tv && typeof tv === "object" ? tv : {}, sv);
      else out[key] = sv;
    });
    return out;
  }

  function now() {
    return Date.now();
  }

  function nonce() {
    return "mh_" + Math.random().toString(36).slice(2) + now().toString(36);
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function log(level) {
    var cfg = state.config.debug || {};
    if (!cfg.enabled) return;
    var wanted = LEVELS[cfg.level || "debug"];
    var current = LEVELS[level];
    if (typeof current !== "number") current = LEVELS.debug;
    if (typeof wanted !== "number") wanted = LEVELS.debug;
    if (current > wanted) return;
    var tag = "[" + (cfg.tag || "MoonHub") + "]";
    var args = Array.prototype.slice.call(arguments, 1);
    var fn = console[level] || console.log;
    try {
      fn.apply(console, [tag].concat(args));
    } catch (_) {
      console.log(tag, args.join(" "));
    }
  }

  function cleanupDedupe() {
    var ttl = ((state.config.dedupe || {}).ttl) || 15000;
    var t = now();
    state.dedupe.seen.forEach(function (value, key) {
      if (!value || t - value.ts > ttl) state.dedupe.seen.delete(key);
    });
    state.dedupe.pending.forEach(function (value, key) {
      if (!value || t - value.ts > ttl) {
        if (value && value.timer) clearTimeout(value.timer);
        state.dedupe.pending.delete(key);
      }
    });
  }

  function markSeen(key, priority, event) {
    if (!key) return;
    state.dedupe.seen.set(key, { ts: now(), priority: priority, event: event });
  }

  function getSeen(key) {
    return key ? state.dedupe.seen.get(key) : null;
  }

  function makeTextRendered(text) {
    return "<span>" + escapeHtml(text || "") + "</span>";
  }

  function chooseDisplayName(raw) {
    return raw.displayName || raw.username || raw.name || raw.nick || "";
  }

  function chooseUsername(raw) {
    return raw.username || raw.name || raw.displayName || raw.nick || "";
  }

  function pickAvatar(raw) {
    return raw.avatar || raw.profileImageUrl || raw.profileImage || "";
  }

  function priorityForSource(source) {
    if (source === "activities") return 3;
    if (source === "chat.message") return 2;
    if (source === "session.update") return 1;
    return 0;
  }

  function makeFingerprint(normalized) {
    var d = normalized.data || {};
    var userId = d.providerId || d.userId || d.channelId || "";
    var displayName = d.displayName || d.username || d.name || "";
    var amount = d.amount == null ? "" : String(d.amount);
    var currency = d.currency || "";
    var message = d.message || d.text || "";
    var bucket = Math.floor((normalized.ts || now()) / 4000);
    return [
      normalized.kind || "",
      normalized.provider || "",
      userId,
      displayName,
      amount,
      currency,
      message,
      bucket
    ].join("|");
  }

  function toLatestListener(kind) {
    if (!kind) return "";
    return kind + "-latest";
  }

  function normalizeAmountFromSuperChatDetails(details) {
    if (!details) return null;
    if (details.amountDisplayString) {
      var match = String(details.amountDisplayString).replace(/\u00a0/g, " ").match(/([0-9][0-9.,]*)/);
      if (match) {
        var raw = match[1].replace(/\./g, "").replace(/,/g, ".");
        var num = Number(raw);
        if (!isNaN(num)) return num;
      }
    }
    if (details.amountMicros != null) {
      var micros = Number(details.amountMicros);
      if (!isNaN(micros)) return micros / 1000000;
    }
    return null;
  }

  function normalizeChat(rawEnvelope) {
    var payload = rawEnvelope && rawEnvelope.data;
    if (!payload || payload.kind !== "youtube#liveChatMessage") return null;
    var snippet = payload.snippet || {};
    var author = payload.authorDetails || {};
    var kind = null;
    if (snippet.type === "textMessageEvent") kind = "chat";
    else if (snippet.type === "superChatEvent") kind = "superchat";
    else if (snippet.type === "newSponsorEvent") kind = "sponsor";
    else return null;

    var providerId = author.channelId || snippet.authorChannelId || "";
    var message = "";
    if (snippet.textMessageDetails && snippet.textMessageDetails.messageText != null) message = snippet.textMessageDetails.messageText;
    else if (snippet.displayMessage != null) message = snippet.displayMessage;

    var amount = null;
    var currency = "";
    var amountMicros = null;
    var tier = null;

    if (snippet.superChatDetails) {
      amount = normalizeAmountFromSuperChatDetails(snippet.superChatDetails);
      currency = snippet.superChatDetails.currency || "";
      amountMicros = snippet.superChatDetails.amountMicros || null;
      tier = snippet.superChatDetails.tier == null ? null : snippet.superChatDetails.tier;
    }

    var data = {
      msgId: payload.id || rawEnvelope.msgId || "",
      providerId: providerId,
      userId: providerId,
      displayName: author.displayName || rawEnvelope.displayName || "",
      username: author.displayName || rawEnvelope.nick || "",
      avatar: author.profileImageUrl || rawEnvelope.avatar || "",
      message: kind === "chat" ? (message || "") : "",
      text: kind === "chat" ? (message || "") : "",
      amount: amount,
      amountMicros: amountMicros,
      currency: currency,
      tier: tier,
      memberLevelName: snippet.newSponsorDetails && snippet.newSponsorDetails.memberLevelName || "",
      isChatSponsor: !!author.isChatSponsor,
      isModerator: !!author.isChatModerator,
      isVerified: !!author.isVerified,
      renderedText: rawEnvelope.renderedText || makeTextRendered(kind === "chat" ? message : ""),
      rawSnippetType: snippet.type
    };

    return {
      source: "chat.message",
      topic: "channel.chat.message",
      provider: rawEnvelope.service || "youtube",
      kind: kind,
      ts: payload.snippet && payload.snippet.publishedAt ? new Date(payload.snippet.publishedAt).getTime() : now(),
      createdAt: payload.snippet && payload.snippet.publishedAt || "",
      msgId: data.msgId,
      activityId: "",
      raw: rawEnvelope,
      data: data,
      priority: priorityForSource("chat.message")
    };
  }

  function normalizeActivity(activity) {
    if (!activity || !activity.type) return null;
    var kind = activity.type;
    if (["subscriber", "tip", "superchat", "sponsor", "communityGiftPurchase"].indexOf(kind) === -1) return null;

    var data = activity.data || {};
    var normalizedData = {
      providerId: data.providerId || "",
      userId: data.providerId || "",
      displayName: chooseDisplayName(data),
      username: chooseUsername(data),
      name: chooseUsername(data),
      avatar: pickAvatar(data),
      amount: data.amount == null ? null : data.amount,
      currency: data.currency || "",
      amountMicros: data.amountMicros || null,
      message: data.message || "",
      text: data.message || "",
      sender: data.sender || "",
      gifted: !!data.gifted,
      quantity: data.quantity == null ? null : data.quantity
    };

    return {
      source: "activities",
      topic: "channel.activities",
      provider: activity.provider || "youtube",
      kind: kind,
      ts: activity.createdAt ? new Date(activity.createdAt).getTime() : now(),
      createdAt: activity.createdAt || "",
      msgId: "",
      activityId: activity.activityId || activity._id || "",
      raw: activity,
      data: normalizedData,
      priority: priorityForSource("activities"),
      isMock: !!activity.isMock
    };
  }

  function normalizeSessionUpdate(message) {
    if (!message || !message.data) return null;
    var key = message.data.key || message.data.name || message.data.name || "";
    if (!key) return null;
    var baseKind = "";
    if (key.indexOf("subscriber-") === 0) baseKind = "subscriber";
    else if (key.indexOf("tip-") === 0) baseKind = "tip";
    else if (key.indexOf("superchat-") === 0) baseKind = "superchat";
    else if (key.indexOf("sponsor-") === 0) baseKind = "sponsor";
    else if (key.indexOf("communityGiftPurchase-") === 0) baseKind = "communityGiftPurchase";
    if (!baseKind) return null;

    var d = message.data.data || {};
    var normalizedData = {
      providerId: d.providerId || "",
      userId: d.providerId || "",
      displayName: d.displayName || d.name || "",
      username: d.name || d.displayName || "",
      name: d.name || "",
      avatar: d.avatar || "",
      amount: d.amount == null ? null : d.amount,
      currency: d.currency || "",
      amountMicros: d.amountMicros || null,
      message: d.message || "",
      text: d.message || "",
      sender: d.sender || "",
      gifted: !!d.gifted,
      quantity: d.quantity == null ? null : d.quantity
    };

    return {
      source: "session.update",
      topic: "channel.session.update",
      provider: message.data.provider || "youtube",
      kind: baseKind,
      latestKey: key,
      ts: message.ts ? new Date(message.ts).getTime() : now(),
      createdAt: message.ts || "",
      msgId: "",
      activityId: message.data.activityId || "",
      raw: message,
      data: normalizedData,
      priority: priorityForSource("session.update"),
      isMock: !!message.data.isMock
    };
  }

  function passesFilters(normalized) {
    if (!normalized) return false;
    var filters = state.config.filters || {};
    if (!filters.mock && normalized.isMock) return false;
    if (normalized.kind === "chat") return !!filters.chat;
    return !!filters[normalized.kind];
  }

  function shouldDropBecauseDuplicate(normalized) {
    if (!(state.config.dedupe || {}).enabled) return false;
    cleanupDedupe();

    var keys = [];
    if (normalized.activityId) keys.push("aid:" + normalized.activityId);
    if (normalized.msgId) keys.push("mid:" + normalized.msgId);
    keys.push("fp:" + makeFingerprint(normalized));

    for (var i = 0; i < keys.length; i++) {
      var seen = getSeen(keys[i]);
      if (!seen) continue;
      if (seen.priority >= normalized.priority) {
        state.stats.deduped++;
        log("debug", "duplicate dropped", normalized.kind, normalized.source, keys[i]);
        return true;
      }
    }

    keys.forEach(function (k) {
      markSeen(k, normalized.priority, normalized);
    });

    return false;
  }

  function upsertLatest(normalized) {
    if (!normalized || !normalized.kind || normalized.kind === "chat") return;
    state.latest[normalized.kind] = normalized;
  }

  function buildSEMessageEnvelope(normalized) {
    var rawEnvelope = normalized.raw || {};
    var payload = rawEnvelope.data || {};
    var data = normalized.data || {};
    var messageText = data.message || data.text || "";

    var envelope = {
      service: normalized.provider || "youtube",
      data: payload && typeof payload === "object" ? payload : {
        kind: "youtube#liveChatMessage",
        id: data.msgId || normalized.msgId || nonce(),
        snippet: {
          type: data.rawSnippetType || "textMessageEvent",
          publishedAt: normalized.createdAt || new Date(normalized.ts || now()).toISOString(),
          hasDisplayContent: true,
          displayMessage: messageText,
          textMessageDetails: { messageText: messageText }
        },
        authorDetails: {
          channelId: data.providerId || "",
          displayName: data.displayName || "",
          profileImageUrl: data.avatar || "",
          isChatSponsor: !!data.isChatSponsor,
          isChatModerator: !!data.isModerator,
          isVerified: !!data.isVerified
        },
        msgId: data.msgId || normalized.msgId || nonce(),
        userId: data.providerId || "",
        nick: data.username || data.displayName || "",
        displayName: data.displayName || "",
        text: messageText,
        avatar: data.avatar || ""
      }
    };

    if (!envelope.data.renderedText) envelope.renderedText = data.renderedText || makeTextRendered(messageText);
    return envelope;
  }

  function buildSEEventEnvelope(normalized) {
    var data = normalized.data || {};
    var base = normalized.raw && normalized.raw.type ? normalized.raw : {
      type: normalized.kind,
      provider: normalized.provider || "youtube",
      channel: "",
      createdAt: normalized.createdAt || new Date(normalized.ts || now()).toISOString(),
      data: {}
    };

    var cloned = merge({}, base);
    cloned.type = normalized.kind;
    cloned.provider = normalized.provider || cloned.provider || "youtube";
    cloned.createdAt = normalized.createdAt || cloned.createdAt || new Date(normalized.ts || now()).toISOString();
    cloned.activityId = normalized.activityId || cloned.activityId || cloned._id || "";
    cloned.data = merge(cloned.data || {}, {
      displayName: data.displayName || undefined,
      username: data.username || undefined,
      providerId: data.providerId || undefined,
      avatar: data.avatar || undefined,
      amount: data.amount,
      currency: data.currency || undefined,
      amountMicros: data.amountMicros,
      message: data.message || undefined,
      gifted: data.gifted || undefined,
      sender: data.sender || undefined,
      quantity: data.quantity
    });

    Object.keys(cloned.data).forEach(function (k) {
      if (cloned.data[k] === undefined) delete cloned.data[k];
    });

    return cloned;
  }

  function buildLatestEvent(normalized) {
    var data = normalized.data || {};
    var out = {
      name: data.username || data.name || data.displayName || "",
      displayName: data.displayName || data.username || data.name || "",
      username: data.username || data.name || data.displayName || "",
      providerId: data.providerId || "",
      avatar: data.avatar || "",
      amount: data.amount,
      currency: data.currency || "",
      amountMicros: data.amountMicros || null,
      message: data.message || "",
      gifted: !!data.gifted,
      sender: data.sender || "",
      quantity: data.quantity,
      memberLevelName: data.memberLevelName || "",
      isMock: !!normalized.isMock,
      platform: normalized.provider || "youtube",
      raw: normalized.raw
    };

    Object.keys(out).forEach(function (k) {
      if (out[k] === undefined || out[k] === null || out[k] === "") {
        if (k === "amount" || k === "quantity" || k === "gifted" || k === "isMock" || k === "raw") return;
        delete out[k];
      }
    });

    return out;
  }

  function getDispatchTarget() {
    return state.config.dispatch && state.config.dispatch.target || (typeof window !== "undefined" ? window : null);
  }

  function dispatchPayload(listener, eventObj) {
    if (!(state.config.dispatch || {}).enabled) return;
    var target = getDispatchTarget();
    if (!target || typeof target.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return;
    var eventName = state.config.dispatch.eventName || DEFAULT_EVENT_NAME;
    var detail = { listener: listener, event: eventObj };
    target.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
    state.stats.dispatched++;
    log("debug", "dispatch", listener, eventObj && eventObj.type ? eventObj.type : "");
  }

  function emitInternal(name, payload) {
    var fns = state.listeners[name];
    if (!fns || !fns.length) return;
    fns.slice().forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        log("error", "listener error", name, err);
      }
    });
  }

  function dispatchNormalized(normalized) {
    var dispatchCfg = state.config.dispatch || {};
    upsertLatest(normalized);

    if (normalized.kind === "chat" && dispatchCfg.chatAsMessage) {
      dispatchPayload("message", buildSEMessageEnvelope(normalized));
    }

    if (normalized.kind !== "chat" && dispatchCfg.latestListeners) {
      dispatchPayload(toLatestListener(normalized.kind), buildLatestEvent(normalized));
    }

    if (normalized.kind !== "chat" && dispatchCfg.rawEventListener) {
      dispatchPayload("event", buildSEEventEnvelope(normalized));
    }

    emitInternal(normalized.kind, normalized);
    emitInternal("*", normalized);
  }

  function resolvePendingKey(normalized) {
    if (normalized.activityId) return "aid:" + normalized.activityId;
    return "fp:" + makeFingerprint(normalized);
  }

  function flushPending(key) {
    var item = state.dedupe.pending.get(key);
    if (!item) return;
    if (item.timer) clearTimeout(item.timer);
    state.dedupe.pending.delete(key);
    if (item.event) {
      if (!shouldDropBecauseDuplicate(item.event)) {
        state.stats.normalized++;
        dispatchNormalized(item.event);
      }
    }
  }

  function cancelPendingFor(normalized) {
    var keys = [];
    if (normalized.activityId) keys.push("aid:" + normalized.activityId);
    keys.push("fp:" + makeFingerprint(normalized));
    keys.forEach(function (key) {
      var item = state.dedupe.pending.get(key);
      if (item) {
        if (item.timer) clearTimeout(item.timer);
        state.dedupe.pending.delete(key);
        log("debug", "pending canceled by stronger event", key, normalized.kind);
      }
    });
  }

  function schedulePending(normalized) {
    var key = resolvePendingKey(normalized);
    var pendingMs = ((state.config.dedupe || {}).pendingMs) || 350;
    var timer = setTimeout(function () {
      flushPending(key);
    }, pendingMs);
    state.dedupe.pending.set(key, { event: normalized, ts: now(), timer: timer });
    log("trace", "pending scheduled", key, normalized.kind);
  }

  function shouldDelayChatSpecial(normalized) {
    var dedupeCfg = state.config.dedupe || {};
    if (!dedupeCfg.chatSpecialsWaitForActivity) return false;
    if (normalized.source !== "chat.message") return false;
    return normalized.kind === "superchat" || normalized.kind === "sponsor";
  }

  function processNormalized(normalized) {
    if (!normalized) return;
    if (!passesFilters(normalized)) {
      state.stats.dropped++;
      log("trace", "filtered", normalized.kind, normalized.source);
      return;
    }

    if (normalized.source === "activities") cancelPendingFor(normalized);

    if (normalized.source === "session.update" && !(state.config.dispatch || {}).sessionUpdateListeners) {
      upsertLatest(normalized);
      emitInternal("session.update", normalized);
      emitInternal("*", normalized);
      return;
    }

    if (shouldDelayChatSpecial(normalized)) {
      schedulePending(normalized);
      return;
    }

    if (shouldDropBecauseDuplicate(normalized)) return;

    state.stats.normalized++;
    dispatchNormalized(normalized);
  }

  function handleWSMessage(message) {
    state.stats.received++;
    if (!message) return;

    if (typeof message === "string") {
      if (message === "ws_open") {
        log("info", "ws open marker");
        return;
      }
      try {
        message = JSON.parse(message);
      } catch (_) {
        log("trace", "non-json message", message);
        return;
      }
    }

    if (!message || typeof message !== "object") return;

    if (message.type === "welcome") {
      log("info", "welcome");
      return;
    }

    if (message.type === "response") {
      log("debug", "response", message.data && message.data.topic || "", message.data && message.data.message || "");
      return;
    }

    if (message.type !== "message") {
      log("trace", "ignored message type", message.type);
      return;
    }

    var normalized = null;

    if (message.topic === "channel.chat.message") normalized = normalizeChat(message.data);
    else if (message.topic === "channel.activities") normalized = normalizeActivity(message.data);
    else if (message.topic === "channel.session.update") normalized = normalizeSessionUpdate(message);

    if (!normalized) {
      log("trace", "unhandled topic payload", message.topic);
      return;
    }

    log("trace", "normalized", normalized.kind, normalized.source, normalized.activityId || normalized.msgId || "");
    processNormalized(normalized);
  }

  function sendRaw(payload) {
    if (!state.socket || state.socket.readyState !== 1) return false;
    try {
      state.socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch (err) {
      log("error", "send failed", err);
      return false;
    }
  }

  function buildDefaultSubscribeMessage(topic) {
    var ws = state.config.websocket || {};
    return {
      type: "subscribe",
      nonce: nonce(),
      data: {
        topic: topic,
        room: ws.room || "",
        token: ws.token || ""
      }
    };
  }

  function subscribeTopics() {
    var ws = state.config.websocket || {};
    var topics = ws.topics || [];
    var builder = typeof ws.buildSubscribeMessage === "function" ? ws.buildSubscribeMessage : null;
    topics.forEach(function (topic) {
      var payload = builder ? builder(topic, state.config) : buildDefaultSubscribeMessage(topic);
      if (payload) {
        sendRaw(payload);
        log("debug", "subscribing", topic);
      }
    });
    (ws.extraSubscribeMessages || []).forEach(function (payload) {
      sendRaw(payload);
    });
  }

  function clearReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    var ws = state.config.websocket || {};
    if (!ws.reconnect) return;
    clearReconnect();
    state.reconnectAttempts++;
    var delay = Math.min((ws.reconnectDelay || 2000) * Math.pow(1.5, Math.max(0, state.reconnectAttempts - 1)), ws.reconnectMaxDelay || 15000);
    state.reconnectTimer = setTimeout(function () {
      connect();
    }, delay);
    log("warn", "reconnect scheduled", Math.round(delay) + "ms");
  }

  function connect() {
    var ws = state.config.websocket || {};
    if (!ws.enabled) {
      log("warn", "websocket disabled");
      return false;
    }
    disconnect(false);

    var SocketCtor = typeof WebSocket !== "undefined" ? WebSocket : null;
    if (!SocketCtor) {
      log("error", "WebSocket unavailable");
      return false;
    }

    try {
      state.socket = new SocketCtor(ws.url || DEFAULT_WS_URL, ws.protocols || []);
    } catch (err) {
      log("error", "socket create failed", err);
      scheduleReconnect();
      return false;
    }

    state.socket.onopen = function () {
      state.connected = true;
      state.reconnectAttempts = 0;
      clearReconnect();
      log("info", "connected", ws.url || DEFAULT_WS_URL);
      emitInternal("open", {});
      if (ws.subscribeOnOpen !== false) subscribeTopics();
    };

    state.socket.onmessage = function (ev) {
      handleWSMessage(ev && ev.data);
    };

    state.socket.onerror = function (err) {
      log("error", "socket error", err);
      emitInternal("error", err);
    };

    state.socket.onclose = function (ev) {
      state.connected = false;
      log("warn", "socket closed", ev && ev.code, ev && ev.reason);
      emitInternal("close", ev || {});
      scheduleReconnect();
    };

    return true;
  }

  function disconnect(cancelReconnect) {
    if (cancelReconnect !== false) clearReconnect();
    if (state.socket) {
      try {
        state.socket.onopen = null;
        state.socket.onmessage = null;
        state.socket.onerror = null;
        state.socket.onclose = null;
        if (state.socket.readyState === 0 || state.socket.readyState === 1) state.socket.close();
      } catch (_) {}
    }
    state.socket = null;
    state.connected = false;

    state.dedupe.pending.forEach(function (item) {
      if (item && item.timer) clearTimeout(item.timer);
    });
    state.dedupe.pending.clear();
  }

  function init(config) {
    state.config = merge(DEFAULT_CONFIG, config || {});
    if (!state.config.dispatch.target && typeof window !== "undefined") state.config.dispatch.target = window;
    log("info", "init");
    return api;
  }

  function destroy() {
    disconnect(true);
    state.dedupe.seen.clear();
    state.dedupe.pending.clear();
    state.listeners = {};
    state.latest = {};
    state.stats = { received: 0, normalized: 0, dispatched: 0, dropped: 0, deduped: 0 };
    return api;
  }

  function on(name, handler) {
    if (!name || typeof handler !== "function") return api;
    if (!state.listeners[name]) state.listeners[name] = [];
    state.listeners[name].push(handler);
    return api;
  }

  function off(name, handler) {
    if (!name || !state.listeners[name]) return api;
    if (!handler) {
      delete state.listeners[name];
      return api;
    }
    state.listeners[name] = state.listeners[name].filter(function (fn) { return fn !== handler; });
    if (!state.listeners[name].length) delete state.listeners[name];
    return api;
  }

  function emitRaw(input) {
    handleWSMessage(input);
    return api;
  }

  function dispatchLatest(kind) {
    var normalized = state.latest[kind];
    if (!normalized) return false;
    dispatchPayload(toLatestListener(kind), buildLatestEvent(normalized));
    return true;
  }

  function getLatest(kind) {
    return kind ? state.latest[kind] || null : merge({}, state.latest);
  }

  function getStats() {
    return merge({}, state.stats);
  }

  function isConnected() {
    return !!state.connected;
  }

  function configure(patch) {
    state.config = merge(state.config, patch || {});
    return api;
  }

  var api = {
    init: init,
    configure: configure,
    connect: connect,
    disconnect: disconnect,
    destroy: destroy,
    on: on,
    off: off,
    emitRaw: emitRaw,
    dispatchLatest: dispatchLatest,
    getLatest: getLatest,
    getStats: getStats,
    isConnected: isConnected,
    sendRaw: sendRaw,
    version: "1.0.0"
  };

  return api;
});
