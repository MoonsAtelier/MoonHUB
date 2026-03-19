(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MoonHub = factory();
})(this, function () {
  const WS_URL = "wss://astro.streamelements.com";

  const state = {
    config: {},
    sockets: [],
    overlayBound: false
  };

  function log() {
    if (!state.config.debug?.enabled) return;
    console.log("[MoonHub]", ...arguments);
  }

  function wsLog() {
    if (!state.config.debug?.enabled) return;
    console.log("[WSmoon]", ...arguments);
  }

  function init(config) {
    state.config = config || {};
    log("init", state.config);
  }

  function connect() {
    log("connecting...");

    if (state.config.youtube?.websocket?.enabled) {
      const connections = state.config.youtube.websocket.connections || [];
      connections.forEach((c) => createWS(c.name, c.token));
    }

    if (state.config.youtube?.overlay?.enabled && !state.overlayBound) {
      window.addEventListener("onEventReceived", handleOverlay);
      state.overlayBound = true;
      log("overlay listener attached");
    }
  }

  function disconnect() {
    state.sockets.forEach((ws) => {
      try { ws.close(); } catch {}
    });
    state.sockets = [];
    log("disconnected all");
  }

  function createWS(name, token) {
    const ws = new WebSocket(WS_URL);

    const topics = [
      "channel.chat.message",
      "channel.session.update"
    ];

    ws.addEventListener("open", () => {
      log("WS connected →", name);

      topics.forEach((topic) => {
        ws.send(JSON.stringify({
          type: "subscribe",
          nonce: crypto.randomUUID(),
          data: {
            topic,
            token,
            token_type: "apikey"
          }
        }));
      });
    });

    ws.addEventListener("message", (event) => {
      wsLog("📥 RAW STRING:", event.data);

      let msg;

      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        wsLog("❌ JSON PARSE ERROR:", err);
        return;
      }

      wsLog("📦 PARSED:", msg);

      if (!msg || !msg.topic) {
        wsLog("⚠️ IGNORE: no topic");
        return;
      }

      wsLog("📡 TOPIC:", msg.topic);

      const detail = transform(msg);

      wsLog("🔧 TRANSFORM RESULT:", detail);

      if (!detail) {
        wsLog("⚠️ TRANSFORM NULL (descartado)");
        return;
      }

      wsLog("🚀 DISPATCHING:", detail.listener, detail);

      dispatch(detail);
    });

    ws.addEventListener("close", () => {
      log("WS disconnected →", name);
    });

    ws.addEventListener("error", (err) => {
      wsLog("🔥 WS ERROR:", err);
      log("WS error →", name, err);
    });

    state.sockets.push(ws);
  }

  function handleOverlay(obj) {
    if (obj?.detail?.__moonhub) return;
  }

  function dispatch(detail) {
    detail.__moonhub = true;
    const ev = new CustomEvent("onEventReceived", { detail });

    wsLog("📤 EVENT EMITTED:", ev);

    window.dispatchEvent(ev);
  }

  function transform(msg) {
    wsLog("🔍 TRANSFORM ENTRY:", msg.topic);

    if (msg.topic === "channel.chat.message") {
      return transformChatMessage(msg);
    }

    if (msg.topic === "channel.session.update") {
      return transformSessionUpdate(msg);
    }

    wsLog("⚠️ UNKNOWN TOPIC:", msg.topic);
    return null;
  }

  function transformChatMessage(msg) {
    const data = msg.data?.data || msg.data || {};

    wsLog("💬 CHAT DATA:", data);

    const displayName =
      data.displayName ||
      data.authorDetails?.displayName ||
      "";

    const username =
      data.nick ||
      data.authorDetails?.displayName ||
      displayName ||
      "";

    const userId =
      data.userId ||
      data.authorDetails?.channelId ||
      "";

    const text =
      data.text ||
      data.message ||
      data.snippet?.displayMessage ||
      data.snippet?.textMessageDetails?.messageText ||
      "";

    if (!displayName || !text) {
      wsLog("❌ CHAT DESCARTADO:", { displayName, text, data });
      return null;
    }

    const result = {
      listener: "message",
      event: {
        provider: "youtube",
        data: {
          nick: username,
          displayName,
          userId,
          msgId: data.msgId || data.id || crypto.randomUUID(),
          text,
          color: null,
          isAction: false,
          badges: [],
          tags: {},
          avatar:
            data.avatar ||
            data.authorDetails?.profileImageUrl ||
            "",
          authorDetails: data.authorDetails || {},
          mh: {
            source: "ws",
            topic: msg.topic,
            raw: msg
          }
        }
      }
    };

    wsLog("✅ CHAT TRANSFORM OK:", result);

    return result;
  }

  function transformSessionUpdate(msg) {
    const data = msg.data || {};
    const payload = data.data || {};

    wsLog("🎯 SESSION RAW:", { data, payload });

    const listener = mapListener(data, payload);

    if (!listener) {
      wsLog("❌ SESSION IGNORADA: no listener match", { data, payload });
      return null;
    }

    const username = pickFirst([
      payload.name,
      payload.username,
      payload.user,
      payload.sender,
      payload.login,
      payload.displayName
    ]);

    const displayName = pickFirst([
      payload.displayName,
      payload.name,
      payload.username,
      payload.user,
      payload.sender,
      payload.login
    ]);

    const providerId = pickFirst([
      payload.providerId,
      payload.channelId,
      payload.userId,
      payload.id
    ]);

    const amount = pickAmount(payload, listener);

    const message = pickFirst([
      payload.message,
      payload.text,
      payload.comment,
      ""
    ]);

    const isGift =
      payload.gift === true ||
      payload.gifted === true ||
      payload.isGift === true ||
      payload.isGifted === true;

    const bulkGifted =
      payload.bulkGifted === true ||
      payload.isCommunityGift === true ||
      payload.communityGiftPurchase === true ||
      Number(payload.giftCount || 0) > 1 ||
      Number(payload.quantity || 0) > 1;

    const eventId =
      data._id ||
      payload._id ||
      payload.id ||
      crypto.randomUUID();

    const eventType = mapEventType(listener);

    const result = {
      listener,
      event: {
        provider: "youtube",
        _id: eventId,
        msgId: eventId,
        type: eventType,
        name: username || "",
        displayName: displayName || "",
        amount,
        message,
        avatar: payload.avatar || "",
        originalEventName: listener,
        providerId: providerId || "",
        sessionTop: data.sessionTop ?? payload.sessionTop ?? false,
        gift: isGift,
        gifted: isGift,
        bulkGifted,
        data: {
          name: username || "",
          username: username || "",
          displayName: displayName || "",
          amount,
          message,
          avatar: payload.avatar || "",
          gifted: isGift,
          bulkGifted,
          providerId: providerId || ""
        },
        mh: {
          source: "ws",
          platform: "youtube",
          topic: msg.topic,
          raw: msg
        }
      }
    };

    wsLog("✅ SESSION TRANSFORM OK:", result);

    return result;
  }

  function mapListener(data, payload) {
    const raw = String(
      data.name ||
      data.event ||
      data.type ||
      payload.name ||
      payload.type ||
      payload.event ||
      ""
    ).toLowerCase();

    wsLog("🧠 MAP LISTENER RAW:", raw);

    if (!raw) return null;

    if (raw.includes("superchat")) return "superchat-latest";
    if (raw.includes("sponsor") || raw.includes("gift")) return "sponsor-latest";
    if (raw.includes("tip") || raw.includes("donation")) return "tip-latest";
    if (raw.includes("subscriber") || raw.includes("follow")) return "subscriber-latest";

    return null;
  }

  function mapEventType(listener) {
    if (listener === "superchat-latest") return "superchat";
    if (listener === "tip-latest") return "tip";
    if (listener === "subscriber-latest") return "follow";
    if (listener === "sponsor-latest") return "sponsor";
    return "unknown";
  }

  function pickAmount(payload, listener) {
    if (payload.amount != null) return payload.amount;
    if (payload.count != null) return payload.count;
    if (payload.quantity != null) return payload.quantity;
    if (payload.giftCount != null) return payload.giftCount;
    if (listener === "sponsor-latest") return 1;
    if (listener === "subscriber-latest") return 1;
    return 1;
  }

  function pickFirst(values) {
    for (const v of values) {
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
  }

  return {
    init,
    connect,
    disconnect
  };
});
