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

  // =============================
  // UTIL
  // =============================

  MoonHub.prototype.escape = function (input) {
    return String(input).replace(/[&<>"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  };

  // Evita reemplazar dentro de HTML
  MoonHub.prototype.safeReplace = function (text, replacer) {
    return text
      .split(/(<[^>]*>)/g)
      .map((part, i) => i % 2 === 0 ? replacer(part) : part)
      .join('');
  };

  // =============================
  // EMOTES LOADING
  // =============================

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
            url: "https:" + e.urls["4"]
          };
        });
      });
    } catch {}
  };

  // =============================
  // EMOTE PARSER (CORE)
  // =============================

  MoonHub.prototype.parseEmotes = function (text, meta = {}) {
    let msg = this.escape(text);

    // -------- TWITCH NATIVE (posición) --------
    if (meta.emotes) {
      let chars = [...msg];
      let replacements = [];

      Object.entries(meta.emotes).forEach(([id, positions]) => {
        positions.forEach(p => {
          let [start, end] = p.split("-").map(Number);
          replacements.push({
            start,
            length: end - start + 1,
            html: `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/light/1.0" class="emote">`
          });
        });
      });

      replacements.sort((a, b) => b.start - a.start);
      replacements.forEach(r => {
        chars.splice(r.start, r.length, r.html);
      });

      msg = chars.join("");
    }

    // -------- KICK EMOTES --------
    msg = msg.replace(/\[emote:(\d+):?[^\]]*\]/g,
      `<img src="https://files.kick.com/emotes/$1/fullsize" class="emote">`
    );

    msg = msg.replace(/\[emoji:(\w+)\]/g,
      `<img src="https://dbxmjjzl5pc1g.cloudfront.net/a984b19b-fb89-450b-b4c3-6e4fadd199c9/images/emojis/$1.png" class="emote">`
    );

    // -------- 7TV / BTTV / FFZ --------
    msg = this.safeReplace(msg, (plain) => {
      Object.keys(this.emotes).forEach(name => {
        const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${safe}\\b`, "g");

        plain = plain.replace(regex,
          `<img src="${this.emotes[name].url}" class="emote">`
        );
      });
      return plain;
    });

    return msg;
  };

  // =============================
  // NORMALIZE
  // =============================

  MoonHub.prototype.normalizeMessage = function (platform, user, text, extra) {
    const parsed = this.parseEmotes(text, extra);

    return {
      type: "message",
      platform,
      user: {
        name: user,
        color: (extra && extra.color) || "#fff"
      },
      content: {
        text: parsed,
        raw: text
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

  // =============================
  // TWITCH
  // =============================

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
  };

  // =============================
  // KICK
  // =============================

  MoonHub.prototype.connectKick = function (channel) {
    fetch(`https://kick.com/api/v2/channels/${channel}`)
      .then(r => r.json())
      .then(data => {
        const id = data.chatroom.id;

        const ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679");

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
          } catch {}
        };

        ws.onclose = () => setTimeout(() => this.connectKick(channel), 2000);
      });
  };

  return MoonHub;
});
