"use client";

import { useEffect, useMemo, useState } from "react";
import "./admin.css";

const META_BACKEND_ORIGIN = "https://qpy-engage-api.qpy-engage.workers.dev";
const metaApi = (path: string) => `${typeof location !== "undefined" && location.hostname.endsWith("github.io") ? META_BACKEND_ORIGIN : ""}${path}`;
const AUTH_TOKEN_KEY = "qpy-engage-auth-token";
const IMPERSONATION_HANDOFF_KEY = "qpy-engage-impersonation-handoff";
const authHeaders = (token: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

type AuthUser = { id: string; email: string; name: string | null; isSuperadmin?: boolean };
type AuthWorkspace = { id: string; name: string };

const PLAN_OPTIONS = ["Free", "Starter", "Growth", "Scale", "Enterprise"];
const MESSAGE_CATEGORIES = ["Marketing", "Utility", "Authentication", "Service"];
const FEATURE_KEYS = ["whatsapp", "instagram", "webWidget", "aiActions", "ordersQpy", "analytics", "prioritySupport", "whiteLabel"] as const;
const FEATURE_LABELS: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram", webWidget: "Web widget", aiActions: "AI Actions", ordersQpy: "Orders (qpy.ai)", analytics: "Analytics", prioritySupport: "Priority support", whiteLabel: "White-label" };
const AVATAR_PALETTE = [["#eef1ff", "#4038c9"], ["#e7f8f1", "#0d8a56"], ["#fff3e0", "#b1600f"], ["#fdeaea", "#c73838"], ["#fbeaf6", "#a8348e"]];

type WorkspaceRow = {
  id: string; name: string; ownerEmail: string | null; createdAt: string;
  webChatMessageCount: number; webChatConversationCount: number; whatsappConnected: boolean;
  whatsappMessageCount: number; leadsCount: number; messagesSentTotal: number;
  status: "active" | "disabled"; plan: string;
};
type PlanPricingRow = { plan: string; priceUsd: number };
type PlanLimitRow = { plan: string; category: string; messageLimit: number };
type PlanFeatureRow = { plan: string; feature: string; enabled: boolean };
type TemplateActionDef = { name: string; description: string; endpoint: string; method: "POST" | "GET"; type: "submit" | "request" };
type AdminTemplate = { id: string; name: string; description: string; action: TemplateActionDef; createdAt: string; updatedAt: string };
type QpyIntegration = { connected: boolean; hasApiKey: boolean; channels: { whatsapp: boolean; instagram: boolean; webchat: boolean }; autoConfirmOrders: boolean; notifyEmail: string };

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
}

function statusStyle(status: "active" | "disabled" | "trial") {
  if (status === "active") return { cls: "st-active", label: "Active" };
  if (status === "trial") return { cls: "st-trial", label: "Trial" };
  return { cls: "st-suspended", label: "Suspended" };
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const stored = (() => { try { return localStorage.getItem(AUTH_TOKEN_KEY) } catch { return null } })();
    if (!stored) { setChecking(false); return }
    (async () => {
      try {
        const response = await fetch(metaApi("/api/auth/session"), { headers: authHeaders(stored) });
        if (response.ok) {
          const data = await response.json() as { user: AuthUser };
          if (!cancelled) { setToken(stored); setUser(data.user) }
        }
      } catch { /* offline — fall through to access-denied */ }
      if (!cancelled) setChecking(false);
    })();
    return () => { cancelled = true };
  }, []);

  if (checking) return <div className="adm-loading">Loading Superadmin console…</div>;
  if (!token || !user?.isSuperadmin) return <div className="adm-loading adm-denied">
    <div>
      <h1>Superadmin console</h1>
      <p>{token ? "This account doesn't have superadmin access." : "Sign in to your Qpy Engage account first."}</p>
      <a href="../" className="adm-btn-primary">← Back to Qpy Engage</a>
    </div>
  </div>;
  return <Console token={token} user={user}/>;
}

