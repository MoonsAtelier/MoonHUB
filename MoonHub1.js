(function (global, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    global.MoonHub = factory();
  }
})(this, function () {
  function MoonHub(config) {
    this.config = config || {};
    this.listeners = {
      message: [],
      alert: [],
      raw: []
    };
  }

  MoonHub.prototype.on = function (type, cb) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  };

  MoonHub.prototype.emit = function (type, payload) {
    if (this.listeners.raw) {
      this.listeners.raw.forEach(fn => fn(payload));
    }
    if (this.listeners[type]) {
      this.listeners[type].forEach(fn => fn(payload));
    }
  };

  MoonHub.prototype.processKickEmotes = function (text) {
    if (!text) return text;

    text = text.replace(
      /\[emote:(\d+):?[^\]]*\]/g,
      '<img src="https://files.kick.com/emotes/$1/fullsize" class="emote">'
    );

    text = text.replace(
      /\[emoji:(\w+)\]/g,
      '<img src="https://dbxmjjzl5pc1g.cloudfront.net/a984b19b-fb89-450b-b4c3-6e4fadd199c9/images/emojis/$1.png" class="emote">'
    );

    return text;
  };

  MoonHub.prototype.processTwitchEmotes = function (text, emotes) {
    if (!text || !emotes || !Object.keys(emotes).length) return text;

    let msgChars = [...text];
    let replacements = [];

    Object.entries(emotes).forEach(([id, positions]) => {
      positions.forEach(p => {
        let [start, end] = p.split("-");
        start = parseInt(start);
        end = parseInt(end);
        replacements.push([start, end - start + 1, id]);
      });
    });

    replacements.sort((a, b) => b[0] - a[0]);

    replacements.forEach(([start, length, id]) => {
      const html = `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/light/1.0" class="emote">`;
      msgChars.splice(start, length, html);
    });

    return msgChars.join("");
  };

  MoonHub.prototype.normalizeMessage = function (platform, user, text, extra) {
    let html = text;

    if (platform === "kick") {
      html = this.processKickEmotes(text);
    }

    if (platform === "twitch") {
      html = this.processTwitchEmotes(text, extra && extra.emotes);
    }

    return {
      platform: platform,
      type: "message",
      user: {
        name: user,
        color: (extra && extra.color) || "#fff"
      },
      content: {
        text: text,
        html: html
      },
      meta: {
        badges: (extra && extra.badges) || "",
        emotes: (extra && extra.emotes) || [],
        raw: (extra && extra.raw) || null
      },
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.normalizeAlert = function (platform, name, text, raw) {
    return {
      platform: platform,
      type: "alert",
      user: {
        name: name
      },
      content: {
        text: text
      },
      meta: {
        raw: raw || null
      },
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.use = function (plugin) {
    plugin(this);
  };

  MoonHub.prototype.connectTwitch = function (channel) {
    if (typeof ComfyJS === "undefined") return;

    ComfyJS.Init(channel);

    ComfyJS.onChat = (user, message, flags, self, extra) => {
      if (self) return;

      const normalized = this.normalizeMessage("twitch", user, message, {
        color: extra.userColor,
        emotes: extra.messageEmotes,
        raw: extra
      });

      this.emit("message", normalized);
    };
  };

  MoonHub.prototype.connectStreamElements = function () {
    window.addEventListener("onEventReceived", (obj) => {
      const listener = obj.detail.listener;
      const event = obj.detail.event;

      if (listener === "message") {
        const data = event.data;

        const normalized = this.normalizeMessage(
          "youtube",
          data.displayName,
          data.text,
          {
            color: data.displayColor,
            badges: data.badges,
            raw: data
          }
        );

        this.emit("message", normalized);
        return;
      }

      const type = listener.split("-")[0];

      const map = {
        follower: "New Follower",
        tip: event.amount ? `Tip $${event.amount}` : "Tip",
        superchat: event.amount ? `Superchat $${event.amount}` : "Superchat",
        raid: event.amount ? `Raid x${event.amount}` : "Raid",
        sponsor: "New Member"
      };

      if (map[type]) {
        const normalized = this.normalizeAlert(
          "youtube",
          event.name || "unknown",
          map[type],
          event
        );

        this.emit("alert", normalized);
      }
    });
  };

  MoonHub.prototype.connectKick = function (channel) {
    fetch("https://kick.com/api/v2/channels/" + channel)
      .then(r => {
        if (!r.ok) throw new Error("Kick API failed");
        return r.json();
      })
      .then(data => {
        if (!data.chatroom || !data.chatroom.id) {
          throw new Error("Invalid Kick chatroom");
        }

        const chatroomId = data.chatroom.id;

        const ws = new WebSocket(
          "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false"
        );

        ws.onopen = () => {
          ws.send(JSON.stringify({
            event: "pusher:subscribe",
            data: {
              channel: "chatrooms." + chatroomId + ".v2"
            }
          }));
        };

        ws.onmessage = (msg) => {
          try {
            const parsed = JSON.parse(msg.data);
            if (!parsed.data) return;

            const inner = JSON.parse(parsed.data);

            if (parsed.event === "App\\Events\\ChatMessageEvent") {
              const normalized = this.normalizeMessage(
                "kick",
                inner.sender.username,
                inner.content,
                {
                  color: inner.sender.identity.color,
                  raw: inner
                }
              );
              this.emit("message", normalized);
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

          } catch (e) {}
        };

        ws.onerror = () => {
          console.error("MoonHub Kick WS error");
        };

        ws.onclose = () => {
          setTimeout(() => this.connectKick(channel), 2000);
        };
      })
      .catch(() => {
        setTimeout(() => this.connectKick(channel), 3000);
      });
  };

  MoonHub.prototype.inject = function (event) {
    if (event.type === "message") this.emit("message", event);
    if (event.type === "alert") this.emit("alert", event);
  };

  return MoonHub;
});
