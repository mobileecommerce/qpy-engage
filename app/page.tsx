"use client";

import { useState } from "react";

const conversations = [
  { initials: "AD", name: "Aisha D.", preview: "Perfect, I’ll take the blue one", time: "2m", unread: 2, tone: "lavender" },
  { initials: "JM", name: "Jonas Müller", preview: "Is shipping available to Berlin?", time: "8m", unread: 1, tone: "blue" },
  { initials: "SK", name: "Sofia Khan", preview: "Thanks for the quick help!", time: "24m", unread: 0, tone: "peach" },
  { initials: "RM", name: "Ravi Mehta", preview: "Can I change my delivery address?", time: "1h", unread: 0, tone: "green" },
];

const nav = [
  ["⌂", "Overview"], ["◉", "Inbox", "7"], ["✦", "Automations"], ["◇", "Knowledge"], ["▥", "Analytics"],
];

export default function Home() {
  const [section, setSection] = useState("Overview");
  const [selected, setSelected] = useState(0);
  const [messages, setMessages] = useState([
    { from: "customer", text: "Hi! I saw the Riviera linen shirt on your website. Is the ocean blue color available in medium?", time: "10:34" },
    { from: "ai", text: "Hi Aisha! Yes — the Riviera Linen Shirt in Ocean Blue is available in Medium. We currently have 6 left in stock. Would you like me to reserve one for your cart?", time: "10:34" },
    { from: "customer", text: "Perfect, I’ll take the blue one 💙", time: "10:36" },
    { from: "ai", text: "Lovely choice! I’ve added it to your cart and sent a secure checkout link. Your order qualifies for free delivery.", time: "10:36" },
  ]);
  const [draft, setDraft] = useState("");
  const [aiActive, setAiActive] = useState(true);
  const [toast, setToast] = useState("");

  function notify(text: string) {
    setToast(text);
    window.setTimeout(() => setToast(""), 2200);
  }

  function sendMessage() {
    if (!draft.trim()) return;
    setMessages([...messages, { from: "agent", text: draft.trim(), time: "Now" }]);
    setDraft("");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">w</span><span>wavely</span></div>
        <div className="workspace"><span className="shop-avatar">A</span><div><strong>Atelier Home</strong><small>Business workspace</small></div><span className="chev">⌄</span></div>
        <nav className="side-nav" aria-label="Main navigation">
          {nav.map(([icon, label, count]) => <button key={label} onClick={() => setSection(label)} className={section === label ? "active" : ""}><span>{icon}</span>{label}{count && <b>{count}</b>}</button>)}
        </nav>
        <div className="nav-divider" />
        <nav className="side-nav secondary"><button onClick={() => notify("Team settings opened")}><span>♙</span>Team</button><button onClick={() => notify("Settings opened")}><span>⚙</span>Settings</button></nav>
        <div className="sidebar-card"><span className="spark">✦</span><strong>Grow with Wavely</strong><p>Unlock more conversations and advanced AI.</p><button onClick={() => notify("Upgrade options opened")}>Explore plans</button></div>
        <div className="profile"><span className="profile-avatar">PM</span><div><strong>Praveen M.</strong><small>praveen@atelier.co</small></div><button aria-label="Profile menu">•••</button></div>
      </aside>

      <section className="main-area">
        <header className="topbar"><button className="mobile-brand" onClick={() => setSection("Overview")}><span className="brand-mark">w</span>wavely</button><div className="top-title"><strong>{section}</strong><span>•</span><small>All systems running smoothly</small></div><div className="top-actions"><button aria-label="Search">⌕</button><button aria-label="Notifications" className="notification">♧<i /></button><button className="help" onClick={() => notify("Help center opened")}>?</button></div></header>

        <div className="content">
          <div className="welcome-row"><div><p className="eyebrow">FRIDAY, JULY 17</p><h1>Good morning, Praveen <span>👋</span></h1><p>Here’s what’s happening with Atelier Home today.</p></div><button className="primary" onClick={() => notify("New automation created")}>＋ Create automation</button></div>

          <section className="setup-card">
            <div className="setup-head"><div><span className="setup-icon">✦</span><div><h2>Set up your AI teammate</h2><p>Three quick steps to start turning conversations into customers.</p></div></div><div className="progress-label"><strong>2 of 3 complete</strong><div><i /></div></div></div>
            <div className="steps">
              <button className="step complete" onClick={() => notify("WhatsApp is connected")}><span>✓</span><div><strong>Connect WhatsApp Business</strong><small>+971 50 284 8102 connected</small></div><b>Connected</b></button>
              <button className="step complete" onClick={() => notify("Knowledge sources opened")}><span>✓</span><div><strong>Train your AI</strong><small>Website + 4 documents added</small></div><b>12.4k pages</b></button>
              <button className="step current" onClick={() => notify("Opening assistant setup")}><span>3</span><div><strong>Personalize your assistant</strong><small>Set its tone, goals, and guardrails</small></div><b>Continue →</b></button>
            </div>
          </section>

          <section className="metrics-grid">
            <article><div className="metric-label"><span className="metric-icon green">↗</span><p>Conversations</p><button>•••</button></div><div className="metric-value"><strong>1,284</strong><span className="up">↗ 12.5%</span></div><small>vs. last 30 days</small><div className="sparkline green-line"><i/><i/><i/><i/><i/><i/><i/></div></article>
            <article><div className="metric-label"><span className="metric-icon purple">✦</span><p>AI resolution rate</p><button>•••</button></div><div className="metric-value"><strong>74.2%</strong><span className="up">↗ 8.1%</span></div><small>952 handled by AI</small><div className="donut"><b>74%</b></div></article>
            <article><div className="metric-label"><span className="metric-icon coral">⌁</span><p>Avg. response time</p><button>•••</button></div><div className="metric-value"><strong>8s</strong><span className="up">↓ 3s</span></div><small>AI + team average</small><div className="bars"><i/><i/><i/><i/><i/><i/><i/><i/></div></article>
            <article><div className="metric-label"><span className="metric-icon blue">◈</span><p>Revenue assisted</p><button>•••</button></div><div className="metric-value"><strong>$18.6k</strong><span className="up">↗ 21.4%</span></div><small>142 attributed orders</small><div className="sparkline blue-line"><i/><i/><i/><i/><i/><i/><i/></div></article>
          </section>

          <section className="workspace-grid">
            <article className="inbox-panel">
              <div className="panel-head"><div><h2>Live conversations</h2><span>7 waiting</span></div><button onClick={() => setSection("Inbox")}>Open inbox ↗</button></div>
              <div className="conversation-list">
                {conversations.map((c, i) => <button key={c.name} onClick={() => setSelected(i)} className={selected === i ? "selected" : ""}><span className={`contact-avatar ${c.tone}`}>{c.initials}<i /></span><div><strong>{c.name}</strong><small>{c.preview}</small></div><span className="conv-meta"><small>{c.time}</small>{c.unread > 0 && <b>{c.unread}</b>}</span></button>)}
              </div>
            </article>

            <article className="chat-panel">
              <div className="chat-head"><div className="chat-person"><span className="contact-avatar lavender">AD<i /></span><div><strong>Aisha D.</strong><small>WhatsApp • Online</small></div></div><div className="ai-state"><span className={aiActive ? "pulse" : "pulse off"}>✦</span><div><strong>{aiActive ? "AI is handling" : "You’re handling"}</strong><small>{aiActive ? "Confident response" : "Manual takeover"}</small></div><button onClick={() => setAiActive(!aiActive)}>{aiActive ? "Take over" : "Hand to AI"}</button></div></div>
              <div className="chat-body"><div className="today">Today</div>{messages.map((m, i) => <div key={i} className={`message ${m.from}`}><p>{m.text}</p><small>{m.from === "ai" && "✦ AI • "}{m.from === "agent" && "You • "}{m.time} {m.from !== "customer" && "✓✓"}</small></div>)}</div>
              <div className="composer"><div className="suggestion"><span>✦</span><p><strong>Suggested reply</strong> Ask if they’d like matching linen trousers</p><button onClick={() => setDraft("Would you like me to show you the matching Riviera linen trousers too?")}>Use</button></div><div className="input-row"><button aria-label="Add attachment">＋</button><input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Type a message…"/><button aria-label="Emoji">☺</button><button className="send" onClick={sendMessage}>➤</button></div></div>
            </article>
          </section>

          <section className="automation-section"><div className="section-head"><div><h2>Your automations</h2><p>Always-on workflows that keep your business moving.</p></div><button onClick={() => setSection("Automations")}>View all automations</button></div><div className="automation-grid">
            {[{icon:"✦",tone:"violet",title:"Product advisor",desc:"Recommends products from your catalog",stat:"418 runs",rate:"81% resolved"},{icon:"▣",tone:"blue",title:"Order updates",desc:"Tracks and shares delivery status",stat:"292 runs",rate:"94% resolved"},{icon:"♡",tone:"coral",title:"Abandoned cart",desc:"Re-engages customers after 2 hours",stat:"86 recovered",rate:"$4.2k revenue"}].map((a,i)=><article key={a.title}><div className="automation-top"><span className={`automation-icon ${a.tone}`}>{a.icon}</span><label><input type="checkbox" defaultChecked/><i /></label></div><h3>{a.title}</h3><p>{a.desc}</p><div><span>{a.stat}</span><strong>{a.rate}</strong></div></article>)}
            <button className="new-automation" onClick={() => notify("Automation builder opened")}><span>＋</span><strong>Create automation</strong><small>Build from scratch or use a template</small></button>
          </div></section>
        </div>
      </section>
      <nav className="mobile-nav" aria-label="Mobile navigation">{nav.slice(0,5).map(([icon,label])=><button key={label} onClick={()=>setSection(label)} className={section===label?"active":""}><span>{icon}</span><small>{label}</small></button>)}</nav>
      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}
