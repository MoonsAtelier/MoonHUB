(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
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
      state.config.youtube.websocket.connections.forEach(c => {
        createWS(c.name, c.token);
      });
    }

    if (state.config.youtube?.overlay?.enabled) {
      window.addEventListener("onEventReceived", handleOverlay);
      log("overlay listener attached");
    }
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
      if (!msg.topic) return;
      log("WS message", msg.topic);
      handleWS(msg);
    });

    ws.addEventListener("close", () => {
      log("WS disconnected →", name);
    });

    ws.addEventListener("error", (err) => {
      log("WS error →", name, err);
    });

    state.sockets.push(ws);
  }

  function handleOverlay(obj) {
    if (obj.detail?.__moonhub) return;
  }

  function handleWS(msg) {
    const fake = transform(msg);
    if (!fake) return;
    log("dispatching", fake.listener);
    dispatch(fake);
  }

  function dispatch(detail) {
    detail.__moonhub = true;
    window.dispatchEvent(new CustomEvent("onEventReceived", { detail }));
  }

  function transform(msg) {
    const data = msg.data || {};

    if (msg.topic === "channel.chat.message") {
      if (!data.author?.name) return null;

      return {
        listener: "message",
        event: {
          provider: "youtube",
          nick: data.author.name,
          displayName: data.author.name,
          userId: data.author.id,
          msgId: data.id,
          text: data.message || data.content,
          avatar: data.author.avatar,
          badges: buildBadges(data.author)
        }
      };
    }

    if (msg.topic === "channel.session.update") {
      const d = data.data;
      if (!d) return null;

      const listener = mapListener(data);

      return {
        listener,
        event: {
          _id: data._id || crypto.randomUUID(),
          name: d.name,
          displayName: d.displayName || d.name,
          type: mapTypeFromListener(listener),
          amount: d.amount ?? 1,
          message: d.message ?? "",
          avatar: d.avatar,
          gifted: d.gifted ?? false,
          gift: d.gifted ?? false,
          bulkGifted: d.bulkGifted ?? false,
          originalEventName: listener,
          providerId: d.providerId || "",
          sessionTop: true
        }
      };
    }

    return null;
  }

  function mapListener(data) {
    const name = data.name || data.type || "";

    if (name.includes("superchat")) return "superchat-latest";
    if (name.includes("tip")) return "tip-latest";
    if (name.includes("communityGiftPurchase")) return "sponsor-latest";
    if (name.includes("sponsor")) return "sponsor-latest";
    if (name.includes("subscriber")) return "subscriber-latest";

    return "event";
  }

  function mapTypeFromListener(listener) {
    if (listener === "superchat-latest") return "superchat";
    if (listener === "tip-latest") return "tip";
    if (listener === "sponsor-latest") return "sub";
    if (listener === "subscriber-latest") return "follow";
    return "unknown";
  }

  function buildBadges(a) {
    const b = [];
    if (a.isChatOwner) b.push({ type: "broadcaster" });
    if (a.isChatModerator) b.push({ type: "moderator" });
    if (a.isChatSponsor) b.push({ type: "subscriber" });
    if (a.isVerified) b.push({ type: "verified" });
    return b;
  }

  function disconnect() {
    state.sockets.forEach(ws => ws.close());
    state.sockets = [];
    log("disconnected all");
  }

  return {
    init,
    connect,
    disconnect
  };
});
