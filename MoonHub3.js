(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MoonHub = factory();
})(this, function () {

  const WS_URL = "wss://astro.streamelements.com";

  const state = {
    config: {},
    sockets: []
  };

  function log() {
    if (!state.config.debug?.enabled) return;
    console.log("[MoonHub]", ...arguments);
  }

  function init(config) {
    state.config = config || {};
    log("init", state.config);
  }

  function connect() {
    log("connecting...");

    if (state.config.youtube?.websocket?.enabled) {
      (state.config.youtube.websocket.connections || []).forEach(c => {
        createWS(c.name, c.token);
      });
    }

    if (state.config.youtube?.overlay?.enabled) {
      window.addEventListener("onEventReceived", handleOverlay);
      log("overlay listener attached");
    }
  }

  function disconnect() {
    state.sockets.forEach(ws => {
      try { ws.close(); } catch {}
    });
    state.sockets = [];
  }

  function createWS(name, token) {
    const ws = new WebSocket(WS_URL);

    const topics = [
      "channel.chat.message",
      "channel.session.update"
    ];

    ws.addEventListener("open", () => {
      log("WS connected →", name);

      topics.forEach(topic => {
        ws.send(JSON.stringify({
          type: "subscribe",
          nonce: crypto.randomUUID(),
          data: { topic, token, token_type: "apikey" }
        }));
      });
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg?.topic) return;

      const detail = transform(msg);
      if (!detail) return;

      log("dispatching", detail.listener);
      dispatch(detail);
    });

    state.sockets.push(ws);
  }

  function handleOverlay(obj) {
    if (obj.detail?.__moonhub) return;
  }

  function dispatch(detail) {
    detail.__moonhub = true;
    window.dispatchEvent(new CustomEvent("onEventReceived", { detail }));
  }

  function transform(msg) {
    if (msg.topic === "channel.chat.message") {
      return transformChat(msg);
    }

    if (msg.topic === "channel.session.update") {
      return transformEvent(msg);
    }

    return null;
  }

  function transformChat(msg) {
    const data = msg.data || {};
    const a = data.author || {};

    if (!a.name) return null;

    const username = a.name;
    const displayName = a.displayName || username;

    return {
      listener: "message",
      event: {
        provider: "youtube",
        data: {
          nick: username,
          displayName,
          userId: a.id || "",
          msgId: data.id || crypto.randomUUID(),
          text: data.message || data.content || "",
          color: null,
          isAction: false,
          badges: [],
          tags: {},
          avatar: a.avatar || "",
          authorDetails: {
            displayName,
            isChatOwner: !!a.isChatOwner,
            isChatModerator: !!a.isChatModerator,
            isChatSponsor: !!a.isChatSponsor,
            isVerified: !!a.isVerified
          }
        },

        // 🔥 EXTENDIDO
        mh: {
          platform: "youtube",
          source: "ws",
          raw: msg,
          timestamp: Date.now(),
          username,
          displayName
        }
      }
    };
  }

  function transformEvent(msg) {
    const data = msg.data || {};
    const d = data.data || {};

    const listener = mapListener(data);
    if (!listener) return null;

    const username =
      d.username ||
      d.name ||
      d.sender ||
      d.displayName ||
      "";

    const displayName =
      d.displayName ||
      username;

    const isGift = !!(d.gifted || d.gift);
    const isBulk = !!(d.bulkGifted || d.communityGiftPurchase);

    return {
      listener,
      event: {
        _id: data._id || crypto.randomUUID(),

        name: username,
        displayName,

        amount: d.amount ?? 1,
        message: d.message ?? "",
        avatar: d.avatar || "",

        type: mapType(listener),

        originalEventName: listener,
        providerId: d.providerId || "",
        sessionTop: data.sessionTop ?? false,

        // 🔥 EXTENDIDO
        mh: {
          platform: "youtube",
          source: "ws",
          raw: msg,
          timestamp: Date.now(),
          username,
          displayName,
          isGift,
          isBulk,
          listener
        }
      }
    };
  }

  function mapListener(data) {
    const name = (data.name || data.type || "").toLowerCase();

    if (name.includes("superchat")) return "superchat-latest";
    if (name.includes("tip")) return "tip-latest";
    if (name.includes("sponsor") || name.includes("gift")) return "sponsor-latest";
    if (name.includes("subscriber") || name.includes("follow")) return "subscriber-latest";

    return null;
  }

  function mapType(listener) {
    if (listener === "superchat-latest") return "superchat";
    if (listener === "tip-latest") return "tip";
    if (listener === "sponsor-latest") return "sponsor";
    if (listener === "subscriber-latest") return "subscriber";
    return "unknown";
  }

  return {
    init,
    connect,
    disconnect
  };
});
