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

    log("dispatching transformed event", fake.listener, fake.event?.type);
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

    if (msg.topic === "channel.activities") {
      return {
        listener: "event",
        event: {
          service: "youtube",
          type: mapType(data),
          data: {
            displayName: data.displayName || data.username,
            username: data.username,
            amount: data.amount,
            sender: data.sender,
            gifted: data.gifted,
            avatar: data.avatar
          }
        }
      };
    }

    if (msg.topic === "channel.session.update") {
      return {
        listener: "session",
        event: {
          service: "youtube",
          data
        }
      };
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
    if (d.type === "subscriber" || d.type === "sponsor") {
      return d.gifted ? "gifted-sub" : "sub";
    }
    if (d.type === "communityGiftPurchase") return "gift-subs";
    if (d.type === "superchat") return "superchat";
    if (d.type === "tip") return "tip";
    return d.type || "unknown";
  }

  function disconnect() {
    state.sockets.forEach(ws => ws.close());
    state.sockets = [];
    log("disconnected all sockets");
  }

  return {
    init,
    connect,
    disconnect
  };
});
