(function () {
  if (document.getElementById("qpy-engage-widget")) return;
  var API_ORIGIN = "https://qpy-engage-api.qpy-engage.workers.dev";
  var currentScript = document.currentScript;
  var workspaceId = currentScript ? currentScript.getAttribute("data-workspace") : null;
  var root = document.createElement("div");
  root.id = "qpy-engage-widget";
  root.innerHTML = '<button aria-label="Open customer chat" class="qpy-launch">Q</button><section class="qpy-panel" hidden><header><strong>Chat with us</strong><small>AI assistant</small><button aria-label="Close chat">×</button></header><main><p class="qpy-ai">Hi! How can I help today?</p></main><form><input aria-label="Message" placeholder="Type a message…"><button aria-label="Send message">➤</button></form></section>';
  var style = document.createElement("style");
  style.textContent = "#qpy-engage-widget{position:fixed;right:22px;bottom:22px;z-index:2147483647;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#20232b}.qpy-launch{width:54px;height:54px;border:0;border-radius:50%;background:#4c50ee;color:#fff;font-size:20px;font-weight:800;box-shadow:0 10px 30px #0003}.qpy-panel{position:absolute;right:0;bottom:66px;width:min(340px,calc(100vw - 28px));height:440px;background:#fff;border:1px solid #e1e3e8;border-radius:16px;box-shadow:0 18px 60px #0003;overflow:hidden;display:flex;flex-direction:column}.qpy-panel header{height:60px;padding:0 15px;background:#171923;color:#fff;display:grid;grid-template-columns:1fr auto;align-content:center;flex:none}.qpy-panel header small{grid-column:1;color:#b9bec8;font-size:11px}.qpy-panel header button{grid-column:2;grid-row:1/3;border:0;background:transparent;color:#fff;font-size:24px}.qpy-panel main{flex:1;padding:14px;background:#f5f6f8;overflow:auto}.qpy-panel main p{max-width:78%;padding:9px 11px;border-radius:10px;line-height:1.45;margin:7px 0}.qpy-ai{background:#fff}.qpy-user{background:#4c50ee;color:#fff;margin-left:auto!important}.qpy-panel form{height:64px;display:flex;gap:7px;padding:10px;border-top:1px solid #e1e3e8;flex:none}.qpy-panel input{flex:1;min-width:0;border:1px solid #d9dce3;border-radius:8px;padding:0 10px}.qpy-panel form button{width:42px;border:0;border-radius:8px;background:#4c50ee;color:#fff}.qpy-panel form button:disabled{opacity:.5}";
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
  launch.onclick = function () { panel.hidden = false; launch.hidden = true; input.focus(); };
  close.onclick = function () { panel.hidden = true; launch.hidden = false; };
  if (!workspaceId) {
    messages.insertAdjacentHTML("beforeend", '<p class="qpy-ai">This chat widget is missing its workspace id — copy the install code again from Qpy Engage Channels settings.</p>');
  }
  form.onsubmit = function (event) {
    event.preventDefault();
    if (!workspaceId) return;
    var text = input.value.trim();
    if (!text) return;
    messages.insertAdjacentHTML("beforeend", '<p class="qpy-user"></p>');
    messages.lastElementChild.textContent = text;
    input.value = "";
    input.disabled = true;
    sendButton.disabled = true;
    messages.scrollTop = messages.scrollHeight;
    fetch(API_ORIGIN + "/api/widget/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspaceId, message: text, history: history }),
    })
      .then(function (response) { return response.json().then(function (data) { return { ok: response.ok, data: data }; }); })
      .then(function (result) {
        var answer = result.ok && result.data && result.data.reply ? result.data.reply : (result.data && result.data.error) || "Sorry, I couldn't respond right now.";
        history.push({ role: "user", content: text });
        if (result.ok) history.push({ role: "assistant", content: answer });
        messages.insertAdjacentHTML("beforeend", '<p class="qpy-ai"></p>');
        messages.lastElementChild.textContent = answer;
        messages.scrollTop = messages.scrollHeight;
      })
      .catch(function () {
        messages.insertAdjacentHTML("beforeend", '<p class="qpy-ai"></p>');
        messages.lastElementChild.textContent = "Sorry, I couldn't reach support chat right now. Please try again shortly.";
        messages.scrollTop = messages.scrollHeight;
      })
      .then(function () { input.disabled = false; sendButton.disabled = false; input.focus(); });
  };
})();
