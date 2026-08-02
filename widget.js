(function () {
  if (document.getElementById("qpy-engage-widget")) return;
  var API_ORIGIN = "https://qpy-engage-api.qpy-engage.workers.dev";
  var currentScript = document.currentScript;
  var workspaceId = currentScript ? currentScript.getAttribute("data-workspace") : null;
  // A visitor can hold several separate conversations, listed inside the widget. The list lives in
  // localStorage rather than sessionStorage: a history that disappears when the tab closes isn't a
  // history, and the whole point of the list is coming back to an earlier thread.
  var chatsKey = "qpy-widget-chats-" + (workspaceId || "none");
  var activeKey = "qpy-widget-active-" + (workspaceId || "none");
  var legacySessionKey = "qpy-widget-session-" + (workspaceId || "none");

  function newChatId() {
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : (Date.now().toString(36) + Math.random().toString(36).slice(2));
  }
  function readStored(key, fallback) {
    try { var raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeStored(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  var chats = readStored(chatsKey, null);
  if (!Array.isArray(chats)) {
    // Adopt the single conversation older builds kept, so upgrading doesn't read as "my chat is gone".
    var legacyId = null;
    try { legacyId = window.sessionStorage.getItem(legacySessionKey); } catch (e) {}
    chats = legacyId ? [{ id: legacyId, title: "", preview: "", updatedAt: Date.now() }] : [];
  }

  // What the page knows and the request headers do not: which page the visitor is on, where they
  // arrived from, and their real local timezone. Each is wrapped because a sandboxed iframe or a
  // strict privacy extension can throw on any of them, and a chat widget must never break the host
  // page over analytics.
  function visitorContext() {
    var ctx = {};
    try { ctx.pageUrl = String(location.href).slice(0, 300); } catch (e) {}
    try { ctx.pageTitle = String(document.title || "").slice(0, 160); } catch (e) {}
    try { ctx.referrer = String(document.referrer || "").slice(0, 300); } catch (e) {}
    try { ctx.screen = window.screen.width + "x" + window.screen.height; } catch (e) {}
    try { ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    return ctx;
  }

  var chatEnded = false;
  var sessionId = null;
  try { sessionId = window.localStorage.getItem(activeKey); } catch (e) {}
  var hasActive = false;
  for (var ci = 0; ci < chats.length; ci++) if (chats[ci].id === sessionId) hasActive = true;
  if (!hasActive) {
    sessionId = chats.length ? chats[0].id : newChatId();
    var known = false;
    for (var cj = 0; cj < chats.length; cj++) if (chats[cj].id === sessionId) known = true;
    if (!known) chats.unshift({ id: sessionId, title: "", preview: "", updatedAt: Date.now() });
  }
  try { window.localStorage.setItem(activeKey, sessionId); } catch (e) {}
  writeStored(chatsKey, chats);

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-4.5 7.5 8.5 8.5 0 0 1-7.6.9L3 21l1.9-5.9a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    help: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><circle cx="12" cy="17" r=".6" fill="#fff" stroke="none"/></svg>',
    spark: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>'
  };

  function hexToRgba(hex, alpha) {
    var value = (hex || "#4c50ee").replace("#", "");
    if (value.length === 3) value = value.split("").map(function (c) { return c + c; }).join("");
    var num = parseInt(value, 16);
    if (isNaN(num)) num = 0x4c50ee;
    var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function launcherContent(appearance) {
    var iconType = appearance && appearance.iconType;
    if (iconType === "custom" && appearance.customIconUrl) {
      return '<img src="' + appearance.customIconUrl + '" alt="" />';
    }
    if (iconType && ICONS[iconType]) return ICONS[iconType];
    return "Q";
  }

  // Nudges a hex colour toward white (amount > 0) or black (amount < 0). Glossy surfaces need a
  // lighter top and darker bottom of the same hue, which is the whole trick behind the effect.
  function shade(hex, amount) {
    var value = (hex || "#4c50ee").replace("#", "");
    if (value.length === 3) value = value.split("").map(function (c) { return c + c; }).join("");
    var num = parseInt(value, 16);
    if (isNaN(num)) num = 0x4c50ee;
    var parts = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map(function (c) {
      var next = amount > 0 ? c + (255 - c) * amount : c * (1 + amount);
      return Math.max(0, Math.min(255, Math.round(next)));
    });
    return "rgb(" + parts.join(",") + ")";
  }

  function render(appearance, assistantName, welcome) {
    var color = (appearance && appearance.color) || "#4c50ee";
    var placement = appearance && appearance.placement === "left" ? "left" : "right";
    var effect = (appearance && appearance.effect) || "none";
    var headerColor = (appearance && appearance.headerColor) || "#171923";
    var glossy = Boolean(appearance && appearance.glossy);
    var name = assistantName || "AI assistant";
    var greeting = welcome || "Hi! How can I help today?";

    var root = document.createElement("div");
    root.id = "qpy-engage-widget";
    if (placement === "left") root.className = "qpy-left";
    root.innerHTML = '<button aria-label="Open customer chat" class="qpy-launch effect-' + effect + '">' + launcherContent(appearance) + '</button><section class="qpy-panel" hidden><header><button class="qpy-back" aria-label="Back to your chats" hidden>\u2039</button><strong></strong><small>AI assistant</small><button class="qpy-close" aria-label="Close chat">×</button></header><div class="qpy-list" hidden><button class="qpy-new">\uff0b Start a new chat</button><div class="qpy-list-items"></div></div><main></main><form><input aria-label="Message" placeholder="Type a message…"><button aria-label="Send message">➤</button></form></section>';
    root.querySelector("header strong").textContent = name;
    root.style.setProperty("--qpy-color", color);
    root.style.setProperty("--qpy-glow", hexToRgba(color, 0.45));
    root.style.setProperty("--qpy-header", headerColor);
    if (glossy) {
      root.classList.add("qpy-glossy");
      root.style.setProperty("--qpy-color-lit", shade(color, 0.28));
      root.style.setProperty("--qpy-color-deep", shade(color, -0.18));
      root.style.setProperty("--qpy-header-lit", shade(headerColor, 0.22));
      root.style.setProperty("--qpy-header-deep", shade(headerColor, -0.12));
    }

    var style = document.createElement("style");
    style.textContent = "#qpy-engage-widget{position:fixed;right:22px;bottom:22px;z-index:2147483647;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#20232b}#qpy-engage-widget.qpy-left{right:auto;left:22px}.qpy-launch{width:54px;height:54px;border:0;border-radius:50%;background:var(--qpy-color,#4c50ee);color:#fff;font-size:20px;font-weight:800;box-shadow:0 10px 30px #0003;display:grid;place-items:center}.qpy-launch[hidden]{display:none}.qpy-launch img{width:28px;height:28px;border-radius:50%;object-fit:cover}.qpy-launch.effect-pulse{animation:qpy-pulse 2.2s infinite}.qpy-launch.effect-bounce{animation:qpy-bounce 2.6s infinite}@keyframes qpy-pulse{0%,100%{box-shadow:0 10px 30px #0003,0 0 0 0 var(--qpy-glow,rgba(76,80,238,.45))}50%{box-shadow:0 10px 30px #0003,0 0 0 14px rgba(0,0,0,0)}}@keyframes qpy-bounce{0%,20%,50%,80%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}60%{transform:translateY(-5px)}}.qpy-panel{position:absolute;right:0;bottom:66px;width:min(370px,calc(100vw - 28px));height:min(620px,calc(100vh - 110px));background:#fff;border:1px solid #e1e3e8;border-radius:16px;box-shadow:0 18px 60px #0003;overflow:hidden;display:flex;flex-direction:column}.qpy-panel[hidden]{display:none}#qpy-engage-widget.qpy-left .qpy-panel{right:auto;left:0}.qpy-panel header{height:60px;padding:0 12px;background:var(--qpy-header,#171923);color:#fff;display:grid;grid-template-columns:auto 1fr auto;align-content:center;flex:none}.qpy-panel header strong{grid-column:2;grid-row:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qpy-panel header small{grid-column:2;grid-row:2;color:#b9bec8;font-size:11px}.qpy-panel header button{border:0;background:transparent;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0}.qpy-back{grid-column:1;grid-row:1/3;font-size:30px!important;width:22px;text-align:left}.qpy-back[hidden]{display:none}.qpy-close{grid-column:3;grid-row:1/3;width:26px}.qpy-panel[dir='rtl']{direction:rtl}.qpy-panel[dir='rtl'] .qpy-user{margin-left:0!important;margin-right:auto!important}.qpy-panel[dir='rtl'] .qpy-ai{margin-right:0!important;margin-left:auto!important}.qpy-panel[dir='rtl'] .qpy-chat-row{text-align:right}.qpy-panel[dir='rtl'] .qpy-back{transform:scaleX(-1)}.qpy-panel[dir='rtl'] header{grid-template-columns:auto 1fr auto}.qpy-list{flex:1;background:#f5f6f8;overflow:auto;padding:11px}.qpy-list[hidden]{display:none}.qpy-panel main[hidden],.qpy-panel form[hidden]{display:none}.qpy-new{width:100%;border:1px dashed var(--qpy-color,#4c50ee);background:#fff;color:var(--qpy-color,#4c50ee);border-radius:10px;padding:11px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:11px}.qpy-chat-row{display:block;width:100%;text-align:left;border:1px solid #e1e3e8;background:#fff;border-radius:10px;padding:10px 11px;margin-bottom:7px;cursor:pointer}.qpy-chat-row.active{border-color:var(--qpy-color,#4c50ee)}.qpy-chat-row strong{display:block;font-size:12.5px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qpy-chat-row small{display:block;font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qpy-chat-row em{font-style:normal;font-size:10px;color:#9aa1af;display:block;margin-top:4px}.qpy-empty-list{color:#8d94a1;font-size:12px;text-align:center;padding:16px 8px}.qpy-panel main{flex:1;padding:14px;background:#f5f6f8;overflow:auto}.qpy-panel main p{max-width:78%;padding:9px 11px;border-radius:10px;line-height:1.45;margin:7px 0;white-space:pre-line}.qpy-ai{background:#fff}.qpy-user{background:var(--qpy-color,#4c50ee);color:#fff;margin-left:auto!important}.qpy-system{background:transparent!important;color:#8d94a1;font-size:11px;text-align:center;max-width:100%!important;margin:4px auto!important}.qpy-ended-bar{padding:10px 14px;border-top:1px solid rgba(0,0,0,.08);text-align:center}.qpy-ended-bar button{border:1px solid rgba(0,0,0,.12);background:#fff;border-radius:20px;padding:8px 16px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}.qpy-typing{display:flex;align-items:center;gap:6px;padding:9px 11px!important}.qpy-typing em{font-style:normal;font-size:11px;color:#69707e}.qpy-typing span{width:6px;height:6px;border-radius:50%;background:#9aa1af;animation:qpy-typing-bounce 1.2s infinite;flex:none}.qpy-typing span:nth-child(3){animation-delay:.2s}.qpy-typing span:nth-child(4){animation-delay:.4s}@keyframes qpy-typing-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}.qpy-panel form{height:64px;display:flex;gap:7px;padding:10px;border-top:1px solid #e1e3e8;flex:none}.qpy-panel input{flex:1;min-width:0;border:1px solid #d9dce3;border-radius:8px;padding:0 10px}.qpy-panel form button{width:42px;border:0;border-radius:8px;background:var(--qpy-color,#4c50ee);color:#fff}.qpy-panel form button:disabled{opacity:.5}.qpy-buttons{display:flex;flex-direction:column;gap:6px;max-width:88%;margin:7px 0 12px}.qpy-buttons button{border:1px solid var(--qpy-color,#4c50ee);background:#fff;color:var(--qpy-color,#4c50ee);border-radius:20px;padding:8px 14px;font-size:12.5px;font-weight:600;text-align:center}.qpy-buttons button:disabled{opacity:.5}.qpy-buttons button small{display:block;font-size:10.5px;font-weight:400;opacity:.75;margin-top:2px}.qpy-uploads{display:flex;flex-direction:column;gap:8px;max-width:88%;margin:7px 0 12px}.qpy-upload-row{border:1px solid #d9dce3;border-radius:10px;background:#fff;padding:9px 10px;display:flex;flex-direction:column;gap:5px}.qpy-upload-row.done{border-color:#39a06a;background:#f3fbf6}.qpy-upload-row.error{border-color:#d2544a;background:#fdf4f3}.qpy-upload-row strong{font-size:12px}.qpy-upload-row small{font-size:10.5px;color:#6b7280}.qpy-upload-row em{font-style:normal;font-size:10.5px;color:#6b7280;word-break:break-word}.qpy-upload-row.error em{color:#b8332a}.qpy-upload-row.done em{color:#2f7d54}.qpy-upload-pick{display:inline-block;text-align:center;border:1px solid var(--qpy-color,#4c50ee);color:var(--qpy-color,#4c50ee);border-radius:8px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer}.qpy-upload-pick[disabled]{opacity:.5;cursor:progress}.qpy-upload-pick input{display:none}.qpy-items{display:flex;gap:10px;overflow-x:auto;margin:7px 0 12px;padding-bottom:4px}.qpy-item-card{flex:0 0 auto;width:170px;border:1px solid #e1e3e8;border-radius:10px;overflow:hidden;background:#fff;display:flex;flex-direction:column}.qpy-item-card img{width:100%;height:90px;object-fit:cover;background:#eef0f4}.qpy-item-card .qpy-item-body{padding:8px 9px;display:flex;flex-direction:column;gap:4px;flex:1}.qpy-item-card strong{font-size:12px;line-height:1.3}.qpy-item-card small{font-size:10.5px;color:#6b7280}.qpy-item-card .qpy-item-price{font-size:12px;font-weight:700;color:var(--qpy-color,#4c50ee)}.qpy-item-card a{margin-top:auto;display:block;text-align:center;border:0;background:var(--qpy-color,#4c50ee);color:#fff;border-radius:7px;padding:6px;font-size:11.5px;font-weight:700;text-decoration:none}";
    // Only shipped when the owner turns gloss on, so flat installs carry none of this weight.
    if (glossy) style.textContent += ".qpy-glossy .qpy-launch{position:relative;overflow:hidden;background:linear-gradient(160deg,var(--qpy-color-lit) 0%,var(--qpy-color) 52%,var(--qpy-color-deep) 100%);box-shadow:0 10px 30px #0003,inset 0 1px 0 #ffffff66,inset 0 -2px 6px #00000026}.qpy-glossy .qpy-launch::after{content:'';position:absolute;inset:2px 2px 52% 2px;border-radius:50% 50% 42% 42%/60% 60% 40% 40%;background:linear-gradient(#ffffff5c,#ffffff0d);pointer-events:none}.qpy-glossy .qpy-launch img,.qpy-glossy .qpy-launch svg{position:relative;z-index:1}.qpy-glossy .qpy-panel{background:linear-gradient(#ffffff,#f7f8fb);border-color:#ffffffb3;box-shadow:0 24px 70px #00000038,0 2px 8px #0000001f,inset 0 1px 0 #fff}.qpy-glossy .qpy-panel header{position:relative;background:linear-gradient(165deg,var(--qpy-header-lit) 0%,var(--qpy-header) 58%,var(--qpy-header-deep) 100%);box-shadow:inset 0 1px 0 #ffffff40,0 1px 12px #00000024}.qpy-glossy .qpy-panel header::after{content:'';position:absolute;left:0;right:0;top:0;height:52%;background:linear-gradient(#ffffff2e,#ffffff00);pointer-events:none}.qpy-glossy .qpy-panel header>*{position:relative;z-index:1}.qpy-glossy .qpy-panel main,.qpy-glossy .qpy-list{background:linear-gradient(#f2f4f8,#eceff5)}.qpy-glossy .qpy-ai,.qpy-glossy .qpy-chat-row,.qpy-glossy .qpy-item-card,.qpy-glossy .qpy-upload-row{background:linear-gradient(#ffffff,#fbfcfe);box-shadow:0 1px 3px #0000001a,inset 0 1px 0 #fff}.qpy-glossy .qpy-user{background:linear-gradient(155deg,var(--qpy-color-lit),var(--qpy-color) 58%,var(--qpy-color-deep));box-shadow:0 2px 7px #00000024,inset 0 1px 0 #ffffff59}.qpy-glossy .qpy-panel form{background:linear-gradient(#ffffff,#f6f7fa);border-top-color:#e6e8ee}.qpy-glossy .qpy-panel form button,.qpy-glossy .qpy-buttons button:not(:disabled),.qpy-glossy .qpy-item-card a{background:linear-gradient(155deg,var(--qpy-color-lit),var(--qpy-color) 58%,var(--qpy-color-deep));color:#fff;border-color:transparent;box-shadow:0 2px 7px #00000026,inset 0 1px 0 #ffffff59}.qpy-glossy .qpy-buttons button small{opacity:.85}.qpy-glossy .qpy-new{background:linear-gradient(#ffffff,#f4f6fa);box-shadow:inset 0 1px 0 #fff,0 1px 3px #00000014}.qpy-glossy .qpy-upload-pick{background:linear-gradient(#ffffff,#f4f6fa);box-shadow:inset 0 1px 0 #fff,0 1px 3px #00000014}";
    document.head.appendChild(style);
    document.body.appendChild(root);

    var launch = root.querySelector(".qpy-launch");
    var panel = root.querySelector(".qpy-panel");
    var headerSubtitle = root.querySelector("header small");
    var back = root.querySelector(".qpy-back");
    var close = root.querySelector(".qpy-close");
    var listPane = root.querySelector(".qpy-list");
    var listItems = root.querySelector(".qpy-list-items");
    var newChatButton = root.querySelector(".qpy-new");
    var form = root.querySelector("form");
    var input = root.querySelector("input");
    var sendButton = root.querySelector("form button");
    var messages = root.querySelector("main");
    var history = [];
    var lastSeenAt = "";
    var pollTimer = null;
    var typingEl = null;
    var awaitingAiReply = false;

    // Interface strings for the languages we ship; anything else falls back to English while the
    // conversation content itself is still fully translated by the automation/AI.
    var UI = {
      en: { placeholder: "Type a message…", newChat: "\uff0b Start a new chat", tapToContinue: "Tap to continue", newConversation: "New conversation", typing: "is typing…", agentTyping: "Agent is typing…", conversations: "conversations", oneConversation: "1 conversation", choose: "Choose file", received: "\u2713 Received — replace" },
      ar: { placeholder: "اكتب رسالة…", newChat: "\uff0b بدء محادثة جديدة", tapToContinue: "اضغط للمتابعة", newConversation: "محادثة جديدة", typing: "يكتب…", agentTyping: "الموظف يكتب…", conversations: "محادثات", oneConversation: "محادثة واحدة", choose: "اختر ملفًا", received: "\u2713 تم الاستلام — استبدال" },
      hi: { placeholder: "संदेश लिखें…", newChat: "\uff0b नई चैट शुरू करें", tapToContinue: "जारी रखने के लिए टैप करें", newConversation: "नई बातचीत", typing: "लिख रहे हैं…", agentTyping: "एजेंट लिख रहा है…", conversations: "बातचीत", oneConversation: "1 बातचीत", choose: "फ़ाइल चुनें", received: "\u2713 प्राप्त — बदलें" },
      ur: { placeholder: "پیغام لکھیں…", newChat: "\uff0b نئی چیٹ شروع کریں", tapToContinue: "جاری رکھنے کے لیے دبائیں", newConversation: "نئی گفتگو", typing: "لکھ رہے ہیں…", agentTyping: "ایجنٹ لکھ رہا ہے…", conversations: "گفتگوئیں", oneConversation: "1 گفتگو", choose: "فائل منتخب کریں", received: "\u2713 موصول — تبدیل کریں" },
      ru: { placeholder: "Напишите сообщение…", newChat: "\uff0b Новый чат", tapToContinue: "Нажмите, чтобы продолжить", newConversation: "Новый разговор", typing: "печатает…", agentTyping: "Оператор печатает…", conversations: "разговоров", oneConversation: "1 разговор", choose: "Выбрать файл", received: "\u2713 Получено — заменить" },
      es: { placeholder: "Escribe un mensaje…", newChat: "\uff0b Iniciar un chat nuevo", tapToContinue: "Toca para continuar", newConversation: "Nueva conversación", typing: "está escribiendo…", agentTyping: "El agente está escribiendo…", conversations: "conversaciones", oneConversation: "1 conversación", choose: "Elegir archivo", received: "\u2713 Recibido — reemplazar" },
      fr: { placeholder: "Écrivez un message…", newChat: "\uff0b Démarrer une discussion", tapToContinue: "Appuyez pour continuer", newConversation: "Nouvelle conversation", typing: "écrit…", agentTyping: "L'agent écrit…", conversations: "conversations", oneConversation: "1 conversation", choose: "Choisir un fichier", received: "\u2713 Reçu — remplacer" }
    };
    var RTL = { ar: 1, he: 1, fa: 1, ur: 1, ps: 1, sd: 1 };
    var uiLang = "en";
    function t(key) { return (UI[uiLang] && UI[uiLang][key]) || UI.en[key]; }

    // Arabic and Urdu need the whole panel mirrored, not merely translated words — a right-aligned
    // language inside a left-to-right layout reads as broken even when the text is perfect.
    function applyLanguage(lang) {
      var base = (lang || "").split("-")[0];
      if (!base || base === uiLang) return;
      uiLang = UI[base] ? base : "en";
      panel.setAttribute("dir", RTL[base] ? "rtl" : "ltr");
      input.placeholder = t("placeholder");
      newChatButton.textContent = t("newChat");
    }

    function setHandlingLabel(isAiActive) {
      // The poll ticks every few seconds and would otherwise overwrite the chat-list header with
      // "AI assistant" while the visitor is looking at their list of conversations.
      if (listPane && !listPane.hidden) return;
      headerSubtitle.textContent = isAiActive === false ? "Our team" : "AI assistant";
    }

    // ── Several conversations in one window ──

    function chatLabel(chat) {
      return chat.title || t("newConversation");
    }

    function touchActiveChat(text) {
      for (var i = 0; i < chats.length; i++) {
        if (chats[i].id !== sessionId) continue;
        if (!chats[i].title && text) chats[i].title = text.slice(0, 42);
        if (text) chats[i].preview = text.slice(0, 70);
        chats[i].updatedAt = Date.now();
        break;
      }
      writeStored(chatsKey, chats);
    }

    function renderChatList() {
      listItems.innerHTML = "";
      var ordered = chats.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      if (!ordered.length) {
        listItems.insertAdjacentHTML("beforeend", '<p class="qpy-empty-list">No conversations yet.</p>');
        return;
      }
      ordered.forEach(function (chat) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "qpy-chat-row" + (chat.id === sessionId ? " active" : "");
        var title = document.createElement("strong");
        title.textContent = chatLabel(chat);
        var preview = document.createElement("small");
        preview.textContent = chat.preview || t("tapToContinue");
        var when = document.createElement("em");
        when.textContent = chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : "";
        row.appendChild(title); row.appendChild(preview); row.appendChild(when);
        row.onclick = function () { switchChat(chat.id); };
        listItems.appendChild(row);
      });
    }

    function showList() {
      renderChatList();
      listPane.hidden = false;
      messages.hidden = true;
      form.hidden = true;
      back.hidden = true;
      headerSubtitle.textContent = chats.length === 1 ? t("oneConversation") : chats.length + " " + t("conversations");
    }

    function showChat() {
      listPane.hidden = true;
      messages.hidden = false;
      form.hidden = false;
      back.hidden = false;
    }

    function loadChatHistory(greetIfEmpty) {
      if (!workspaceId) return;
      fetch(API_ORIGIN + "/api/widget/history?workspaceId=" + encodeURIComponent(workspaceId) + "&sessionId=" + encodeURIComponent(sessionId))
        .then(function (response) { return response.ok ? response.json() : { messages: [] }; })
        .then(function (data) {
          setHandlingLabel(data.aiActive);
          var stored = data.messages || [];
          if (!stored.length) {
            if (greetIfEmpty && !messages.children.length) appendMessage("qpy-ai", greeting);
            return;
          }
          messages.innerHTML = "";
          stored.forEach(function (m) {
            var cls = m.role === "system" ? "qpy-system" : (m.role === "user" ? "qpy-user" : "qpy-ai");
            appendMessage(cls, m.content);
            if (m.role === "user" || m.role === "assistant" || m.role === "agent") {
              history.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
            }
            lastSeenAt = m.createdAt;
          });
        })
        .catch(function () {
          if (greetIfEmpty && !messages.children.length) appendMessage("qpy-ai", greeting);
        });
    }

    // Switching threads has to reset everything the old conversation owned — transcript, the
    // history sent to the model, and the poll cursor. Leaving the cursor behind would make the
    // next poll skip the new thread's messages as "already seen".
    function switchChat(id) {
      sessionId = id;
      try { window.localStorage.setItem(activeKey, id); } catch (e) {}
      history = [];
      lastSeenAt = "";
      hideTyping();
      awaitingAiReply = false;
      messages.innerHTML = "";
      showChat();
      loadChatHistory(true);
      input.focus();
    }


    // Locks the composer and offers a fresh conversation. The visitor is never left unable to
    // reach the business — only unable to add to a thread that is closed.
    function markChatEnded(reason) {
      chatEnded = true;
      appendMessage("qpy-system", reason);
      input.disabled = true;
      sendButton.disabled = true;
      input.placeholder = reason;
      if (document.getElementById("qpy-restart")) return;
      var bar = document.createElement("div");
      bar.className = "qpy-ended-bar";
      bar.id = "qpy-restart";
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = "Start a new chat";
      button.onclick = function () {
        bar.remove();
        chatEnded = false;
        input.disabled = false;
        sendButton.disabled = false;
        input.placeholder = "";
        startNewChat();
      };
      bar.appendChild(button);
      messages.parentNode.appendChild(bar);
    }

    function startNewChat() {
      var id = newChatId();
      chats.unshift({ id: id, title: "", preview: "", updatedAt: Date.now() });
      writeStored(chatsKey, chats);
      switchChat(id);
    }

    function hideTyping() {
      if (typingEl) { typingEl.remove(); typingEl = null; }
    }

    function showTyping(label) {
      if (!typingEl) {
        messages.insertAdjacentHTML("beforeend", '<p class="qpy-ai qpy-typing"><em></em><span></span><span></span><span></span></p>');
        typingEl = messages.lastElementChild;
      }
      typingEl.querySelector("em").textContent = label;
      messages.scrollTop = messages.scrollHeight;
    }

    function appendMessage(cls, text) {
      hideTyping();
      messages.insertAdjacentHTML("beforeend", '<p class="' + cls + '"></p>');
      messages.lastElementChild.textContent = text;
      messages.scrollTop = messages.scrollHeight;
    }

    // Flow steps ("without AI" predefined conversations) can send button choices or an items
    // carousel instead of plain text — these render as real interactive elements, distinct from
    // the AI assistant's free-form text replies.
    function appendButtons(text, options) {
      hideTyping();
      if (text) appendMessage("qpy-ai", text);
      var wrap = document.createElement("div");
      wrap.className = "qpy-buttons";
      options.forEach(function (opt) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = opt.label;
        if (opt.description) {
          var sub = document.createElement("small");
          sub.textContent = opt.description;
          btn.appendChild(sub);
        }
        btn.onclick = function () {
          Array.prototype.forEach.call(wrap.querySelectorAll("button"), function (b) { b.disabled = true; });
          sendText(opt.label);
        };
        wrap.appendChild(btn);
      });
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
    }

    function appendItems(text, items) {
      hideTyping();
      if (text) appendMessage("qpy-ai", text);
      var wrap = document.createElement("div");
      wrap.className = "qpy-items";
      items.forEach(function (item) {
        var card = document.createElement("div");
        card.className = "qpy-item-card";
        var img = document.createElement("img");
        img.src = item.imageUrl || "";
        img.alt = "";
        if (!item.imageUrl) img.style.display = "none";
        var body = document.createElement("div");
        body.className = "qpy-item-body";
        var title = document.createElement("strong");
        title.textContent = item.title || item.name;
        var price = document.createElement("span");
        price.className = "qpy-item-price";
        price.textContent = item.price ? (item.currency + " " + item.price) : "";
        body.appendChild(title);
        if (item.description) {
          var desc = document.createElement("small");
          desc.textContent = item.description;
          body.appendChild(desc);
        }
        if (item.price) body.appendChild(price);
        if (item.externalLink) {
          var link = document.createElement("a");
          link.href = item.externalLink;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "View";
          body.appendChild(link);
        }
        card.appendChild(img);
        card.appendChild(body);
        wrap.appendChild(card);
      });
      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
    }

    // An upload step renders one row per requested document. Each row uploads on its own as soon as
    // a file is chosen, so a customer sending three documents gets three independent successes or
    // failures rather than one all-or-nothing submit.
    function appendUpload(text, nodeId, documents) {
      hideTyping();
      if (text) appendMessage("qpy-ai", text);
      var wrap = document.createElement("div");
      wrap.className = "qpy-uploads";

      (documents || []).forEach(function (doc) {
        var row = document.createElement("div");
        row.className = "qpy-upload-row" + (doc.received ? " done" : "");

        var label = document.createElement("strong");
        label.textContent = doc.label + (doc.required ? "" : " (optional)");
        var hint = document.createElement("small");
        hint.textContent = (doc.accept || []).join(", ").toUpperCase() + " • max " + doc.maxMb + " MB";

        var pick = document.createElement("label");
        pick.className = "qpy-upload-pick";
        pick.textContent = doc.received ? "✓ Received — replace" : "Choose file";
        var input = document.createElement("input");
        input.type = "file";
        input.accept = (doc.accept || []).map(function (a) { return "." + a; }).join(",");

        var status = document.createElement("em");

        input.onchange = function () {
          var file = input.files && input.files[0];
          if (!file) return;
          row.classList.remove("error");
          status.textContent = "Uploading " + file.name + "…";
          pick.setAttribute("disabled", "true");

          var form = new FormData();
          form.append("workspaceId", workspaceId);
          form.append("sessionId", sessionId);
          form.append("docKey", doc.key);
          form.append("file", file);

          fetch(API_ORIGIN + "/api/widget/upload", { method: "POST", body: form })
            .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
            .then(function (res) {
              pick.removeAttribute("disabled");
              if (!res.ok || res.data.error) {
                row.classList.add("error");
                // The server's message names the real reason (wrong format, too large), so show it
                // rather than a generic failure the customer can't act on.
                status.textContent = res.data.error || "That upload did not go through.";
                input.value = "";
                return;
              }
              row.classList.add("done");
              pick.textContent = "✓ Received — replace";
              status.textContent = file.name;
              appendMessage("qpy-user", "📎 " + doc.label + ": " + file.name);
              if (res.data.messages && res.data.messages.length) renderFlowMessages(res.data.messages);
            })
            .catch(function () {
              pick.removeAttribute("disabled");
              row.classList.add("error");
              status.textContent = "Upload failed — please check your connection and try again.";
              input.value = "";
            });
        };

        pick.appendChild(input);
        row.appendChild(label);
        row.appendChild(hint);
        row.appendChild(pick);
        row.appendChild(status);
        wrap.appendChild(row);
      });

      messages.appendChild(wrap);
      messages.scrollTop = messages.scrollHeight;
    }

    function renderFlowMessages(list) {
      (list || []).forEach(function (m) {
        if (m.type === "buttons") appendButtons(m.text, m.options || []);
        else if (m.type === "upload") appendUpload(m.text, m.nodeId, m.documents || []);
        else if (m.type === "items") appendItems(m.text, m.items || []);
        else appendMessage("qpy-ai", m.text);
      });
    }

    function pollForReplies() {
      if (!sessionId) return;
      var url = API_ORIGIN + "/api/widget/poll?workspaceId=" + encodeURIComponent(workspaceId) + "&sessionId=" + encodeURIComponent(sessionId);
      if (lastSeenAt) url += "&after=" + encodeURIComponent(lastSeenAt);
      fetch(url).then(function (response) { return response.ok ? response.json() : { messages: [], typing: false }; })
        .then(function (data) {
          setHandlingLabel(data.aiActive);
          // A reply is written to storage by the automation engine BEFORE the request that produced
          // it returns. If a poll resolves in that window it holds the same message the pending
          // request is about to render, and its cursor is too old to recognise that. Re-checking
          // lastSeenAt only helps when the request wins the race — which, against a multi-second
          // model call and a four-second poll, is often not the case. So while a reply is pending,
          // leave delivery to it; the cursor stays put and the next tick picks up anything genuinely
          // newer, at the cost of showing an agent message one cycle late.
          if (awaitingAiReply) { if (data.typing) showTyping(t("agentTyping")); return; }
          (data.messages || []).forEach(function (m) {
            // A poll request can be in flight at the same moment the in-flight respond() call
            // (which owns displaying its own reply) saves and shows that same message — since
            // this poll's cursor was captured before that happened, its response can still list
            // a message we've since already displayed. Re-checking against the current
            // lastSeenAt (not just the value this request was sent with) catches that race
            // regardless of which side resolves first, and avoids showing it twice.
            if (m.createdAt <= lastSeenAt) return;
            appendMessage(m.role === "system" ? "qpy-system" : "qpy-ai", m.content);
            if (m.role !== "system") history.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
            lastSeenAt = m.createdAt;
          });
          if (data.typing) showTyping(t("agentTyping"));
          // Don't clear the indicator here if we're still waiting on the AI's own reply —
          // that belongs to the in-flight request below, not this unrelated poll tick.
          else if (!awaitingAiReply) hideTyping();
        })
        .catch(function () {});
    }

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(pollForReplies, 4000);
    }

    launch.onclick = function () {
      panel.hidden = false;
      launch.hidden = true;
      if (!listPane.hidden) renderChatList(); else input.focus();
      startPolling();
    };
    close.onclick = function () { panel.hidden = true; launch.hidden = false; };
    back.onclick = showList;
    newChatButton.onclick = startNewChat;

    if (!workspaceId) {
      appendMessage("qpy-ai", "This chat widget is missing its workspace id — copy the install code again from Qpy Engage Channels settings.");
    } else {
      // Open straight into the active thread; the back arrow is how the visitor reaches the list.
      showChat();
      loadChatHistory(true);
    }
    function sendText(text) {
      if (!workspaceId || !text) return;
      appendMessage("qpy-user", text);
      // The visitor's own words name the thread in the list — far more recognisable than a date.
      touchActiveChat(text);
      input.disabled = true;
      sendButton.disabled = true;
      startPolling();
      awaitingAiReply = true;
      showTyping(name + " " + t("typing"));
      fetch(API_ORIGIN + "/api/widget/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspaceId, message: text, history: history, sessionId: sessionId, context: visitorContext() }),
      })
        .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
        .then(function (result) {
          awaitingAiReply = false;
          hideTyping();
          // The team closed this thread, or it timed out. Say so plainly and offer the only useful
          // next step rather than surfacing a raw error the visitor cannot act on.
          if (result.data && result.data.ended) {
            markChatEnded(result.data.reason || "This chat has ended.");
            return;
          }
          history.push({ role: "user", content: text });
          if (result.data && result.data.serverTime) lastSeenAt = result.data.serverTime;
          if (result.data && result.data.lang) applyLanguage(result.data.lang);
          if (result.ok && result.data && result.data.humanHandling) {
            // A team member has taken over — the AI stays quiet; their typing/reply arrive via polling.
            setHandlingLabel(false);
            return;
          }
          if (result.ok && result.data && Array.isArray(result.data.messages)) {
            // A predefined Flow step handled this turn (buttons/items carousel/plain text).
            renderFlowMessages(result.data.messages);
            result.data.messages.forEach(function (m) { if (m.type === "text") history.push({ role: "assistant", content: m.text }); });
            return;
          }
          var answer = result.ok && result.data && result.data.reply ? result.data.reply : (result.data && result.data.error) || "Sorry, I couldn't respond right now.";
          if (result.ok) history.push({ role: "assistant", content: answer });
          appendMessage("qpy-ai", answer);
          if (result.ok) touchActiveChat(answer);
        })
        .catch(function () {
          awaitingAiReply = false;
          hideTyping();
          appendMessage("qpy-ai", "Sorry, I couldn't reach support chat right now. Please try again shortly.");
        })
        .then(function () { input.disabled = false; sendButton.disabled = false; input.focus(); });
    }

    form.onsubmit = function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendText(text);
    };
  }

  if (!workspaceId) { render(null); return; }
  fetch(API_ORIGIN + "/api/widget/config?workspaceId=" + encodeURIComponent(workspaceId))
    .then(function (response) { return response.ok ? response.json() : { appearance: null }; })
    .then(function (data) { render(data && data.appearance, data && data.assistantName, data && data.welcome); })
    .catch(function () { render(null); });
})();
