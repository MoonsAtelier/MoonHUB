(function (global, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    global.MoonHub = factory();
  }
})(this, function () {

  function MoonHub() {
    this.listeners = { message: [], alert: [], raw: [] };
    this.emotes = {};
  }

  MoonHub.prototype.on = function (type, cb) {
    (this.listeners[type] = this.listeners[type] || []).push(cb);
  };

  MoonHub.prototype.emit = function (type, payload) {
    (this.listeners.raw || []).forEach(fn => fn(payload));
    (this.listeners[type] || []).forEach(fn => fn(payload));
  };

  MoonHub.prototype.inject = function (event) {
    this.emit(event.type, event);
  };

  // ===== EMOTES =====

  MoonHub.prototype._getTwitchId = async function (channel) {
    try {
      return await fetch(`https://decapi.me/twitch/id/${channel}`).then(r => r.text());
    } catch {
      return null;
    }
  };

  MoonHub.prototype.load7TV = async function (channel) {
    try {
      const id = await this._getTwitchId(channel);
      if (!id) return;

      const [user, global] = await Promise.all([
        fetch(`https://7tv.io/v3/users/twitch/${id}`).then(r => r.json()),
        fetch(`https://7tv.io/v3/emote-sets/global`).then(r => r.json())
      ]);

      [...(user.emote_set?.emotes || []), ...(global.emotes || [])].forEach(e => {
        const file = e.data.host.files.find(f => f.name.includes("4x"));
        if (!file) return;
        this.emotes[e.name] = {
          name: e.name,
          url: "https:" + e.data.host.url + "/" + file.name
        };
      });
    } catch {}
  };

  MoonHub.prototype.loadBTTV = async function (channel) {
    try {
      const id = await this._getTwitchId(channel);
      if (!id) return;

      const [global, user] = await Promise.all([
        fetch(`https://api.betterttv.net/3/cached/emotes/global`).then(r => r.json()),
        fetch(`https://api.betterttv.net/3/cached/users/twitch/${id}`).then(r => r.json())
      ]);

      [...global, ...(user.channelEmotes || []), ...(user.sharedEmotes || [])].forEach(e => {
        this.emotes[e.code] = {
          name: e.code,
          url: `https://cdn.betterttv.net/emote/${e.id}/3x`
        };
      });
    } catch {}
  };

  MoonHub.prototype.loadFFZ = async function (channel) {
    try {
      const data = await fetch(`https://api.frankerfacez.com/v1/room/${channel}`).then(r => r.json());
      Object.values(data.sets).forEach(set => {
        set.emoticons.forEach(e => {
          this.emotes[e.name] = {
            name: e.name,
            url: "https:" + e.urls["4"]
          };
        });
      });
    } catch {}
  };

  // ===== NORMALIZE =====

  MoonHub.prototype.normalizeMessage = function (platform, user, text, extra) {
    return {
      type: "message",
      platform,
      user: {
        name: user,
        color: (extra && extra.color) || "#fff"
      },
      content: {
        text: String(text || "")
      },
      meta: extra || {},
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.normalizeAlert = function (platform, name, text, raw) {
    return {
      type: "alert",
      platform,
      user: { name },
      content: { text },
      meta: { raw },
      timestamp: Date.now()
    };
  };

  // ===== TWITCH =====

  MoonHub.prototype.connectTwitch = async function (channel) {
    if (typeof ComfyJS === "undefined") return;

    await Promise.all([
      this.load7TV(channel),
      this.loadBTTV(channel),
      this.loadFFZ(channel)
    ]);

    ComfyJS.Init(channel);

    ComfyJS.onChat = (user, message, flags, self, extra) => {
      if (self) return;
      this.emit("message", this.normalizeMessage("twitch", user, message, {
        color: extra.userColor,
        emotes: extra.messageEmotes,
        raw: extra
      }));
    };

    ComfyJS.onSub = (user, message, subTierInfo) => {
      this.emit("alert", this.normalizeAlert("twitch", user, "New Sub", subTierInfo));
    };

    ComfyJS.onResub = (user, message, streakMonths, cumulativeMonths) => {
      this.emit("alert", this.normalizeAlert("twitch", user, `Resub x${cumulativeMonths}`, { streakMonths }));
    };

    ComfyJS.onSubGift = (gifter, streak, recipient) => {
      this.emit("alert", this.normalizeAlert("twitch", gifter, `Gifted → ${recipient}`, { streak }));
    };

    ComfyJS.onSubMysteryGift = (gifter, count) => {
      this.emit("alert", this.normalizeAlert("twitch", gifter, `Gifted x${count}`, {}));
    };

    ComfyJS.onCheer = (user, message, bits) => {
      this.emit("alert", this.normalizeAlert("twitch", user, `Bits x${bits}`, {}));
    };

    ComfyJS.onRaid = (user, viewers) => {
      this.emit("alert", this.normalizeAlert("twitch", user, `Raid x${viewers}`, {}));
    };

    ComfyJS.onJoin = (user) => {
      this.emit("raw", { type: "join", platform: "twitch", user });
    };
  };

  // ===== STREAM ELEMENTS =====

  MoonHub.prototype.connectStreamElements = function () {
    window.addEventListener("onEventReceived", (obj) => {
      const listener = obj.detail.listener;
      const event = obj.detail.event;

      if (listener === "message") {
        const data = event.data;

        this.emit("message", this.normalizeMessage(
          "youtube",
          data.displayName,
          data.text,
          { color: data.displayColor, raw: data }
        ));
        return;
      }

      const type = listener.split("-")[0];

      const map = {
        follower: "Follow",
        tip: `Tip $${event.amount || ""}`,
        superchat: `Superchat $${event.amount || ""}`,
        raid: `Raid x${event.amount || ""}`,
        sponsor: "Member"
      };

      if (map[type]) {
        this.emit("alert", this.normalizeAlert(
          "youtube",
          event.name || "unknown",
          map[type],
          event
        ));
      }
    });
  };

  // ===== KICK =====

  MoonHub.prototype.connectKick = function (channel) {
    fetch(`https://kick.com/api/v2/channels/${channel}`)
      .then(r => r.json())
      .then(data => {
        const id = data.chatroom.id;

        const ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js");

        ws.onopen = () => {
          ws.send(JSON.stringify({
            event: "pusher:subscribe",
            data: { channel: `chatrooms.${id}.v2` }
          }));
        };

        ws.onmessage = (msg) => {
          try {
            const parsed = JSON.parse(msg.data);
            if (!parsed.data) return;

            const inner = JSON.parse(parsed.data);

            if (parsed.event === "App\\Events\\ChatMessageEvent") {
              this.emit("message", this.normalizeMessage(
                "kick",
                inner.sender.username,
                inner.content,
                {
                  color: inner.sender.identity.color,
                  raw: inner
                }
              ));
            }

            if (parsed.event === "App\\Events\\SubscriptionEvent") {
              this.emit("alert", this.normalizeAlert(
                "kick",
                inner.username,
                `Sub x${inner.months}`,
                inner
              ));
            }

            if (parsed.event === "App\\Events\\GiftedSubscriptionsEvent") {
              this.emit("alert", this.normalizeAlert(
                "kick",
                inner.gifter_username,
                `Gifted x${inner.gifted_usernames?.length || 1}`,
                inner
              ));
            }

          } catch {}
        };

        ws.onclose = () => setTimeout(() => this.connectKick(channel), 2000);
      });
  };

  return MoonHub;
});
