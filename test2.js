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

  function log(...args) {
    if (!state.config.debug?.enabled) return;
    console.log("[MoonHub]", ...args);
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
      "channel.activities",
      "channel.session.update"
    ];

    ws.addEventListener("open", () => {
      log(`WS connected → ${name}`);

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
      try { msg = JSON.parse(event.data); } catch {
        log("invalid JSON", event.data);
        return;
      }

      if (!msg.topic) return;

      log("WS message", msg.topic);
      handleWS(msg);
    });

    ws.addEventListener("close", () => {
      log(`WS disconnected → ${name}`);
    });

    ws.addEventListener("error", (err) => {
      log(`WS error → ${name}`, err);
    });

    state.sockets.push(ws);
  }

  function handleOverlay(obj) {
    if (obj.detail?.__moonhub) return;
    log("overlay event", obj.detail?.listener);
  }

  function handleWS(msg) {
    const fake = transform(msg);
    if (!fake) return;

    log("dispatching", fake.listener, fake.event?.type);
    dispatch(fake);
  }

  function dispatch(detail) {
    detail.__moonhub = true;
    window.dispatchEvent(new CustomEvent("onEventReceived", { detail }));
  }

  function transform(msg) {
    const data = msg.data || {};

    // 💬 CHAT
    if (msg.topic === "channel.chat.message") {
      if (!data.author?.name) return null;

      return {
        listener: "message",
        event: {
          service: "youtube",
          data: {
            displayName: data.author.name,
            nick: data.author.name,
            userId: data.author.id,
            msgId: data.id,
            text: data.message || data.content,
            avatar: data.author.avatar,
            badges: buildBadges(data.author)
          }
        }
      };
    }

    // 🚨 ALERTS
    if (msg.topic === "channel.activities") {
      const role = mapType(data);

      return {
        listener: "event",
        event: {
          service: "youtube",
          type: role,
          data: {
            displayName: data.displayName || data.username,
            username: data.username,
            amount: data.amount || 1,
            sender: data.sender,
            gifted: data.gifted,
            avatar: data.avatar
          }
        }
      };
    }

    // ⚙️ SESSION (ignorado para UI)
    if (msg.topic === "channel.session.update") {
      return null;
    }

    return null;
  }

  function buildBadges(a) {
    const b = [];

    if (a.isChatOwner) b.push({ type: "broadcaster" });
    if (a.isChatModerator) b.push({ type: "moderator" });
    if (a.isChatSponsor) b.push({ type: "subscriber" });
    if (a.isVerified) b.push({ type: "verified" });

    return b;
  }

  function mapType(d) {
    if (!d?.type) return "unknown";

    switch (d.type) {
      case "subscriber":
      case "sponsor":
        return d.gifted ? "gifted-sub" : "sub";

      case "communityGiftPurchase":
        return "gift-subs";

      case "superchat":
        return "superchat";

      case "tip":
        return "tip";

      case "follow":
        return "follow";

      default:
        return d.type;
    }
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
