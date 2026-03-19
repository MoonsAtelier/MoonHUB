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
      const connections = state.config.youtube.websocket.connections || [];
      connections.forEach((c) => createWS(c.name, c.token));
    }

    if (state.config.youtube?.overlay?.enabled) {
      window.addEventListener("onEventReceived", handleOverlay);
      log("overlay listener attached");
    }
  }

  function disconnect() {
    state.sockets.forEach((ws) => {
      try {
        ws.close();
      } catch {}
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
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!msg || !msg.topic) return;

      log("WS message", msg.topic);

      const detail = transform(msg);
      if (!detail) return;

      log("dispatching", detail.listener);
      dispatch(detail);
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

  function dispatch(detail) {
    detail.__moonhub = true;
    window.dispatchEvent(new CustomEvent("onEventReceived", { detail }));
  }

  function transform(msg) {
    if (msg.topic === "channel.chat.message") {
      return transformChatMessage(msg);
    }

    if (msg.topic === "channel.session.update") {
      return transformSessionUpdate(msg);
    }

    return null;
  }

  function transformChatMessage(msg) {
    const data = msg.data || {};
    const author = data.author || {};

    if (!author.name) return null;

    const displayName = author.displayName || author.name || "";
    const username = author.name || "";
    const userId = author.id || author.channelId || author.providerId || "";
    const messageText = data.message || data.content || data.text || "";

    return {
      listener: "message",
      event: {
        provider: "youtube",
        data: {
          nick: username,
          displayName,
          userId,
          msgId: data.id || crypto.randomUUID(),
          text: messageText,
          color: null,
          isAction: false,
          badges: [],
          tags: {},
          avatar: author.avatar || "",
          authorDetails: {
            displayName,
            isChatOwner: !!author.isChatOwner,
            isChatModerator: !!author.isChatModerator,
            isChatSponsor: !!author.isChatSponsor,
            isVerified: !!author.isVerified
          }
        }
      }
    };
  }

  function transformSessionUpdate(msg) {
    const data = msg.data || {};
    const payload = data.data || {};
    const listener = mapListener(data, payload);

    if (!listener) return null;

    const username =
      payload.username ||
      payload.name ||
      payload.user ||
      payload.sender ||
      payload.displayName ||
      "";

    const displayName =
      payload.displayName ||
      payload.username ||
      payload.name ||
      payload.sender ||
      "";

    const isGift =
      payload.gift === true ||
      payload.gifted === true ||
      payload.isGift === true ||
      payload.isGifted === true;

    const bulkGifted =
      payload.bulkGifted === true ||
      payload.isCommunityGift === true ||
      payload.communityGiftPurchase === true ||
      payload.giftCount > 1;

    return {
      listener,
      event: {
        _id: data._id || payload._id || crypto.randomUUID(),
        provider: "youtube",
        type: mapEventType(listener, { gift: isGift, bulkGifted }),
        name: username,
        displayName,
        amount: payload.amount ?? payload.count ?? payload.quantity ?? 1,
        message: payload.message ?? "",
        avatar: payload.avatar || "",
        gifted: isGift,
        gift: isGift,
        bulkGifted,
        originalEventName: listener,
        providerId: payload.providerId || payload.channelId || "",
        sessionTop: payload.sessionTop ?? true
      }
    };
  }

  function mapListener(data, payload) {
    const raw = String(
      data.name ||
      data.event ||
      data.type ||
      payload.type ||
      payload.event ||
      ""
    ).toLowerCase();

    if (!raw) return null;

    if (
      raw.includes("superchat") ||
      raw.includes("super_chat") ||
      raw.includes("paidmessage") ||
      raw.includes("paid_message")
    ) {
      return "superchat-latest";
    }

    if (
      raw.includes("tip") ||
      raw.includes("donation")
    ) {
      return "tip-latest";
    }

    if (
      raw.includes("communitygiftpurchase") ||
      raw.includes("community_gift_purchase") ||
      raw.includes("giftmembership") ||
      raw.includes("gift_membership") ||
      raw.includes("giftsub") ||
      raw.includes("gift_sub") ||
      raw.includes("sponsor")
    ) {
      return "sponsor-latest";
    }

    if (
      raw.includes("subscriber") ||
      raw.includes("subscription") ||
      raw.includes("follow")
    ) {
      return "subscriber-latest";
    }

    return null;
  }

  function mapEventType(listener, flags) {
    if (listener === "superchat-latest") return "superchat";
    if (listener === "tip-latest") return "tip";
    if (listener === "subscriber-latest") return "follow";
    if (listener === "sponsor-latest") {
      if (flags?.gift || flags?.bulkGifted) return "sub";
      return "sub";
    }
    return "unknown";
  }

  return {
    init,
    connect,
    disconnect
  };
});
