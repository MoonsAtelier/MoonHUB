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
    if (obj?.detail?.__moonhub) return;
  }

  function dispatch(detail) {
    detail.__moonhub = true;
    const ev = new CustomEvent("onEventReceived", { detail });
    log("lib:", ev);
    window.dispatchEvent(ev);
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

    if (!author.name && !author.displayName) return null;

    const username =
      author.name ||
      author.username ||
      "";

    const displayName =
      author.displayName ||
      author.name ||
      author.username ||
      "";

    const userId =
      author.id ||
      author.channelId ||
      author.providerId ||
      author.userId ||
      "";

    const text =
      data.message ||
      data.content ||
      data.text ||
      "";

    return {
      listener: "message",
      event: {
        provider: "youtube",
        data: {
          nick: username,
          displayName,
          userId,
          msgId: data.id || crypto.randomUUID(),
          text,
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
          },
          mh: {
            source: "ws",
            topic: msg.topic,
            raw: msg
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

    const eventType = mapEventType(listener, {
      isGift,
      bulkGifted
    });

    return {
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
      raw.includes("communitygiftpurchase") ||
      raw.includes("community_gift_purchase") ||
      raw.includes("giftmembership") ||
      raw.includes("gift_membership") ||
      raw.includes("giftsponsor") ||
      raw.includes("gift_sponsor") ||
      raw.includes("sponsor")
    ) {
      return "sponsor-latest";
    }

    if (
      raw.includes("tip") ||
      raw.includes("donation")
    ) {
      return "tip-latest";
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
