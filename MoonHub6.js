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
      connections.forEach((c) => createWS(c.name, c.token, "youtube"));
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

  function createWS(name, token, platform = "youtube") {
    const ws = new WebSocket(WS_URL);

    const topics = [
      "channel.chat.message",
      "channel.session.update"
    ];

    ws.addEventListener("open", () => {
      log("WS connected →", name, platform);

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

      log("WS message", msg.topic, msg);

      const detail = transform(msg, platform);
      if (!detail) return;

      log("dispatching", detail.listener, detail);
      dispatch(detail);
    });

    ws.addEventListener("close", () => {
      log("WS disconnected →", name, platform);
    });

    ws.addEventListener("error", (err) => {
      log("WS error →", name, platform, err);
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

  function transform(msg, platform = "youtube") {
    if (msg.topic === "channel.chat.message") {
      return transformChatMessage(msg, platform);
    }

    if (msg.topic === "channel.session.update") {
      return transformSessionUpdate(msg, platform);
    }

    return null;
  }

  function transformChatMessage(msg, platform = "youtube") {
    const data = msg.data || {};
    const author = data.author || {};

    if (!author.name && !author.displayName && !author.username) return null;

    const username = pickFirst([
      author.name,
      author.username,
      author.login,
      author.displayName
    ]);

    const displayName = pickFirst([
      author.displayName,
      author.name,
      author.username,
      author.login
    ]);

    const userId = pickFirst([
      author.id,
      author.channelId,
      author.providerId,
      author.userId
    ]);

    const text = pickFirst([
      data.message,
      data.content,
      data.text
    ]);

    return {
      listener: "message",
      event: {
        service: platform,
        provider: platform,
        platform,
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

  function transformSessionUpdate(msg, platform = "youtube") {
    const data = msg.data || {};
    const payload = data.data || {};

    const listener = mapListener(data, payload, platform);
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
      payload.comment
    ]);

    const avatar = pickFirst([
      payload.avatar,
      data.avatar
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

    const eventId = pickFirst([
      data._id,
      payload._id,
      payload.id
    ]) || crypto.randomUUID();

    const eventType = mapEventType(listener, {
      isGift,
      bulkGifted
    });

    const event = {
      service: platform,
      provider: platform,
      platform,
      _id: eventId,
      msgId: eventId,
      type: eventType,
      name: username || "",
      displayName: displayName || "",
      amount,
      avatar: avatar || "",
      originalEventName: listener,
      providerId: providerId || "",
      sessionTop: data.sessionTop ?? payload.sessionTop ?? false
    };

    if (message) {
      event.message = message;
    }

    if (isGift) {
      event.gift = true;
      event.gifted = true;
    }

    if (bulkGifted) {
      event.bulkGifted = true;
    }

    event.data = {
      service: platform,
      provider: platform,
      platform,
      name: username || "",
      username: username || "",
      displayName: displayName || "",
      amount,
      avatar: avatar || "",
      providerId: providerId || ""
    };

    if (message) {
      event.data.message = message;
    }

    if (isGift) {
      event.data.gifted = true;
    }

    if (bulkGifted) {
      event.data.bulkGifted = true;
    }

    event.mh = {
      source: "ws",
      platform,
      topic: msg.topic,
      raw: msg
    };

    return {
      listener,
      event
    };
  }

  function mapListener(data, payload, platform = "youtube") {
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

    if (platform === "youtube") {
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
    }

    return null;
  }

  function mapEventType(listener, flags) {
    if (listener === "superchat-latest") return "superchat";
    if (listener === "tip-latest") return "tip";
    if (listener === "subscriber-latest") return "follow";
    if (listener === "sponsor-latest") {
      if (flags?.bulkGifted) return "sponsor";
      if (flags?.isGift) return "sponsor";
      return "sponsor";
    }
    return "unknown";
  }

  function pickAmount(payload, listener) {
    if (payload.amount != null) return payload.amount;
    if (payload.count != null) return payload.count;
    if (payload.quantity != null) return payload.quantity;
    if (payload.giftCount != null) return payload.giftCount;

    if (payload.amountMicros != null && !Number.isNaN(Number(payload.amountMicros))) {
      return Number(payload.amountMicros) / 1_000_000;
    }

    if (payload.amountCents != null && !Number.isNaN(Number(payload.amountCents))) {
      return Number(payload.amountCents) / 100;
    }

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