function Console({ token, user }: { token: string; user: AuthUser }) {
  const [view, setView] = useState<"dashboard" | "customers" | "plans" | "automations" | "integrations" | "analytics">("dashboard");
  const [search, setSearch] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [wsLoading, setWsLoading] = useState(true);
  const [wsError, setWsError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impersonateNotice, setImpersonateNotice] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const [pricing, setPricing] = useState<PlanPricingRow[]>([]);
  const [limits, setLimits] = useState<PlanLimitRow[]>([]);
  const [features, setFeatures] = useState<PlanFeatureRow[]>([]);
  const [planLoading, setPlanLoading] = useState(true);

  const [templates, setTemplates] = useState<AdminTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [deployTarget, setDeployTarget] = useState<Record<string, "all" | string[]>>({});
  const [deployBusy, setDeployBusy] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<Record<string, string>>({});

  const [qpy, setQpy] = useState<QpyIntegration | null>(null);
  const [qpyLoading, setQpyLoading] = useState(true);
  const [qpyKeyDraft, setQpyKeyDraft] = useState("");

  const loadWorkspaces = async () => {
    setWsLoading(true); setWsError("");
    try {
      const response = await fetch(metaApi("/api/admin/workspaces"), { headers: authHeaders(token) });
      const result = await response.json() as { workspaces?: WorkspaceRow[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load customers.");
      setWorkspaces(result.workspaces || []);
    } catch (err) { setWsError(err instanceof Error ? err.message : "Could not load customers.") }
    finally { setWsLoading(false) }
  };
  const loadPlanConfig = async () => {
    setPlanLoading(true);
    try {
      const [pr, lr, fr] = await Promise.all([
        fetch(metaApi("/api/admin/plan-pricing"), { headers: authHeaders(token) }),
        fetch(metaApi("/api/admin/plan-limits"), { headers: authHeaders(token) }),
        fetch(metaApi("/api/admin/plan-features"), { headers: authHeaders(token) }),
      ]);
      const [pd, ld, fd] = await Promise.all([pr.json(), lr.json(), fr.json()]) as [{ pricing?: PlanPricingRow[] }, { limits?: PlanLimitRow[] }, { features?: PlanFeatureRow[] }];
      setPricing(pd.pricing || []); setLimits(ld.limits || []); setFeatures(fd.features || []);
    } catch { /* leave previous values */ }
    finally { setPlanLoading(false) }
  };
  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const response = await fetch(metaApi("/api/admin/templates"), { headers: authHeaders(token) });
      const result = await response.json() as { templates?: AdminTemplate[] };
      setTemplates(result.templates || []);
    } catch { /* leave previous values */ }
    finally { setTemplatesLoading(false) }
  };
  const loadQpy = async () => {
    setQpyLoading(true);
    try {
      const response = await fetch(metaApi("/api/admin/integrations/qpy"), { headers: authHeaders(token) });
      const result = await response.json() as { integration?: QpyIntegration };
      if (result.integration) setQpy(result.integration);
    } catch { /* leave previous values */ }
    finally { setQpyLoading(false) }
  };

  useEffect(() => { loadWorkspaces(); loadPlanConfig(); loadTemplates(); loadQpy(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const patchWorkspace = async (ws: WorkspaceRow, changes: { status?: string; plan?: string }) => {
    setSavingId(ws.id);
    const previous = workspaces;
    setWorkspaces(workspaces.map((w) => (w.id === ws.id ? { ...w, ...changes } as WorkspaceRow : w)));
    try {
      const response = await fetch(metaApi(`/api/admin/workspaces/${ws.id}`), { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify(changes) });
      const result = await response.json() as { saved?: boolean; error?: string };
      if (!response.ok || !result.saved) throw new Error(result.error || "Could not update this customer.");
    } catch (err) { setWorkspaces(previous); setWsError(err instanceof Error ? err.message : "Could not update this customer.") }
    finally { setSavingId(null) }
  };

  const impersonate = async (ws: WorkspaceRow) => {
    setManagingId(ws.id);
    try {
      const response = await fetch(metaApi("/api/admin/impersonate"), { method: "POST", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ workspaceId: ws.id }) });
      const result = await response.json() as { token?: string; workspace?: AuthWorkspace; error?: string };
      if (!response.ok || !result.token || !result.workspace) throw new Error(result.error || "Could not open this customer's workspace.");
      setImpersonateNotice(true);
      localStorage.setItem(IMPERSONATION_HANDOFF_KEY, JSON.stringify({ token: result.token, workspace: result.workspace, adminToken: token, adminUser: user }));
      setTimeout(() => { location.href = "../" }, 700);
    } catch (err) { setWsError(err instanceof Error ? err.message : "Could not open this customer's workspace."); setManagingId(null) }
  };

  const savePricing = async (plan: string, priceUsd: number) => {
    setPricing(pricing.map((p) => (p.plan === plan ? { ...p, priceUsd } : p)));
    try { await fetch(metaApi("/api/admin/plan-pricing"), { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ plan, priceUsd }) }) } catch { /* best-effort UI, refetch on view revisit corrects drift */ }
  };
  const saveLimit = async (plan: string, category: string, messageLimit: number) => {
    setLimits(limits.map((l) => (l.plan === plan && l.category === category ? { ...l, messageLimit } : l)));
    try { await fetch(metaApi("/api/admin/plan-limits"), { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ plan, category, messageLimit }) }) } catch { /* best-effort */ }
  };
  const toggleFeature = async (plan: string, feature: string) => {
    const current = features.find((f) => f.plan === plan && f.feature === feature)?.enabled ?? false;
    setFeatures(features.map((f) => (f.plan === plan && f.feature === feature ? { ...f, enabled: !current } : f)));
    try { await fetch(metaApi("/api/admin/plan-features"), { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ plan, feature, enabled: !current }) }) } catch { /* best-effort */ }
  };

  const deployTemplate = async (t: AdminTemplate) => {
    const target = deployTarget[t.id] ?? "all";
    if (Array.isArray(target) && !target.length) { setDeployResult({ ...deployResult, [t.id]: "Select at least one customer." }); return }
    setDeployBusy(t.id); setDeployResult({ ...deployResult, [t.id]: "" });
    try {
      const response = await fetch(metaApi(`/api/admin/templates/${t.id}/deploy`), { method: "POST", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ target }) });
      const result = await response.json() as { deployed?: number; error?: string };
      if (!response.ok || result.deployed === undefined) throw new Error(result.error || "Could not deploy this template.");
      setDeployResult({ ...deployResult, [t.id]: `Deployed to ${result.deployed} customer${result.deployed === 1 ? "" : "s"}.` });
      setDeployingId(null);
    } catch (err) { setDeployResult({ ...deployResult, [t.id]: err instanceof Error ? err.message : "Could not deploy this template." }) }
    finally { setDeployBusy(null) }
  };

  const patchQpy = async (changes: Partial<{ connected: boolean; apiKey: string; channels: Partial<QpyIntegration["channels"]>; autoConfirmOrders: boolean; notifyEmail: string }>) => {
    if (!qpy) return;
    const next: QpyIntegration = { ...qpy, ...changes, channels: { ...qpy.channels, ...(changes.channels || {}) } } as QpyIntegration;
    if (changes.apiKey !== undefined) next.hasApiKey = Boolean(changes.apiKey);
    setQpy(next);
    try { await fetch(metaApi("/api/admin/integrations/qpy"), { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify(changes) }) } catch { /* best-effort */ }
  };

  const decorated = useMemo(() => workspaces.map((w, i) => {
    const st = statusStyle(w.status);
    const [avatarBg, avatarColor] = AVATAR_PALETTE[i % AVATAR_PALETTE.length];
    return { ...w, initials: initials(w.name), avatarBg, avatarColor, statusClass: st.cls, statusLabel: st.label };
  }), [workspaces]);

  const filtered = search.trim()
    ? decorated.filter((w) => w.name.toLowerCase().includes(search.toLowerCase()) || (w.ownerEmail || "").toLowerCase().includes(search.toLowerCase()))
    : decorated;

  const priceFor = (plan: string) => pricing.find((p) => p.plan === plan)?.priceUsd ?? 0;
  const activeWorkspaces = workspaces.filter((w) => w.status === "active");
  const platformMrr = activeWorkspaces.reduce((sum, w) => sum + priceFor(w.plan), 0);
  const suspendedCount = workspaces.filter((w) => w.status === "disabled").length;
  const now = new Date();
  const newThisMonth = workspaces.filter((w) => { const d = new Date(w.createdAt); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() }).length;

  const recentSignups = decorated.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);

  const alerts: { title: string; detail: string; dot: string }[] = [];
  const disabledWs = workspaces.filter((w) => w.status === "disabled");
  if (disabledWs.length) alerts.push({ title: `${disabledWs.length} account${disabledWs.length === 1 ? "" : "s"} suspended`, detail: disabledWs.slice(0, 3).map((w) => w.name).join(", "), dot: "#d64545" });
  if (recentSignups[0]) alerts.push({ title: "Most recent signup", detail: `${recentSignups[0].name} · joined ${new Date(recentSignups[0].createdAt).toLocaleDateString()}`, dot: "#2e9e5b" });
  const latestTemplate = templates.slice().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (latestTemplate) alerts.push({ title: "Automation template updated", detail: `${latestTemplate.name} · ${new Date(latestTemplate.updatedAt).toLocaleDateString()}`, dot: "#4c50ee" });
  const noWhatsapp = workspaces.filter((w) => w.status === "active" && !w.whatsappConnected).length;
  if (noWhatsapp) alerts.push({ title: `${noWhatsapp} active customer${noWhatsapp === 1 ? "" : "s"} without WhatsApp connected`, detail: "Onboarding incomplete — no phone number linked yet.", dot: "#c98a1d" });

  const selected = selectedId ? decorated.find((w) => w.id === selectedId) || null : null;

  const titles: Record<string, [string, string]> = {
    dashboard: ["Dashboard", "Platform overview"],
    customers: ["Customers", `${workspaces.length} workspaces`],
    plans: ["Plans & Billing", "Manage subscription tiers"],
    automations: ["Automation Templates", "AI Action library"],
    integrations: ["Integrations", "Connect external services"],
    analytics: ["Analytics", "Platform-wide performance"],
  };

  const navItems: { key: typeof view; label: string; icon: string }[] = [
    { key: "dashboard", label: "Dashboard", icon: "▦" },
    { key: "customers", label: "Customers", icon: "◍" },
    { key: "plans", label: "Plans & Billing", icon: "◆" },
    { key: "automations", label: "Automation Templates", icon: "⟳" },
    { key: "integrations", label: "Integrations", icon: "⇄" },
    { key: "analytics", label: "Analytics", icon: "▥" },
  ];

  return <div className="adm-shell">
    <div className="adm-sidebar">
      <div className="adm-brand"><div className="adm-logo">Q</div><div className="adm-brand-name">Qpy Engage</div></div>
      <div className="adm-badge"><div className="adm-sa-avatar">SA</div><div><div className="adm-sa-name">{user.name || "Superadmin"}</div><div className="adm-sa-sub">Platform control</div></div></div>
      <nav className="adm-nav">
        {navItems.map((n) => <button key={n.key} className={view === n.key ? "active" : ""} onClick={() => setView(n.key)}>
          <span className="adm-nav-icon">{n.icon}</span><span>{n.label}</span>
        </button>)}
      </nav>
      <div className="adm-mrr-card">
        <div className="adm-mrr-label">Platform MRR</div>
        <div className="adm-mrr-value">${platformMrr.toLocaleString()}</div>
        <div className="adm-mrr-note">{activeWorkspaces.length} active workspace{activeWorkspaces.length === 1 ? "" : "s"}</div>
      </div>
      <a href="../" className="adm-exit">← Back to my workspace</a>
    </div>

    <div className="adm-main">
      <div className="adm-topbar">
        <div className="adm-title-row"><div className="adm-title">{titles[view][0]}</div><span className="adm-dot"/><span className="adm-subtitle">{titles[view][1]}</span></div>
        <div className="adm-topbar-actions">
          <input placeholder="Search customers, plans..." value={search} onChange={(e) => setSearch(e.target.value)}/>
          <div className="adm-sa-avatar dark">SA</div>
        </div>
      </div>

      <div className="adm-content">
        {wsError && <div className="adm-error">⚠ {wsError}</div>}

        {view === "dashboard" && <div>
          <div className="adm-kpi-grid">
            <div className="adm-kpi-card"><div className="adm-kpi-top"><span className="adm-kpi-icon indigo">◍</span><span>Total customers</span></div><div className="adm-kpi-value">{workspaces.length}</div><div className="adm-kpi-delta neutral">{newThisMonth} new this month</div></div>
            <div className="adm-kpi-card"><div className="adm-kpi-top"><span className="adm-kpi-icon green">$</span><span>Platform MRR</span></div><div className="adm-kpi-value">${platformMrr.toLocaleString()}</div><div className="adm-kpi-delta good">list-price estimate</div></div>
            <div className="adm-kpi-card"><div className="adm-kpi-top"><span className="adm-kpi-icon green">✓</span><span>Active accounts</span></div><div className="adm-kpi-value">{activeWorkspaces.length}</div><div className="adm-kpi-delta bad">{suspendedCount} suspended</div></div>
            <div className="adm-kpi-card"><div className="adm-kpi-top"><span className="adm-kpi-icon coral">＋</span><span>New this month</span></div><div className="adm-kpi-value">{newThisMonth}</div><div className="adm-kpi-delta neutral">signups</div></div>
          </div>
          <div className="adm-two-col">
            <div className="adm-card">
              <div className="adm-card-head"><div className="adm-card-title">Recent signups</div><a href="#" onClick={(e) => { e.preventDefault(); setView("customers") }}>View all →</a></div>
              {wsLoading ? <p className="adm-hint">Loading…</p> : !recentSignups.length ? <p className="adm-hint">No customer workspaces yet.</p> :
              recentSignups.map((c) => <div key={c.id} className="adm-signup-row">
                <div className="adm-signup-left"><div className="adm-avatar" style={{ background: c.avatarBg, color: c.avatarColor }}>{c.initials}</div>
                  <div><div className="adm-signup-name">{c.name}</div><div className="adm-signup-sub">{c.plan} plan · joined {new Date(c.createdAt).toLocaleDateString()}</div></div></div>
                <span className={`adm-status-pill ${c.statusClass}`}>{c.statusLabel}</span>
              </div>)}
            </div>
            <div className="adm-card">
              <div className="adm-card-head"><div className="adm-card-title">Platform alerts</div></div>
              {!alerts.length ? <p className="adm-hint">No alerts right now.</p> : alerts.map((a, i) => <div key={i} className="adm-alert-row">
                <div className="adm-alert-dot" style={{ background: a.dot }}/>
                <div><div className="adm-alert-title">{a.title}</div><div className="adm-alert-detail">{a.detail}</div></div>
              </div>)}
            </div>
          </div>
        </div>}

        {view === "customers" && <div>
          <div className="adm-list-hint">{filtered.length} of {workspaces.length} customers</div>
          <div className="adm-table-card">
            <div className="adm-table-head"><div>Customer</div><div>Plan</div><div>MRR</div><div>Convos</div><div>Status</div><div/></div>
            {wsLoading ? <p className="adm-hint" style={{ padding: "16px 20px" }}>Loading…</p> : !filtered.length ? <p className="adm-hint" style={{ padding: "16px 20px" }}>No customers match.</p> :
            filtered.map((c) => <div key={c.id} className="adm-table-row" onClick={() => { setSelectedId(c.id); setImpersonateNotice(false) }}>
              <div className="adm-signup-left"><div className="adm-avatar sq" style={{ background: c.avatarBg, color: c.avatarColor }}>{c.initials}</div>
                <div><div className="adm-signup-name">{c.name}</div><div className="adm-signup-sub">{c.ownerEmail || "—"}</div></div></div>
              <div>{c.plan}</div>
              <div>${priceFor(c.plan).toLocaleString()}</div>
              <div>{(c.webChatConversationCount + c.whatsappMessageCount).toLocaleString()}</div>
              <div><span className={`adm-status-pill ${c.statusClass}`}>{c.statusLabel}</span></div>
              <div className="adm-view-link">View →</div>
            </div>)}
          </div>
        </div>}

        {view === "plans" && <div>
          <div className="adm-list-hint">{PLAN_OPTIONS.length} tiers · assign directly from a customer's profile · <em>feature toggles configure what's nominally included per tier — not yet enforced elsewhere in the app</em></div>
          <div className="adm-plans-grid">
            {PLAN_OPTIONS.map((plan) => {
              const planWorkspaceCount = workspaces.filter((w) => w.plan === plan).length;
              const planFeatures = FEATURE_KEYS.map((fk) => ({ key: fk, enabled: features.find((f) => f.plan === plan && f.feature === fk)?.enabled ?? false }));
              return <div key={plan} className={`adm-plan-card${plan === "Growth" ? " popular" : ""}`}>
                <div className="adm-plan-head">
                  <div className="adm-plan-name-row"><div className="adm-plan-name">{plan}</div>{plan === "Growth" && <span className="adm-popular-pill">POPULAR</span>}</div>
                  <div className="adm-plan-price"><input type="number" min="0" disabled={planLoading} value={priceFor(plan)} onChange={(e) => setPricing(pricing.map((p) => (p.plan === plan ? { ...p, priceUsd: Number(e.target.value) } : p)))} onBlur={(e) => savePricing(plan, Number(e.target.value))}/><span>/mo</span></div>
                </div>
                <div className="adm-plan-limits">
                  {MESSAGE_CATEGORIES.map((category) => {
                    const value = limits.find((l) => l.plan === plan && l.category === category)?.messageLimit ?? 0;
                    return <div key={category} className="adm-plan-limit-row"><span>{category} msgs/mo</span><input type="number" min="0" disabled={planLoading} value={value} onChange={(e) => setLimits(limits.map((l) => (l.plan === plan && l.category === category ? { ...l, messageLimit: Number(e.target.value) } : l)))} onBlur={(e) => saveLimit(plan, category, Number(e.target.value))}/></div>;
                  })}
                </div>
                <div className="adm-plan-features">
                  {planFeatures.map((f) => <div key={f.key} className="adm-toggle-row" onClick={() => toggleFeature(plan, f.key)}>
                    <span className={f.enabled ? "" : "off"}>{FEATURE_LABELS[f.key]}</span>
                    <div className={`adm-toggle ${f.enabled ? "on" : ""}`}><div className="adm-toggle-knob"/></div>
                  </div>)}
                </div>
                <div className="adm-plan-footer">{planWorkspaceCount} customer{planWorkspaceCount === 1 ? "" : "s"} on this plan</div>
              </div>;
            })}
          </div>
        </div>}

        {view === "automations" && <div>
          <div className="adm-list-hint">Reusable AI Action templates · deploy to all or specific customers</div>
          <div className="adm-templates-grid">
            {templatesLoading ? <p className="adm-hint">Loading…</p> : !templates.length ? <p className="adm-hint">No automation templates yet. Create one from a customer workspace's Automations tab, then deploy it here.</p> :
            templates.map((t) => {
              const target = deployTarget[t.id] ?? "all";
              const isDeploying = deployingId === t.id;
              return <div key={t.id} className="adm-template-card">
                <div className="adm-template-top"><div className="adm-template-icon">⟳</div><span className="adm-status-pill st-active">Active</span></div>
                <div><div className="adm-template-name">{t.name}</div><div className="adm-template-category">{t.action.type === "submit" ? "Data submit" : "Data request"}</div></div>
                <div className="adm-template-desc">{t.description || t.action.description}</div>
                {deployResult[t.id] && <div className="adm-deploy-result">{deployResult[t.id]}</div>}
                {isDeploying ? <div className="adm-deploy-panel">
                  <div className="adm-deploy-toggle">
                    <div className={target === "all" ? "on" : ""} onClick={() => setDeployTarget({ ...deployTarget, [t.id]: "all" })}>All customers</div>
                    <div className={Array.isArray(target) ? "on" : ""} onClick={() => setDeployTarget({ ...deployTarget, [t.id]: [] })}>Specific</div>
                  </div>
                  {Array.isArray(target) && <div className="adm-deploy-specific">{workspaces.map((ws) => <label key={ws.id}><input type="checkbox" checked={target.includes(ws.id)} onChange={() => setDeployTarget({ ...deployTarget, [t.id]: target.includes(ws.id) ? target.filter((id) => id !== ws.id) : [...target, ws.id] })}/> {ws.name}</label>)}</div>}
                  <button className="adm-btn-dark" disabled={deployBusy === t.id} onClick={() => deployTemplate(t)}>{deployBusy === t.id ? "Deploying…" : "Confirm deploy"}</button>
                </div> : <button className="adm-btn-outline" onClick={() => { setDeployingId(t.id); setDeployTarget({ ...deployTarget, [t.id]: "all" }); setDeployResult({ ...deployResult, [t.id]: "" }) }}>Deploy →</button>}
              </div>;
            })}
          </div>
        </div>}

        {view === "integrations" && <div className="adm-integrations">
          {qpyLoading || !qpy ? <p className="adm-hint">Loading…</p> : <>
          <div className="adm-int-header">
            <div className="adm-signup-left"><div className="adm-qpy-mark">qpy</div><div><div className="adm-int-title">qpy.ai order capture</div><div className="adm-int-sub">Lets customers take orders through WhatsApp, Instagram and web chat.</div></div></div>
            <div className="adm-signup-left" style={{ gap: 12 }}>
              <span className={`adm-status-pill ${qpy.connected ? "st-active" : "st-suspended"}`}>{qpy.connected ? "Connected" : "Not connected"}</span>
              <button className="adm-btn-outline" onClick={() => patchQpy({ connected: !qpy.connected })}>{qpy.connected ? "Disconnect" : "Reconnect"}</button>
            </div>
          </div>
          <div className="adm-card">
            <div className="adm-card-title">Order channels</div>
            {(["whatsapp", "instagram", "webchat"] as const).map((ch) => <div key={ch} className="adm-toggle-row" onClick={() => patchQpy({ channels: { [ch]: !qpy.channels[ch] } })}>
              <span className={qpy.channels[ch] ? "" : "off"}>{ch === "whatsapp" ? "WhatsApp" : ch === "instagram" ? "Instagram" : "Web chat widget"}</span>
              <div className={`adm-toggle ${qpy.channels[ch] ? "on" : ""}`}><div className="adm-toggle-knob"/></div>
            </div>)}
          </div>
          <div className="adm-card">
            <div className="adm-card-title">API credentials</div>
            {qpy.hasApiKey ? <div className="adm-key-row"><span>sk_live_••••••••••••••••••</span><span className="adm-link" onClick={() => patchQpy({ apiKey: "" })}>Remove</span></div> :
            <div className="adm-key-row"><input placeholder="Paste qpy.ai API key" value={qpyKeyDraft} onChange={(e) => setQpyKeyDraft(e.target.value)}/><span className="adm-link" onClick={() => { if (qpyKeyDraft.trim()) { patchQpy({ apiKey: qpyKeyDraft.trim() }); setQpyKeyDraft("") } }}>Save</span></div>}
            <div className="adm-int-webhook">Webhook URL: <code>{META_BACKEND_ORIGIN}/webhooks/qpy-orders</code></div>
          </div>
          <div className="adm-card">
            <div className="adm-card-title">Order settings</div>
            <div className="adm-toggle-row" onClick={() => patchQpy({ autoConfirmOrders: !qpy.autoConfirmOrders })} style={{ marginBottom: 16 }}>
              <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>Auto-confirm orders</div><div className="adm-hint" style={{ marginTop: 2 }}>Skip manual review before an order is placed with the customer's store.</div></div>
              <div className={`adm-toggle ${qpy.autoConfirmOrders ? "on" : ""}`}><div className="adm-toggle-knob"/></div>
            </div>
            <div className="adm-hint" style={{ marginBottom: 6 }}>Order notification email</div>
            <input className="adm-full-input" value={qpy.notifyEmail} onChange={(e) => setQpy({ ...qpy, notifyEmail: e.target.value })} onBlur={(e) => patchQpy({ notifyEmail: e.target.value })}/>
          </div>
          <div className="adm-card">
            <div className="adm-card-title">Plan availability</div>
            <div className="adm-hint" style={{ marginBottom: 14 }}>Which tiers include qpy.ai order capture.</div>
            {PLAN_OPTIONS.map((plan) => { const enabled = features.find((f) => f.plan === plan && f.feature === "ordersQpy")?.enabled ?? false; return <div key={plan} className="adm-toggle-row" onClick={() => toggleFeature(plan, "ordersQpy")}>
              <span className={enabled ? "" : "off"}>{plan}</span>
              <div className={`adm-toggle ${enabled ? "on" : ""}`}><div className="adm-toggle-knob"/></div>
            </div>; })}
          </div>
          </>}
        </div>}

        {view === "analytics" && <div>
          <div className="adm-kpi-grid">
            <div className="adm-kpi-card"><div className="adm-kpi-label">Total web conversations</div><div className="adm-kpi-value sm">{workspaces.reduce((s, w) => s + w.webChatConversationCount, 0).toLocaleString()}</div></div>
            <div className="adm-kpi-card"><div className="adm-kpi-label">Total WhatsApp messages</div><div className="adm-kpi-value sm">{workspaces.reduce((s, w) => s + w.whatsappMessageCount, 0).toLocaleString()}</div></div>
            <div className="adm-kpi-card"><div className="adm-kpi-label">Total leads captured</div><div className="adm-kpi-value sm">{workspaces.reduce((s, w) => s + w.leadsCount, 0).toLocaleString()}</div></div>
            <div className="adm-kpi-card"><div className="adm-kpi-label">Platform MRR</div><div className="adm-kpi-value sm">${platformMrr.toLocaleString()}</div></div>
          </div>
          <div className="adm-two-col">
            <div className="adm-card">
              <div className="adm-card-title" style={{ marginBottom: 18 }}>Revenue by plan (active customers × list price)</div>
              <div className="adm-bars">
                {PLAN_OPTIONS.map((plan) => {
                  const rev = activeWorkspaces.filter((w) => w.plan === plan).length * priceFor(plan);
                  const max = Math.max(1, ...PLAN_OPTIONS.map((p) => activeWorkspaces.filter((w) => w.plan === p).length * priceFor(p)));
                  return <div key={plan} className="adm-bar-col"><div className="adm-bar" style={{ height: `${Math.round((rev / max) * 100)}%` }}/><div className="adm-bar-label">{plan}</div></div>;
                })}
              </div>
            </div>
            <div className="adm-card">
              <div className="adm-card-title" style={{ marginBottom: 16 }}>Plan distribution</div>
              {PLAN_OPTIONS.map((plan) => {
                const count = workspaces.filter((w) => w.plan === plan).length;
                const pct = workspaces.length ? Math.round((count / workspaces.length) * 100) : 0;
                return <div key={plan} className="adm-dist-row">
                  <div className="adm-dist-label"><span>{plan}</span><span>{count} customers</span></div>
                  <div className="adm-dist-track"><div className="adm-dist-fill" style={{ width: `${pct}%` }}/></div>
                </div>;
              })}
            </div>
          </div>
        </div>}
      </div>
    </div>

    {selected && <div className="adm-drawer-backdrop" onClick={() => setSelectedId(null)}>
      <div className="adm-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="adm-drawer-head"><span>Customer profile</span><span className="adm-close" onClick={() => setSelectedId(null)}>✕</span></div>
        <div className="adm-drawer-top"><div className="adm-avatar lg" style={{ background: selected.avatarBg, color: selected.avatarColor }}>{selected.initials}</div>
          <div><div className="adm-drawer-name">{selected.name}</div><div className="adm-drawer-sub">{selected.ownerEmail || "—"}</div></div></div>
        <div className="adm-drawer-actions">
          <button className="adm-btn-dark" disabled={managingId === selected.id} onClick={() => impersonate(selected)}>{managingId === selected.id ? "Opening…" : "Impersonate"}</button>
          <button className="adm-btn-outline" disabled={savingId === selected.id} onClick={() => patchWorkspace(selected, { status: selected.status === "disabled" ? "active" : "disabled" })}>{selected.status === "disabled" ? "Reactivate" : "Suspend"}</button>
        </div>
        {impersonateNotice && <div className="adm-notice">Opening an impersonation session — you'll land in {selected.name}&apos;s workspace.</div>}
        <div className="adm-drawer-card">
          <div className="adm-drawer-card-title">Account</div>
          <div className="adm-kv"><span>Status</span><span className={`adm-status-pill ${selected.statusClass}`}>{selected.statusLabel}</span></div>
          <div className="adm-kv"><span>Plan</span><select value={selected.plan} disabled={savingId === selected.id} onChange={(e) => patchWorkspace(selected, { plan: e.target.value })}>{PLAN_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
          <div className="adm-kv"><span>MRR</span><strong>${priceFor(selected.plan).toLocaleString()}</strong></div>
          <div className="adm-kv"><span>Joined</span><strong>{new Date(selected.createdAt).toLocaleDateString()}</strong></div>
          <div className="adm-kv"><span>WhatsApp</span><strong>{selected.whatsappConnected ? "Connected" : "Not connected"}</strong></div>
        </div>
        <div className="adm-drawer-card">
          <div className="adm-drawer-card-title">Usage</div>
          <div className="adm-usage-grid">
            <div><div className="adm-usage-value">{selected.webChatConversationCount.toLocaleString()}</div><div className="adm-usage-label">Web conversations</div></div>
            <div><div className="adm-usage-value">{selected.whatsappMessageCount.toLocaleString()}</div><div className="adm-usage-label">WhatsApp messages</div></div>
            <div><div className="adm-usage-value">{selected.leadsCount.toLocaleString()}</div><div className="adm-usage-label">Leads captured</div></div>
          </div>
        </div>
        <div className="adm-drawer-card">
          <div className="adm-drawer-card-title">Messages sent this account (all-time)</div>
          <div className="adm-kv"><span>Total, all categories</span><strong>{selected.messagesSentTotal.toLocaleString()}</strong></div>
        </div>
      </div>
    </div>}
  </div>;
}
