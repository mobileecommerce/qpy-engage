(function () {
  if (document.getElementById("qpy-engage-widget")) return;
  var API_ORIGIN = "https://qpy-engage-api.qpy-engage.workers.dev";
  var currentScript = document.currentScript;
  var workspaceId = currentScript ? currentScript.getAttribute("data-workspace") : null;
  // One id per page load, so any AI action triggered more than once in the same visit
  // (e.g. sharing a phone number, then a name) updates the same captured lead.
  var sessionId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));

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

  function render(appearance) {
    var color = (appearance && appearance.color) || "#4c50ee";
    var placement = appearance && appearance.placement === "left" ? "left" : "right";
    var effect = (appearance && appearance.effect) || "none";

    var root = document.createElement("div");
    root.id = "qpy-engage-widget";
    if (placement === "left") root.className = "qpy-left";
    root.innerHTML = '<button aria-label="Open customer chat" class="qpy-launch effect-' + effect + '">' + launcherContent(appearance) + '</button><section class="qpy-panel" hidden><header><strong>Chat with us</strong><small>AI assistant</small><button aria-label="Close chat">×</button></header><main><p class="qpy-ai">Hi! How can I help today?</p></main><form><input aria-label="Message" placeholder="Type a message…"><button aria-label="Send message">➤</button></form></section>';
    root.style.setProperty("--qpy-color", color);
    root.style.setProperty("--qpy-glow", hexToRgba(color, 0.45));

    var style = document.createElement("style");
    style.textContent = "#qpy-engage-widget{position:fixed;right:22px;bottom:22px;z-index:2147483647;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#20232b}#qpy-engage-widget.qpy-left{right:auto;left:22px}.qpy-launch{width:54px;height:54px;border:0;border-radius:50%;background:var(--qpy-color,#4c50ee);color:#fff;font-size:20px;font-weight:800;box-shadow:0 10px 30px #0003;display:grid;place-items:center}.qpy-launch[hidden]{display:none}.qpy-launch img{width:28px;height:28px;border-radius:50%;object-fit:cover}.qpy-launch.effect-pulse{animation:qpy-pulse 2.2s infinite}.qpy-launch.effect-bounce{animation:qpy-bounce 2.6s infinite}@keyframes qpy-pulse{0%,100%{box-shadow:0 10px 30px #0003,0 0 0 0 var(--qpy-glow,rgba(76,80,238,.45))}50%{box-shadow:0 10px 30px #0003,0 0 0 14px rgba(0,0,0,0)}}@keyframes qpy-bounce{0%,20%,50%,80%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}60%{transform:translateY(-5px)}}.qpy-panel{position:absolute;right:0;bottom:66px;width:min(340px,calc(100vw - 28px));height:440px;background:#fff;border:1px solid #e1e3e8;border-radius:16px;box-shadow:0 18px 60px #0003;overflow:hidden;display:flex;flex-direction:column}.qpy-panel[hidden]{display:none}#qpy-engage-widget.qpy-left .qpy-panel{right:auto;left:0}.qpy-panel header{height:60px;padding:0 15px;background:#171923;color:#fff;display:grid;grid-template-columns:1fr auto;align-content:center;flex:none}.qpy-panel header small{grid-column:1;color:#b9bec8;font-size:11px}.qpy-panel header button{grid-column:2;grid-row:1/3;border:0;background:transparent;color:#fff;font-size:24px}.qpy-panel main{flex:1;padding:14px;background:#f5f6f8;overflow:auto}.qpy-panel main p{max-width:78%;padding:9px 11px;border-radius:10px;line-height:1.45;margin:7px 0}.qpy-ai{background:#fff}.qpy-user{background:var(--qpy-color,#4c50ee);color:#fff;margin-left:auto!important}.qpy-panel form{height:64px;display:flex;gap:7px;padding:10px;border-top:1px solid #e1e3e8;flex:none}.qpy-panel input{flex:1;min-width:0;border:1px solid #d9dce3;border-radius:8px;padding:0 10px}.qpy-panel form button{width:42px;border:0;border-radius:8px;background:var(--qpy-color,#4c50ee);color:#fff}.qpy-panel form button:disabled{opacity:.5}";
    document.head.appendChild(style);
    document.body.appendChild(root);

    var launch = root.querySelector(".qpy-launch");
    var panel = root.querySelector(".qpy-panel");
    var close = root.querySelector("header button");
    var form = root.querySelector("form");
    var input = root.querySelector("input");
    var sendButton = root.querySelector("form button");
    var messages = root.querySelector("main");
    var history = [];
    var lastSeenAt = "";
    var pollTimer = null;

    function appendMessage(cls, text) {
      messages.insertAdjacentHTML("beforeend", '<p class="' + cls + '"></p>');
      messages.lastElementChild.textContent = text;
      messages.scrollTop = messages.scrollHeight;
    }

    function pollForReplies() {
      if (!sessionId) return;
      var url = API_ORIGIN + "/api/widget/poll?workspaceId=" + encodeURIComponent(workspaceId) + "&sessionId=" + encodeURIComponent(sessionId);
      if (lastSeenAt) url += "&after=" + encodeURIComponent(lastSeenAt);
      fetch(url).then(function (response) { return response.ok ? response.json() : { messages: [] }; })
        .then(function (data) {
          (data.messages || []).forEach(function (m) {
            appendMessage("qpy-ai", m.content);
            history.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
            lastSeenAt = m.createdAt;
          });
        })
        .catch(function () {});
    }

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(pollForReplies, 4000);
    }

    launch.onclick = function () { panel.hidden = false; launch.hidden = true; input.focus(); startPolling(); };
    close.onclick = function () { panel.hidden = true; launch.hidden = false; };
    if (!workspaceId) {
      appendMessage("qpy-ai", "This chat widget is missing its workspace id — copy the install code again from Qpy Engage Channels settings.");
    }
    form.onsubmit = function (event) {
      event.preventDefault();
      if (!workspaceId) return;
      var text = input.value.trim();
      if (!text) return;
      appendMessage("qpy-user", text);
      input.value = "";
      input.disabled = true;
      sendButton.disabled = true;
      startPolling();
      fetch(API_ORIGIN + "/api/widget/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspaceId, message: text, history: history, sessionId: sessionId }),
      })
        .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
        .then(function (result) {
          history.push({ role: "user", content: text });
          if (result.data && result.data.serverTime) lastSeenAt = result.data.serverTime;
          if (result.ok && result.data && result.data.humanHandling) {
            // A team member has taken over — the AI stays quiet and their reply arrives via polling.
            return;
          }
          var answer = result.ok && result.data && result.data.reply ? result.data.reply : (result.data && result.data.error) || "Sorry, I couldn't respond right now.";
          if (result.ok) history.push({ role: "assistant", content: answer });
          appendMessage("qpy-ai", answer);
        })
        .catch(function () {
          appendMessage("qpy-ai", "Sorry, I couldn't reach support chat right now. Please try again shortly.");
        })
        .then(function () { input.disabled = false; sendButton.disabled = false; input.focus(); });
    };
  }

  if (!workspaceId) { render(null); return; }
  fetch(API_ORIGIN + "/api/widget/config?workspaceId=" + encodeURIComponent(workspaceId))
    .then(function (response) { return response.ok ? response.json() : { appearance: null }; })
    .then(function (data) { render(data && data.appearance); })
    .catch(function () { render(null); });
})();
