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
    this.listeners = { message: [], alert: [], raw: [] };
    this.thirdPartyEmotes = [];
  }

  MoonHub.prototype.on = function (type, cb) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  };

  MoonHub.prototype.emit = function (type, payload) {
    if (this.listeners.raw) this.listeners.raw.forEach(fn => fn(payload));
    if (this.listeners[type]) this.listeners[type].forEach(fn => fn(payload));
  };

  MoonHub.prototype.escape = function (str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  MoonHub.prototype.processKickEmotes = function (text) {
    return text
      .replace(/\[emote:(\d+):?[^\]]*\]/g, '<img src="https://files.kick.com/emotes/$1/fullsize" class="emote">')
      .replace(/\[emoji:(\w+)\]/g, '<img src="https://dbxmjjzl5pc1g.cloudfront.net/a984b19b-fb89-450b-b4c3-6e4fadd199c9/images/emojis/$1.png" class="emote">');
  };

  MoonHub.prototype.processTwitchNative = function (text, emotes) {
    if (!emotes || !Object.keys(emotes).length) return text;

    let chars = [...text];
    let reps = [];

    Object.entries(emotes).forEach(([id, pos]) => {
      pos.forEach(p => {
        let [s, e] = p.split("-");
        s = +s; e = +e;
        reps.push([s, e - s + 1, id]);
      });
    });

    reps.sort((a, b) => b[0] - a[0]);

    reps.forEach(([s, l, id]) => {
      chars.splice(s, l, `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/light/1.0" class="emote">`);
    });

    return chars.join("");
  };

  MoonHub.prototype.processThirdParty = function (text) {
    let html = text;
    this.thirdPartyEmotes.forEach(e => {
      const r = new RegExp(`\\b${this.escape(e.name)}\\b`, "g");
      html = html.replace(r, `<img src="${e.url}" class="emote">`);
    });
    return html;
  };

  MoonHub.prototype.normalizeMessage = function (platform, user, text, extra) {
    let html = String(text || "");

    if (platform === "twitch") {
      html = this.processTwitchNative(html, extra && extra.emotes);
      html = this.processThirdParty(html);
    }

    if (platform === "kick") {
      html = this.processKickEmotes(html);
      html = this.processThirdParty(html);
    }

    return {
      platform,
      type: "message",
      user: {
        name: user,
        color: (extra && extra.color) || "#fff"
      },
      content: { text, html },
      meta: {
        badges: (extra && extra.badges) || "",
        raw: (extra && extra.raw) || null
      },
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.normalizeAlert = function (platform, name, text, raw) {
    return {
      platform,
      type: "alert",
      user: { name },
      content: { text },
      meta: { raw: raw || null },
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.load7TV = async function (twitchId) {
    try {
      const [c, g] = await Promise.all([
        fetch(`https://7tv.io/v3/users/twitch/${twitchId}`).then(r => r.json()),
        fetch(`https://7tv.io/v3/emote-sets/global`).then(r => r.json())
      ]);
      [...(c.emote_set?.emotes || []), ...(g.emotes || [])].forEach(e => {
        const file = e.data.host.files.find(f => f.name.includes("4x"));
        this.thirdPartyEmotes.push({
          name: e.name,
          url: "https:" + e.data.host.url + "/" + file.name
        });
      });
    } catch {}
  };

  MoonHub.prototype.loadBTTV = async function (channel) {
    try {
      const [c, g] = await Promise.all([
        fetch(`https://api.betterttv.net/3/cached/users/twitch/${channel}`).then(r => r.json()),
        fetch(`https://api.betterttv.net/3/cached/emotes/global`).then(r => r.json())
      ]);
      [...(c.channelEmotes || []), ...(c.sharedEmotes || []), ...(g || [])].forEach(e => {
        this.thirdPartyEmotes.push({
          name: e.code,
          url: `https://cdn.betterttv.net/emote/${e.id}/3x`
        });
      });
    } catch {}
  };

  MoonHub.prototype.loadFFZ = async function (channel) {
    try {
      const [c, g] = await Promise.all([
        fetch(`https://api.frankerfacez.com/v1/room/${channel}`).then(r => r.json()),
        fetch(`https://api.frankerfacez.com/v1/set/global`).then(r => r.json())
      ]);

      Object.values(c.sets || {}).forEach(set => {
        set.emoticons.forEach(e => {
          this.thirdPartyEmotes.push({
            name: e.name,
            url: e.urls["4"] || e.urls["2"]
          });
        });
      });

      Object.values(g.sets || {}).forEach(set => {
        set.emoticons.forEach(e => {
          this.thirdPartyEmotes.push({
            name: e.name,
            url: e.urls["4"] || e.urls["2"]
          });
        });
      });
    } catch {}
  };

  MoonHub.prototype.connectTwitch = async function (channel) {
    if (typeof ComfyJS === "undefined") return;

    const userRes = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${channel}`);
    const user = await userRes.json();

    await Promise.all([
      this.load7TV(user[0].id),
      this.loadBTTV(user[0].id),
      this.loadFFZ(channel)
    ]);

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
        const d = event.data;
        this.emit("message", this.normalizeMessage("youtube", d.displayName, d.text, {
          color: d.displayColor,
          raw: d
        }));
        return;
      }

      const type = listener.split("-")[0];
      const map = {
        follower: "New Follower",
        tip: `Tip $${event.amount || ""}`,
        superchat: `Superchat $${event.amount || ""}`,
        raid: `Raid x${event.amount || ""}`,
        sponsor: "New Member"
      };

      if (map[type]) {
        this.emit("alert", this.normalizeAlert("youtube", event.name || "unknown", map[type], event));
      }
    });
  };

  MoonHub.prototype.connectKick = function (channel) {
    fetch("https://kick.com/api/v2/channels/" + channel)
      .then(r => r.json())
      .then(data => {
        const id = data.chatroom.id;

        const ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false");

        ws.onopen = () => {
          ws.send(JSON.stringify({
            event: "pusher:subscribe",
            data: { channel: "chatrooms." + id + ".v2" }
          }));
        };

        ws.onmessage = (m) => {
          try {
            const p = JSON.parse(m.data);
            if (!p.data) return;
            const i = JSON.parse(p.data);

            if (p.event === "App\\Events\\ChatMessageEvent") {
              this.emit("message", this.normalizeMessage("kick", i.sender.username, i.content, {
                color: i.sender.identity.color,
                raw: i
              }));
            }

            if (p.event === "App\\Events\\SubscriptionEvent") {
              this.emit("alert", this.normalizeAlert("kick", i.username, `Sub x${i.months}`, i));
            }

            if (p.event === "App\\Events\\GiftedSubscriptionsEvent") {
              this.emit("alert", this.normalizeAlert("kick", i.gifter_username, `Gifted x${i.gifted_usernames?.length || 1}`, i));
            }

          } catch {}
        };

        ws.onclose = () => setTimeout(() => this.connectKick(channel), 2000);
      });
  };

  MoonHub.prototype.inject = function (event) {
    this.emit(event.type, event);
  };

  return MoonHub;
});
