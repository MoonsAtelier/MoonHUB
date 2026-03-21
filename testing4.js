(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ChatCore = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const Utils = {
        htmlEncode(text) {
            return text.replace(/[<>"^]/g, (e) => `&#${e.charCodeAt(0)};`);
        },

        async fetchJSON(url) {
            return await fetch(url)
                .then(res => res.ok ? res.json() : null)
                .catch(() => null);
        }
    };

    class TwitchEmoteProcessor {
        constructor(settings) {
            this.settings = settings;
        }

        isRemainingTextEmpty(data) {
            let { text, emotes } = data;
            if (emotes && emotes.length > 0) {
                emotes.forEach((emote) => {
                    text = text.replace(emote.name, '');
                });
            }
            return text;
        }

        process(message, renderedText, messageData) {
            let text = Utils.htmlEncode(message.text);
            const data = message.emotes || [];
            const emoteCount = data.length;
            const rendertext = renderedText.renderedText;
            const result = this.isRemainingTextEmpty(messageData);

            if (message.attachment?.media?.image?.src) {
                text = `${message.text}<img src="${message.attachment.media.image.src}">`;
            }

            const messageType = (rendertext === undefined || result.trim() === "") ? "solo emote" : "msg-emote";
            let emoteClass = "emote-1";

            if (messageType === "solo emote" && this.settings.chat.emotes) {
                if (emoteCount >= 1 && emoteCount <= 4) emoteClass = "emote-2";
                else if (emoteCount >= 5 && emoteCount <= 8) emoteClass = "emote-3";
                else if (emoteCount > 8) emoteClass = "emote-4";
            }

            return text.replace(/([^\s]*)/gi, (m, key) => {
                const found = data.find(e => Utils.htmlEncode(e.name) === key);
                if (!found) return key;
                const url = found.urls?.[4] || found.urls?.[1];
                if (!url) return key;
                return `<img class="${emoteClass}" src="${url}"/>`;
            });
        }
    }

    class YouTubeEmoteProcessor {
        constructor(settings) {
            this.settings = settings;
            this.cachedExternalEmotes = null;
        }

        async process(message, renderedText, messageData) {
            let text = message.text;
            const rendertext = renderedText.renderedText;

            if (message.attachment?.media?.image?.src) {
                text = `${message.text}<img src="${message.attachment.media.image.src}">`;
            }

            const localEmotes = this.getLocalEmotes();
            const externalEmotes = await this.getExternalEmotes();
            const allEmotes = [...localEmotes, ...externalEmotes];

            const { totalCount, remainingText } = this.countEmotes(text, allEmotes);
            const messageType = rendertext === undefined || remainingText === "" ? "solo emote" : "msg-emote";
            const emoteClass = this.getEmoteClass(messageType, totalCount);

            return this.replaceEmotes(text, allEmotes, emoteClass);
        }

        getLocalEmotes() {
            const localEmotes = [];
            const data = this.settings.emotesYT?.data || {};

            for (const [, emoteData] of Object.entries(data)) {
                if (Array.isArray(emoteData.shortcuts) && typeof emoteData.image === "string") {
                    emoteData.shortcuts.forEach(shortcut => {
                        localEmotes.push({
                            shortcut: shortcut,
                            image: emoteData.image
                        });
                    });
                }
            }

            return localEmotes;
        }

        async getExternalEmotes() {
            if (this.cachedExternalEmotes) return this.cachedExternalEmotes;

            try {
                const data = await Utils.fetchJSON("https://raw.githubusercontent.com/Jocando21/Lottie-Repo/refs/heads/main/emotes.json");
                this.cachedExternalEmotes = (data || []).flatMap(e => {
                    if (!e.shortcuts || !e.image?.thumbnails?.[0]?.url) return [];
                    return e.shortcuts.map(shortcut => ({
                        shortcut: shortcut,
                        image: e.image.thumbnails[0].url
                    }));
                });
            } catch {
                this.cachedExternalEmotes = [];
            }

            return this.cachedExternalEmotes;
        }

        countEmotes(text, allEmotes) {
            let totalCount = 0;
            let textWithoutEmotes = text;

            allEmotes.forEach(emote => {
                const regex = new RegExp(emote.shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                const matches = text.match(regex);
                if (matches) {
                    totalCount += matches.length;
                    textWithoutEmotes = textWithoutEmotes.replace(regex, '');
                }
            });

            return { totalCount, remainingText: textWithoutEmotes.trim() };
        }

        getEmoteClass(messageType, totalCount) {
            let emoteClass = "emote-1";

            if (messageType === "solo emote" && this.settings.chat.emotes && this.settings.emotesYT?.mode !== "hidden") {
                if (totalCount >= 1 && totalCount <= 4) emoteClass = "emote-2";
                else if (totalCount >= 5 && totalCount <= 8) emoteClass = "emote-3";
                else if (totalCount > 8) emoteClass = "emote-4";
            }

            return emoteClass;
        }

        replaceEmotes(text, allEmotes, emoteClass) {
            let result = text;
            const emotePlaceholders = [];

            allEmotes.forEach((emote, index) => {
                const escapedShortcut = emote.shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedShortcut, 'g');
                const placeholder = `___EMOTE_${index}___`;

                result = result.replace(regex, placeholder);

                emotePlaceholders.push({
                    placeholder: placeholder,
                    html: `<img class="${emoteClass}" src="${emote.image}" alt="${emote.shortcut}" />`
                });
            });

            result = Utils.htmlEncode(result);

            emotePlaceholders.forEach(item => {
                result = result.replace(new RegExp(item.placeholder, 'g'), item.html);
            });

            return result;
        }
    }

    class PronounsManager {
        constructor(settings) {
            this.settings = settings;
        }

        async loadPronouns() {
            const res = await Utils.fetchJSON(this.settings.pronouns.api.pronouns);
            if (!res) return;
            res.forEach(p => {
                this.settings.pronouns.list[p.name] = p.display;
            });
        }

        async getUserPronoun(username) {
            const key = username.toLowerCase();
            let cached = this.settings.pronouns.cache[key];

            if (!cached || cached.expire < Date.now()) {
                const res = await Utils.fetchJSON(this.settings.pronouns.api.user(key));
                if (!res || !res.length) return null;
                cached = {
                    ...res[0],
                    expire: Date.now() + 1000 * 60 * 5
                };
                this.settings.pronouns.cache[key] = cached;
            }

            if (!cached.pronoun_id) return null;
            return this.settings.pronouns.list[cached.pronoun_id] || null;
        }
    }

    class RoleDetector {
        constructor(settings) {
            this.settings = settings;
        }

        getRole(data, provider) {
            if (provider === "youtube") {
                if (this.settings.chat.botNames.includes((data.nick || "").toLowerCase())) return "bot";
                if (data.authorDetails?.isChatOwner) return "broadcaster";
                if (data.authorDetails?.isChatModerator) return "mod";
                if (data.authorDetails?.isChatSponsor) return "subscriber";
                return "viewer";
            }

            const badges = data.tags?.badges || "";
            const nick = (data.nick ?? "").toString().toLowerCase();

            if (this.settings.chat.botNames.includes(nick)) return "bot";
            if (badges.includes("broadcaster/")) return "broadcaster";
            if (badges.includes("lead_moderator/")) return "lead_moderator";
            if (badges.includes("moderator/")) return "mod";
            if (badges.includes("vip/")) return "vip";
            if (badges.includes("subscriber/") || badges.includes("founder/")) return "subscriber";
            if (badges.includes("artist-badge/")) return "artist";
            if (badges.includes("premium/")) return "prime";
            if (Number(data.tags?.["first-msg"]) === 1) return "first";
            return "viewer";
        }

        getEventType(listener, ev, provider) {
            if (provider === "youtube") {
                if (listener === "event") {
                    if (ev.type === "superchat") return "superchat";
                    if (ev.type === "sponsor") return "sub";
                    if (ev.type === "member") return "sub";
                    return null;
                }
                
                if (listener === "sponsor-latest") {
                    if (ev.gift === true) return "gift-subs";
                    return "sub";
                }
                if (listener === "superchat-latest") return "superchat";
                if (listener === "tip-latest") return "tip";
                if (listener === "subscriber-latest") return "follow";
                return null;
            }

            if (listener === "subscriber-latest") {
                if (ev.bulkGifted) return "gift-subs";
                if (ev.gifted) return "gifted-sub";
                return "sub";
            }
            if (listener === "cheer-latest") return "cheers";
            if (listener === "raid-latest") return "raid";
            if (listener === "tip-latest") return "tip";
            if (listener === "follower-latest") return "follow";
            if (listener === "event" && ev.type === "channelPointsRedemption") return "points";
            return null;
        }
    }

    class MoonBridge {
        constructor(config) {
            this.config = config;
            this.emoteCache = {
                "7tv": {},
                "7tv-global": null,
                "bttv": {},
                "bttv-global": null,
                "ffz": {}
            };
            this.ws = null;
        }

        log(type, ...args) {
            console.log(
                `%c[MOONBRIDGE] ${type}`,
                "background:#9146ff;color:#fff;padding:2px 6px;border-radius:3px",
                ...args
            );
        }

        dispatch(listener, eventData) {
            const ev = new CustomEvent("onEventReceived", {
                detail: { listener, event: eventData }
            });
            this.log("ok", "dispatch → " + listener, ev.detail.event);
            window.dispatchEvent(ev);
        }

        async fetch7TVGlobal() {
            if (this.emoteCache["7tv-global"]) return this.emoteCache["7tv-global"];
            
            try {
                const data = await Utils.fetchJSON("https://7tv.io/v3/emote-sets/global");
                const emotes = {};
                (data.emotes || []).forEach(e => {
                    emotes[e.name] = {
                        id: e.id,
                        urls: {
                            "1": `https://cdn.7tv.app/emote/${e.id}/1x.webp`,
                            "2": `https://cdn.7tv.app/emote/${e.id}/2x.webp`,
                            "3": `https://cdn.7tv.app/emote/${e.id}/3x.webp`,
                            "4": `https://cdn.7tv.app/emote/${e.id}/4x.webp`
                        },
                        animated: e.animated || false
                    };
                });
                this.emoteCache["7tv-global"] = emotes;
                return emotes;
            } catch {
                return {};
            }
        }

        async fetch7TV(channelId) {
            if (this.emoteCache["7tv"][channelId]) return this.emoteCache["7tv"][channelId];
            
            try {
                const data = await Utils.fetchJSON(`https://7tv.io/v3/users/twitch/${channelId}`);
                const emotes = {};
                (data.emote_set?.emotes || []).forEach(e => {
                    emotes[e.name] = {
                        id: e.id,
                        urls: {
                            "1": `https://cdn.7tv.app/emote/${e.id}/1x.webp`,
                            "2": `https://cdn.7tv.app/emote/${e.id}/2x.webp`,
                            "3": `https://cdn.7tv.app/emote/${e.id}/3x.webp`,
                            "4": `https://cdn.7tv.app/emote/${e.id}/4x.webp`
                        },
                        animated: e.animated || false
                    };
                });
                this.emoteCache["7tv"][channelId] = emotes;
                return emotes;
            } catch {
                this.emoteCache["7tv"][channelId] = {};
                return {};
            }
        }

        async fetchBTTVGlobal() {
            if (this.emoteCache["bttv-global"]) return this.emoteCache["bttv-global"];
            
            try {
                const data = await Utils.fetchJSON("https://api.betterttv.net/3/cached/emotes/global");
                const emotes = {};
                (data || []).forEach(e => {
                    emotes[e.code] = {
                        id: e.id,
                        urls: {
                            "1": `https://cdn.betterttv.net/emote/${e.id}/1x`,
                            "2": `https://cdn.betterttv.net/emote/${e.id}/2x`,
                            "4": `https://cdn.betterttv.net/emote/${e.id}/3x`
                        },
                        animated: e.imageType === "gif"
                    };
                });
                this.emoteCache["bttv-global"] = emotes;
                return emotes;
            } catch {
                return {};
            }
        }

        async fetchBTTV(channelId) {
            if (this.emoteCache["bttv"][channelId]) return this.emoteCache["bttv"][channelId];
            
            try {
                const data = await Utils.fetchJSON(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
                const emotes = {};
                [...(data.channelEmotes || []), ...(data.sharedEmotes || [])].forEach(e => {
                    emotes[e.code] = {
                        id: e.id,
                        urls: {
                            "1": `https://cdn.betterttv.net/emote/${e.id}/1x`,
                            "2": `https://cdn.betterttv.net/emote/${e.id}/2x`,
                            "4": `https://cdn.betterttv.net/emote/${e.id}/3x`
                        },
                        animated: e.imageType === "gif"
                    };
                });
                this.emoteCache["bttv"][channelId] = emotes;
                return emotes;
            } catch {
                this.emoteCache["bttv"][channelId] = {};
                return {};
            }
        }

        async fetchFFZ(channelId) {
            if (this.emoteCache["ffz"][channelId]) return this.emoteCache["ffz"][channelId];
            
            try {
                const data = await Utils.fetchJSON(`https://api.frankerfacez.com/v1/room/id/${channelId}`);
                const emotes = {};
                Object.values(data.sets || {}).forEach(set => {
                    (set.emoticons || []).forEach(e => {
                        emotes[e.name] = {
                            id: e.id,
                            urls: {
                                "1": e.urls["1"] || "",
                                "2": e.urls["2"] || e.urls["1"] || "",
                                "4": e.urls["4"] || e.urls["2"] || e.urls["1"] || ""
                            },
                            animated: false
                        };
                    });
                });
                this.emoteCache["ffz"][channelId] = emotes;
                return emotes;
            } catch {
                this.emoteCache["ffz"][channelId] = {};
                return {};
            }
        }

        parseFragments(fragments) {
            const emotes = [];
            let pos = 0;
        
            fragments.forEach(frag => {
                if (frag.type === "emote" && frag.emote) {
                    const formats = frag.emote.format || [];
                    const hasAnimated = formats.includes("animated");
                    const urlType = hasAnimated ? "animated" : "static";
                    
                    emotes.push({
                        type: "twitch",
                        name: frag.text,
                        id: frag.emote.id,
                        start: pos,
                        end: pos + frag.text.length - 1,
                        animated: hasAnimated,
                        urls: {
                            "1": `https://static-cdn.jtvnw.net/emoticons/v2/${frag.emote.id}/${urlType}/dark/1.0`,
                            "2": `https://static-cdn.jtvnw.net/emoticons/v2/${frag.emote.id}/${urlType}/dark/2.0`,
                            "4": `https://static-cdn.jtvnw.net/emoticons/v2/${frag.emote.id}/${urlType}/dark/3.0`
                        }
                    });
                }
                pos += frag.text.length;
            });
        
            return emotes;
        }

        async parseThirdPartyEmotes(text, channelId) {
            const [seventvGlobal, seventvChannel, bttvGlobal, bttvChannel, ffz] = await Promise.all([
                this.fetch7TVGlobal(),
                this.fetch7TV(channelId),
                this.fetchBTTVGlobal(),
                this.fetchBTTV(channelId),
                this.fetchFFZ(channelId)
            ]);

            const seventv = { ...seventvGlobal, ...seventvChannel };
            const bttv = { ...bttvGlobal, ...bttvChannel };

            const emotes = [];
            const words = text.split(/(\s+)/);
            let pos = 0;

            for (const word of words) {
                const trimmed = word.trim();
                if (!trimmed) {
                    pos += word.length;
                    continue;
                }

                if (seventv[trimmed]) {
                    emotes.push({
                        type: "7tv",
                        name: trimmed,
                        id: seventv[trimmed].id,
                        start: pos,
                        end: pos + trimmed.length - 1,
                        urls: seventv[trimmed].urls
                    });
                } else if (bttv[trimmed]) {
                    emotes.push({
                        type: "bttv",
                        name: trimmed,
                        id: bttv[trimmed].id,
                        start: pos,
                        end: pos + trimmed.length - 1,
                        urls: bttv[trimmed].urls
                    });
                } else if (ffz[trimmed]) {
                    emotes.push({
                        type: "ffz",
                        name: trimmed,
                        id: ffz[trimmed].id,
                        start: pos,
                        end: pos + trimmed.length - 1,
                        urls: ffz[trimmed].urls
                    });
                }

                pos += word.length;
            }

            return emotes;
        }

        async handleChat(msg) {
            const d = msg.data;
            if (!d || !d.chatter_user_name) return;

            const text = d.message?.text || "";
            const fragments = d.message?.fragments || [];

            const twitchEmotes = this.parseFragments(fragments);
            const thirdPartyEmotes = await this.parseThirdPartyEmotes(text, d.broadcaster_user_id);
            const allEmotes = [...twitchEmotes, ...thirdPartyEmotes].sort((a, b) => a.start - b.start);

            const chatData = {
                time: Date.now(),
                tags: {
                    badges: (d.badges || []).map(b => `${b.set_id}/${b.id}`).join(","),
                    color: d.color || "",
                    "display-name": d.chatter_user_name,
                    id: d.message_id,
                    "room-id": d.broadcaster_user_id,
                    "user-id": d.chatter_user_id
                },
                nick: d.chatter_user_login,
                userId: d.chatter_user_id,
                displayName: d.chatter_user_name,
                badges: (d.badges || []).map(b => ({
                    type: b.set_id,
                    version: b.id,
                    url: null
                })),
                text: text,
                emotes: allEmotes,
                msgId: d.message_id
            };

            this.dispatch("message", {
                data: chatData,
                renderedText: text,
                service: "twitch",
                provider: "twitch"
            });
        }

        handleAlert(msg) {
            this.log("info", "WS RAW ALERT →", msg);
            
            const d = msg.data;
            
            if (!d) {
                this.log("warn", "Alert sin data →", msg);
                return;
            }

            const eventType = d.type;
            
            if (eventType === "channelPointsRedemption") {
                this.dispatch("event", {
                    ...d.data,
                    type: eventType,
                    provider: "twitch"
                });
                return;
            }

            const userData = d.data || {};
            
            const base = {
                name: userData.username || userData.displayName || userData.name || "Unknown",
                displayName: userData.displayName || userData.username || userData.name || "Unknown",
                providerId: userData.providerId || "",
                avatar: userData.avatar || "",
                _id: d._id || d.activityId || msg.id || "",
                sessionTop: false,
                type: eventType,
                originalEventName: `${eventType}-latest`
            };

            const eventData = {
                data: base,
                service: "twitch",
                provider: "twitch"
            };

            switch(eventType) {
                case "follow":
                    eventData.data.activityId = d.activityId;
                    this.log("ok", "Dispatching follower-latest", eventData);
                    this.dispatch("follower-latest", eventData);
                    break;

                case "subscriber":
                    eventData.data = {
                        ...base,
                        amount: userData.amount || 1,
                        tier: userData.tier || "1000",
                        message: userData.message || ""
                    };
                    if (userData.gifted) {
                        eventData.data.sender = userData.sender || base.name;
                        eventData.data.gifted = true;
                    }
                    this.log("ok", "Dispatching subscriber-latest", eventData);
                    this.dispatch("subscriber-latest", eventData);
                    break;

                case "communityGiftPurchase":
                    eventData.data = {
                        ...base,
                        sender: base.name,
                        amount: userData.amount || 0,
                        bulkGifted: true,
                        tier: userData.tier || "1000",
                        message: ""
                    };
                    this.log("ok", "Dispatching communityGift", eventData);
                    this.dispatch("subscriber-latest", eventData);
                    break;

                case "tip":
                    eventData.data.amount = userData.amount || 0;
                    eventData.data.message = userData.message || "";
                    this.log("ok", "Dispatching tip-latest", eventData);
                    this.dispatch("tip-latest", eventData);
                    break;

                case "cheer":
                    eventData.data.amount = userData.amount || 0;
                    eventData.data.message = userData.message || "";
                    this.log("ok", "Dispatching cheer-latest", eventData);
                    this.dispatch("cheer-latest", eventData);
                    break;

                case "raid":
                    eventData.data.amount = userData.amount || 0;
                    this.log("ok", "Dispatching raid-latest", eventData);
                    this.dispatch("raid-latest", eventData);
                    break;

                default:
                    this.log("warn", "Tipo de alerta desconocido →", eventType, msg);
            }
        }

        handleSession(msg) {
            this.log("info", "WS RAW SESSION →", msg);
            
            const d = msg.data;
            if (!d || !d.name) return;

            const sessionData = d.data || {};

            const eventData = {
                avatar: sessionData.avatar || "",
                displayName: sessionData.displayName || sessionData.name || "",
                name: sessionData.name || "",
                originalEventName: d.name,
                providerId: sessionData.providerId || "",
                sessionTop: false,
                type: d.name.replace("-latest", ""),
                _id: d.activityId || msg.id || ""
            };

            if (sessionData.amount !== undefined) {
                eventData.amount = sessionData.amount;
            }
            if (sessionData.message !== undefined) {
                eventData.message = sessionData.message;
            }

            this.log("ok", "Dispatching session →", d.name, eventData);
            this.dispatch(d.name, { data: eventData, service: "twitch", provider: "twitch" });
        }

        handle(msg) {
            if (!msg || !msg.topic) return;

            console.log("%c[DEBUG FULL MSG]", "background:#f59e0b;color:#000;padding:4px", {
                topic: msg.topic,
                type: msg.type,
                hasData: !!msg.data,
                dataKeys: msg.data ? Object.keys(msg.data) : [],
                fullMsg: msg
            });

            this.log("ok", "incoming", msg.topic);

            if (msg.topic === "channel.chat.message") {
                return this.handleChat(msg);
            }
            
            if (msg.topic === "channel.activities") {
                return this.handleAlert(msg);
            }

            if (msg.topic === "channel.session.update") {
                return this.handleSession(msg);
            }
        }

        connect() {
            this.ws = new WebSocket(this.config.url);

            this.ws.addEventListener("open", () => {
                this.log("ok", "WS CONNECTED");
                this.config.topics.forEach(t => {
                    this.ws.send(JSON.stringify({
                        type: "subscribe",
                        nonce: crypto.randomUUID(),
                        data: {
                            topic: t,
                            token: this.config.token,
                            token_type: "apikey"
                        }
                    }));
                });
            });

            this.ws.addEventListener("message", e => {
                try {
                    const msg = JSON.parse(e.data);
                    this.handle(msg);
                } catch {
                    this.log("error", "parse error", e.data);
                }
            });

            this.ws.addEventListener("close", () => {
                this.log("warn", "WS CLOSED - reconnecting in 3s");
                setTimeout(() => this.connect(), 3000);
            });
        }
    }

    class ChatCore {
        constructor(config = {}) {
            this.settings = config.settings || {};
            this.twitchEmotes = new TwitchEmoteProcessor(this.settings);
            this.youtubeEmotes = new YouTubeEmoteProcessor(this.settings);
            this.pronouns = new PronounsManager(this.settings);
            this.roleDetector = new RoleDetector(this.settings);
            
            if (config.moonbridge) {
                this.moonbridge = new MoonBridge(config.moonbridge);
            }
        }

        async processEmotes(message, renderedText, messageData, provider) {
            if (provider === "youtube") {
                return await this.youtubeEmotes.process(message, renderedText, messageData);
            }
            return this.twitchEmotes.process(message, renderedText, messageData);
        }

        async getUserPronoun(username) {
            return await this.pronouns.getUserPronoun(username);
        }

        async loadPronouns() {
            return await this.pronouns.loadPronouns();
        }

        getRole(data, provider) {
            return this.roleDetector.getRole(data, provider);
        }

        getEventType(listener, ev, provider) {
            return this.roleDetector.getEventType(listener, ev, provider);
        }

        connectMoonBridge() {
            if (this.moonbridge) {
                this.moonbridge.connect();
            }
        }

        updateSettings(newSettings) {
            this.settings = { ...this.settings, ...newSettings };
            this.twitchEmotes.settings = this.settings;
            this.youtubeEmotes.settings = this.settings;
            this.pronouns.settings = this.settings;
            this.roleDetector.settings = this.settings;
        }
    }

    return ChatCore;
}));
