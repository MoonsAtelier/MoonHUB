(function (global, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    global.MoonHub = factory();
  }
})(this, function () {
  function MoonHub(options) {
    options = options || {};
    this.listeners = { message: [], alert: [], raw: [] };
    this.emotes = {};
    this.config = {
      events: "all",
      parseEmotes: true,
      reconnectKick: true,
      kickReconnectDelay: 2000
    };
    this.connections = {
      twitch: null,
      kick: {}
    };
    this.streamElementsBound = false;
    this.init(options);
  }

  MoonHub.prototype.init = function (options) {
    options = options || {};
    if (options.events !== undefined) this.config.events = options.events;
    if (options.parseEmotes !== undefined) this.config.parseEmotes = !!options.parseEmotes;
    if (options.reconnectKick !== undefined) this.config.reconnectKick = !!options.reconnectKick;
    if (options.kickReconnectDelay !== undefined) this.config.kickReconnectDelay = Number(options.kickReconnectDelay) || 2000;
    return this;
  };

  MoonHub.prototype.setEvents = function (events) {
    this.config.events = events;
    return this;
  };

  MoonHub.prototype.getEvents = function () {
    return this.config.events;
  };

  MoonHub.prototype.on = function (type, cb) {
    (this.listeners[type] = this.listeners[type] || []).push(cb);
    return this;
  };

  MoonHub.prototype.off = function (type, cb) {
    if (!this.listeners[type]) return this;
    this.listeners[type] = this.listeners[type].filter(function (fn) {
      return fn !== cb;
    });
    return this;
  };

  MoonHub.prototype.once = function (type, cb) {
    var self = this;
    function onceWrapper(payload) {
      self.off(type, onceWrapper);
      cb(payload);
    }
    return this.on(type, onceWrapper);
  };

  MoonHub.prototype.emit = function (type, payload) {
    (this.listeners.raw || []).forEach(function (fn) { fn(payload); });
    (this.listeners[type] || []).forEach(function (fn) { fn(payload); });
    return this;
  };

  MoonHub.prototype.inject = function (event) {
    this.emit(event.type, event);
    return this;
  };

  MoonHub.prototype.escape = function (input) {
    return String(input).replace(/[&<>"']/g, function (m) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[m];
    });
  };

  MoonHub.prototype._normalizeEventList = function (events) {
    if (events === "all") return "all";
    if (!Array.isArray(events)) return [];
    var out = [];
    var seen = {};
    events.forEach(function (ev) {
      var name = String(ev || "").trim().toLowerCase();
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push(name);
    });
    return out;
  };

  MoonHub.prototype._isAllowed = function (eventName) {
    var events = this._normalizeEventList(this.config.events);
    if (events === "all") return true;
    return events.indexOf(String(eventName || "").toLowerCase()) !== -1;
  };

  MoonHub.prototype._emitIfAllowed = function (eventType, payload) {
    if (!this._isAllowed(eventType)) return;
    this.emit(payload.type, payload);
  };

  MoonHub.prototype._getTwitchId = async function (channel) {
    try {
      return await fetch("https://decapi.me/twitch/id/" + channel).then(function (r) {
        return r.text();
      });
    } catch {
      return null;
    }
  };

  MoonHub.prototype.load7TV = async function (channel) {
    try {
      var id = await this._getTwitchId(channel);
      if (!id) return;

      var results = await Promise.all([
        fetch("https://7tv.io/v3/users/twitch/" + id).then(function (r) { return r.json(); }),
        fetch("https://7tv.io/v3/emote-sets/global").then(function (r) { return r.json(); })
      ]);

      var user = results[0];
      var globalSet = results[1];

      ([
        ...(user.emote_set && user.emote_set.emotes ? user.emote_set.emotes : []),
        ...(globalSet.emotes || [])
      ]).forEach(function (e) {
        var files = e && e.data && e.data.host && e.data.host.files ? e.data.host.files : [];
        var file = files.find(function (f) {
          return String(f.name || "").includes("4x");
        }) || files[files.length - 1];
        if (!file) return;
        this.emotes[e.name] = { url: "https:" + e.data.host.url + "/" + file.name };
      }, this);
    } catch {}
  };

  MoonHub.prototype.loadBTTV = async function (channel) {
    try {
      var id = await this._getTwitchId(channel);
      if (!id) return;

      var results = await Promise.all([
        fetch("https://api.betterttv.net/3/cached/emotes/global").then(function (r) { return r.json(); }),
        fetch("https://api.betterttv.net/3/cached/users/twitch/" + id).then(function (r) { return r.json(); })
      ]);

      var globalEmotes = results[0];
      var user = results[1];

      ([]
        .concat(globalEmotes || [])
        .concat(user.channelEmotes || [])
        .concat(user.sharedEmotes || [])
      ).forEach(function (e) {
        this.emotes[e.code] = { url: "https://cdn.betterttv.net/emote/" + e.id + "/3x" };
      }, this);
    } catch {}
  };

  MoonHub.prototype.loadFFZ = async function (channel) {
    try {
      var data = await fetch("https://api.frankerfacez.com/v1/room/" + channel).then(function (r) {
        return r.json();
      });
      Object.values(data.sets || {}).forEach(function (set) {
        (set.emoticons || []).forEach(function (e) {
          var url = e.urls["4"] || e.urls["2"] || e.urls["1"];
          if (!url) return;
          this.emotes[e.name] = { url: "https:" + url };
        }, this);
      }, this);
    } catch {}
  };

  MoonHub.prototype.parseEmotes = function (text, meta) {
    meta = meta || {};
    var msg = this.escape(text);

    if (meta.emotes) {
      var chars = [...msg];
      var replacements = [];

      Object.entries(meta.emotes).forEach(function (entry) {
        var id = entry[0];
        var positions = entry[1];
        positions.forEach(function (p) {
          var parts = p.split("-").map(Number);
          var start = parts[0];
          var end = parts[1];
          replacements.push({
            start: start,
            length: end - start + 1,
            html: '<img src="https://static-cdn.jtvnw.net/emoticons/v2/' + id + '/default/light/1.0" class="emote">'
          });
        });
      });

      replacements.sort(function (a, b) { return b.start - a.start; });
      replacements.forEach(function (r) {
        chars.splice(r.start, r.length, r.html);
      });

      msg = chars.join("");
    }

    msg = msg.replace(/\[emote:(\d+):?[^\]]*\]/g, '<img src="https://files.kick.com/emotes/$1/fullsize" class="emote">');

    msg = msg.replace(/\[emoji:(\w+)\]/g, '<img src="https://dbxmjjzl5pc1g.cloudfront.net/a984b19b-fb89-450b-b4c3-6e4fadd199c9/images/emojis/$1.png" class="emote">');

    if (!this.emotes || Object.keys(this.emotes).length === 0) return msg;

    var parts = msg.split(/(<[^>]*>)/g);

    for (var i = 0; i < parts.length; i++) {
      if (i % 2 !== 0) continue;

      parts[i] = parts[i].replace(/([^\s]+)/g, function (word) {
        var clean = word.replace(/[^\w]/g, "");
        if (this.emotes[clean]) {
          return word.replace(clean, '<img src="' + this.emotes[clean].url + '" class="emote">');
        }
        return word;
      }.bind(this));
    }

    return parts.join("");
  };

  MoonHub.prototype.normalizeMessage = function (platform, user, text, extra, eventName) {
    extra = extra || {};
    return {
      type: "message",
      event: eventName || "message",
      platform: platform,
      user: {
        name: user,
        color: extra.color || "#fff"
      },
      content: {
        text: this.config.parseEmotes ? this.parseEmotes(text, extra) : this.escape(text),
        raw: text
      },
      meta: extra,
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.normalizeAlert = function (platform, name, text, raw, eventName) {
    return {
      type: "alert",
      event: eventName || "alert",
      platform: platform,
      user: { name: name },
      content: { text: text },
      meta: { raw: raw },
      timestamp: Date.now()
    };
  };

  MoonHub.prototype.normalizeRawEvent = function (platform, eventName, raw) {
    return {
      type: "raw",
      event: eventName || "raw",
      platform: platform,
      meta: { raw: raw },
      timestamp: Date.now()
    };
  };

  MoonHub.prototype._emitMessage = function (platform, user, text, extra, eventName) {
    this._emitIfAllowed(eventName || "message", this.normalizeMessage(platform, user, text, extra, eventName));
  };

  MoonHub.prototype._emitAlert = function (platform, user, text, raw, eventName) {
    this._emitIfAllowed(eventName || "alert", this.normalizeAlert(platform, user, text, raw, eventName));
  };

  MoonHub.prototype._emitRaw = function (platform, eventName, raw) {
    this._emitIfAllowed(eventName || "raw", this.normalizeRawEvent(platform, eventName, raw));
  };

  MoonHub.prototype._safeChannel = function (channel) {
    return String(channel || "").replace(/^#/, "").trim().toLowerCase();
  };

  MoonHub.prototype._safeText = function (v, fallback) {
    if (v === undefined || v === null || v === "") return fallback || "";
    return String(v);
  };

  MoonHub.prototype._bindComfyHandlers = function () {
    if (typeof ComfyJS === "undefined") return;
    var self = this;
    if (this.connections.twitch && this.connections.twitch.bound) return;

    this.connections.twitch = this.connections.twitch || {};
    this.connections.twitch.bound = true;

    ComfyJS.onChat = function (user, message, flags, selfMsg, extra) {
      if (selfMsg) return;
      self._emitMessage("twitch", user, message, {
        color: extra && extra.userColor,
        emotes: extra && extra.messageEmotes,
        flags: flags,
        raw: extra
      }, "message");
    };

    ComfyJS.onCommand = function (user, command, message, flags, extra) {
      self._emitAlert("twitch", user, "!" + command + (message ? " " + message : ""), {
        command: command,
        message: message,
        flags: flags,
        extra: extra
      }, "command");
    };

    ComfyJS.onWhisper = function (user, message, flags, selfMsg, extra) {
      if (selfMsg) return;
      self._emitAlert("twitch", user, message, {
        flags: flags,
        extra: extra
      }, "whisper");
    };

    ComfyJS.onMessageDeleted = function (id, extra) {
      self._emitAlert("twitch", "system", "Message deleted", {
        id: id,
        extra: extra
      }, "messageDeleted");
    };

    ComfyJS.onReward = function (user, reward, cost, message, extra) {
      var text = reward + (cost != null ? " (" + cost + ")" : "") + (message ? " - " + message : "");
      self._emitAlert("twitch", user, text, {
        reward: reward,
        cost: cost,
        message: message,
        extra: extra
      }, "reward");
    };

    ComfyJS.onJoin = function (user, selfMsg, extra) {
      if (selfMsg) return;
      self._emitAlert("twitch", user, "Joined chat", extra, "join");
    };

    ComfyJS.onPart = function (user, selfMsg, extra) {
      if (selfMsg) return;
      self._emitAlert("twitch", user, "Left chat", extra, "part");
    };

    ComfyJS.onHosted = function (user, viewers, autohost, extra) {
      self._emitAlert("twitch", user, "Hosted with " + (viewers || 0) + " viewers", {
        viewers: viewers,
        autohost: autohost,
        extra: extra
      }, "hosted");
    };

    ComfyJS.onBan = function (bannedUsername, extra) {
      self._emitAlert("twitch", bannedUsername, "Banned", extra, "ban");
    };

    ComfyJS.onTimeout = function (timedOutUsername, durationInSeconds, extra) {
      self._emitAlert("twitch", timedOutUsername, "Timed out for " + durationInSeconds + "s", {
        durationInSeconds: durationInSeconds,
        extra: extra
      }, "timeout");
    };

    ComfyJS.onRaid = function (user, viewers, extra) {
      self._emitAlert("twitch", user, "Raid x" + viewers, {
        viewers: viewers,
        extra: extra
      }, "raid");
    };

    ComfyJS.onCheer = function (user, message, bits, flags, extra) {
      self._emitAlert("twitch", user, "Cheer " + bits + (message ? " - " + message : ""), {
        bits: bits,
        message: message,
        flags: flags,
        extra: extra
      }, "cheer");
    };

    ComfyJS.onSub = function (user, message, subTierInfo, extra) {
      self._emitAlert("twitch", user, message || "New Sub", {
        subTierInfo: subTierInfo,
        extra: extra
      }, "sub");
    };

    ComfyJS.onResub = function (user, message, streamMonths, cumulativeMonths, subTierInfo, extra) {
      self._emitAlert("twitch", user, message || ("Resub " + cumulativeMonths + " months"), {
        streamMonths: streamMonths,
        cumulativeMonths: cumulativeMonths,
        subTierInfo: subTierInfo,
        extra: extra
      }, "resub");
    };

    ComfyJS.onSubGift = function (gifterUser, streakMonths, recipientUser, senderCount, subTierInfo, extra) {
      self._emitAlert("twitch", gifterUser, "Gifted sub to " + recipientUser, {
        streakMonths: streakMonths,
        recipientUser: recipientUser,
        senderCount: senderCount,
        subTierInfo: subTierInfo,
        extra: extra
      }, "subgift");
    };

    ComfyJS.onSubMysteryGift = function (gifterUser, numbOfSubs, senderCount, subTierInfo, extra) {
      self._emitAlert("twitch", gifterUser, "Gifted " + numbOfSubs + " subs", {
        numbOfSubs: numbOfSubs,
        senderCount: senderCount,
        subTierInfo: subTierInfo,
        extra: extra
      }, "submysterygift");
    };

    ComfyJS.onGiftSubContinue = function (user, sender, extra) {
      self._emitAlert("twitch", user, "Continued gifted sub from " + sender, {
        sender: sender,
        extra: extra
      }, "giftsubcontinue");
    };

    ComfyJS.onHypeTrain = function (state, level, progressToNextLevel, goalToNextLevel, totalHype, timeRemainingInMS, extra) {
      self._emitAlert("twitch", "system", "Hype Train " + state + " L" + level, {
        state: state,
        level: level,
        progressToNextLevel: progressToNextLevel,
        goalToNextLevel: goalToNextLevel,
        totalHype: totalHype,
        timeRemainingInMS: timeRemainingInMS,
        extra: extra
      }, "hypetrain");
    };

    ComfyJS.onShoutout = function (channelDisplayName, viewerCount, timeRemainingInMS, extra) {
      self._emitAlert("twitch", channelDisplayName, "Shoutout", {
        viewerCount: viewerCount,
        timeRemainingInMS: timeRemainingInMS,
        extra: extra
      }, "shoutout");
    };

    ComfyJS.onPoll = function (state, title, choices, votes, timeRemainingInMS, extra) {
      self._emitAlert("twitch", "system", title || ("Poll " + state), {
        state: state,
        title: title,
        choices: choices,
        votes: votes,
        timeRemainingInMS: timeRemainingInMS,
        extra: extra
      }, "poll");
    };

    ComfyJS.onPrediction = function (state, title, outcomes, topPredictors, timeRemainingInMS, extra) {
      self._emitAlert("twitch", "system", title || ("Prediction " + state), {
        state: state,
        title: title,
        outcomes: outcomes,
        topPredictors: topPredictors,
        timeRemainingInMS: timeRemainingInMS,
        extra: extra
      }, "prediction");
    };

    ComfyJS.onConnected = function (address, port, isFirstConnect) {
      self._emitAlert("twitch", "system", "Connected", {
        address: address,
        port: port,
        isFirstConnect: isFirstConnect
      }, "connected");
    };

    ComfyJS.onReconnect = function (reconnectCount) {
      self._emitAlert("twitch", "system", "Reconnect #" + reconnectCount, {
        reconnectCount: reconnectCount
      }, "reconnect");
    };

    ComfyJS.onError = function (error) {
      self._emitAlert("twitch", "system", "Error", error, "error");
    };
  };

  MoonHub.prototype.connectTwitch = async function (channel, options) {
    options = options || {};
    if (typeof ComfyJS === "undefined") return;

    channel = this._safeChannel(channel);
    if (!channel) return;

    if (options.events !== undefined) {
      this.setEvents(options.events);
    }

    await Promise.all([
      this.load7TV(channel),
      this.loadBTTV(channel),
      this.loadFFZ(channel)
    ]);

    this._bindComfyHandlers();

    this.connections.twitch.channel = channel;
    this.connections.twitch.options = options;

    var username = options.username || channel;
    var oauth = options.oauth || null;
    var channels = options.joinChannels || channel;

    ComfyJS.Init(username, oauth, channels);
    return this;
  };

  MoonHub.prototype.disconnectTwitch = function () {
    try {
      if (typeof ComfyJS !== "undefined" && typeof ComfyJS.Disconnect === "function") {
        ComfyJS.Disconnect();
      }
    } catch {}
    this.connections.twitch = null;
    return this;
  };

  MoonHub.prototype.connectStreamElements = function (options) {
    options = options || {};
    if (options.events !== undefined) {
      this.setEvents(options.events);
    }

    if (this.streamElementsBound) return this;
    this.streamElementsBound = true;

    var self = this;

    window.addEventListener("onEventReceived", function (obj) {
      var listener = obj && obj.detail ? obj.detail.listener : null;
      var event = obj && obj.detail ? obj.detail.event : null;
      if (!listener || !event) return;

      if (listener === "message") {
        var data = event.data || {};
        self._emitMessage("youtube", data.displayName, data.text, {
          color: data.displayColor,
          raw: data
        }, "message");
        return;
      }

      var type = String(listener).split("-")[0];

      var map = {
        follower: function (ev) { return "Follow"; },
        tip: function (ev) { return "Tip $" + (ev.amount || ""); },
        superchat: function (ev) { return "Superchat $" + (ev.amount || ""); },
        raid: function (ev) { return "Raid x" + (ev.amount || ""); },
        sponsor: function () { return "Member"; },
        subscription: function () { return "Subscription"; },
        redemption: function (ev) { return ev.item || "Redemption"; },
        merch: function () { return "Merch"; }
      };

      if (map[type]) {
        self._emitAlert("youtube", event.name || "unknown", map[type](event), event, type);
      } else {
        self._emitRaw("youtube", type, event);
      }
    });

    return this;
  };

  MoonHub.prototype.connectKick = function (channel, options) {
    options = options || {};
    if (options.events !== undefined) {
      this.setEvents(options.events);
    }

    channel = this._safeChannel(channel);
    if (!channel) return;

    var self = this;

    fetch("https://kick.com/api/v2/channels/" + channel)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var id = data && data.chatroom ? data.chatroom.id : null;
        if (!id) return;

        if (self.connections.kick[channel] && self.connections.kick[channel].ws) {
          try { self.connections.kick[channel].ws.close(); } catch {}
        }

        var ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679");
        self.connections.kick[channel] = { ws: ws, id: id };

        ws.onopen = function () {
          ws.send(JSON.stringify({
            event: "pusher:subscribe",
            data: { channel: "chatrooms." + id + ".v2" }
          }));
          self._emitAlert("kick", "system", "Connected", { channel: channel, roomId: id }, "connected");
        };

        ws.onmessage = function (msg) {
          try {
            var parsed = JSON.parse(msg.data);
            if (!parsed.data) return;

            if (parsed.event === "pusher:pong" || parsed.event === "pusher_internal:subscription_succeeded") {
              self._emitRaw("kick", parsed.event, parsed);
              return;
            }

            var inner = typeof parsed.data === "string" ? JSON.parse(parsed.data) : parsed.data;

            if (parsed.event === "App\\Events\\ChatMessageEvent") {
              self._emitMessage(
                "kick",
                inner.sender && inner.sender.username,
                inner.content,
                {
                  color: inner.sender && inner.sender.identity ? inner.sender.identity.color : "#fff",
                  raw: inner
                },
                "message"
              );
              return;
            }

            if (parsed.event === "App\\Events\\SubscriptionEvent") {
              self._emitAlert(
                "kick",
                inner.username || inner.sender && inner.sender.username || "unknown",
                "Subscription",
                inner,
                "sub"
              );
              return;
            }

            if (parsed.event === "App\\Events\\GiftedSubscriptionsEvent") {
              self._emitAlert(
                "kick",
                inner.gifter_username || inner.username || "unknown",
                "Gifted " + (inner.gifted_subscriptions || inner.total || inner.amount || 0) + " subs",
                inner,
                "subgift"
              );
              return;
            }

            if (parsed.event === "App\\Events\\UserBannedEvent") {
              self._emitAlert(
                "kick",
                inner.username || "unknown",
                "Banned",
                inner,
                "ban"
              );
              return;
            }

            self._emitRaw("kick", parsed.event, inner);
          } catch {}
        };

        ws.onclose = function () {
          self._emitAlert("kick", "system", "Disconnected", { channel: channel }, "disconnect");
          if (self.config.reconnectKick) {
            setTimeout(function () {
              self.connectKick(channel, options);
            }, self.config.kickReconnectDelay);
          }
        };

        ws.onerror = function (error) {
          self._emitAlert("kick", "system", "Error", error, "error");
        };
      })
      .catch(function () {});

    return this;
  };

  MoonHub.prototype.disconnectKick = function (channel) {
    channel = this._safeChannel(channel);
    if (!channel || !this.connections.kick[channel]) return this;
    try {
      if (this.connections.kick[channel].ws) {
        this.connections.kick[channel].ws.close();
      }
    } catch {}
    delete this.connections.kick[channel];
    return this;
  };

  MoonHub.prototype.disconnectAll = function () {
    this.disconnectTwitch();
    Object.keys(this.connections.kick || {}).forEach(function (channel) {
      this.disconnectKick(channel);
    }, this);
    return this;
  };

  return MoonHub;
});
