"use client";

import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import "./live-inbox.css";

type Section = "Overview" | "Assistants" | "Channels" | "Inbox" | "Campaigns" | "Audiences" | "Automations" | "Flows" | "Knowledge" | "Leads" | "Analytics" | "Team" | "Settings";
type Message = { from: "customer" | "ai" | "agent"; text: string; time: string };
type Conversation = { id: string; initials: string; name: string; preview: string; time: string; unread: number; tone: string; status: "open" | "resolved"; email: string; phone: string; tags: string[]; notes?: string[] };
type Automation = { id: number; title: string; trigger: string; action: string; runs: number; rate: string; active: boolean };
type Source = { id: number; name: string; type: "Website" | "Document" | "FAQ"; pages: number; status: "Ready" | "Syncing" | "Failed" };
type WidgetAppearance = { iconType: "brand" | "chat" | "help" | "spark" | "custom"; customIconUrl: string; placement: "left" | "right"; effect: "none" | "pulse" | "bounce"; color: string };
type WeekdayKey="sun"|"mon"|"tue"|"wed"|"thu"|"fri"|"sat";
type WorkingHours={enabled:boolean;timezone:string;days:Record<WeekdayKey,{open:boolean;start:string;end:string}>};
const WEEKDAYS:[WeekdayKey,string][]=[["sun","Sunday"],["mon","Monday"],["tue","Tuesday"],["wed","Wednesday"],["thu","Thursday"],["fri","Friday"],["sat","Saturday"]];
const DEFAULT_WORKING_HOURS:WorkingHours={enabled:false,timezone:"Asia/Dubai",days:{sun:{open:true,start:"09:00",end:"18:00"},mon:{open:true,start:"09:00",end:"18:00"},tue:{open:true,start:"09:00",end:"18:00"},wed:{open:true,start:"09:00",end:"18:00"},thu:{open:true,start:"09:00",end:"18:00"},fri:{open:false,start:"09:00",end:"18:00"},sat:{open:false,start:"09:00",end:"18:00"}}};
const TIMEZONE_OPTIONS=["Asia/Dubai","Asia/Riyadh","Asia/Karachi","Asia/Kolkata","Europe/London","Europe/Berlin","America/New_York","America/Chicago","America/Los_Angeles","Australia/Sydney","UTC"];
type Member = { id: string; userId: string | null; name: string; email: string; role: "Owner" | "Admin" | "Agent" | "Analyst"; status: "Active" | "Invited" };
type AuthUser = { id: string; email: string; name: string | null; isSuperadmin?: boolean };
type AuthWorkspace = { id: string; name: string };
type AuthSession = { token: string; user: AuthUser; workspace: AuthWorkspace; role: Member["role"] };
type Campaign = { id:number; name:string; channel:"WhatsApp"|"Instagram"; audience:string; audienceId:string; recipients:number; status:"Draft"|"Scheduled"|"Sent"; schedule:string; delivered:string; clicks:string; objective:string; message:string; mediaUrl:string; mediaName:string; cta:string; url:string; templateName:string; templateLanguage:string; scheduleType:string; date:string; time:string; recurrence:string; excludeRecent:boolean; messageCategory:"Marketing"|"Utility"; estimatedCost:number; sendErrors?:string[] };
type ActionParameter = { id:number; name:string; type:"text"|"number"|"email"|"phone"|"boolean"; required:boolean; description:string };
type AssistantAction = { id:number; name:string; description:string; type:"submit"|"request"; parameters:ActionParameter[]; endpoint:string; method:"POST"|"GET"; defaultResponse:string; confirmation:boolean; continueConversation:boolean; enabled:boolean; runs:number; success:string; lastTest:string };
type MetaConfig = { appId:string|null; configId:string|null; graphVersion:string; ready:boolean; webhookUrl:string; missing:string[] };
type MetaConnection = { businessId:string|null; wabaId:string; phoneNumberId:string; displayPhoneNumber:string|null; verifiedName:string|null; qualityRating:string|null; status:string|null; webhookSubscribed:boolean };
type LiveWhatsAppMessage = { id:string; direction:"inbound"|"outbound"; waId:string|null; type:string|null; text:string|null; status:string|null; timestamp:string|null; createdAt:string };

interface SpeechRecognitionResultLike { transcript: string }
interface SpeechRecognitionEventLike { results: { [index: number]: { [index: number]: SpeechRecognitionResultLike } } }
interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}

declare global {
  interface Window {
    FB?: { init:(options:Record<string,unknown>)=>void; login:(callback:(response:{authResponse?:{code?:string};status?:string})=>void,options:Record<string,unknown>)=>void };
    fbAsyncInit?:()=>void;
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const META_BACKEND_ORIGIN="https://qpy-engage-api.qpy-engage.workers.dev";
const metaApi=(path:string)=>`${typeof location!=="undefined"&&location.hostname.endsWith("github.io")?META_BACKEND_ORIGIN:""}${path}`;

function loadMetaSdk(config:MetaConfig):Promise<void>{
  if(window.FB){window.FB.init({appId:config.appId,cookie:true,xfbml:false,version:config.graphVersion});return Promise.resolve()}
  return new Promise((resolve,reject)=>{
    const timeout=window.setTimeout(()=>reject(new Error("Meta login took too long to load.")),15000);
    window.fbAsyncInit=()=>{window.clearTimeout(timeout);window.FB?.init({appId:config.appId,cookie:true,xfbml:false,version:config.graphVersion});resolve()};
    const existing=document.getElementById("facebook-jssdk");if(existing)return;
    const script=document.createElement("script");script.id="facebook-jssdk";script.async=true;script.defer=true;script.crossOrigin="anonymous";script.src="https://connect.facebook.net/en_US/sdk.js";script.onerror=()=>{window.clearTimeout(timeout);reject(new Error("Meta login could not be loaded."))};document.head.appendChild(script);
  });
}

// New workspaces start with none of this — it's only ever seen if a workspace's own saved
// state doesn't have a value yet, which no longer happens for real accounts once they add data.
const initialConversations: Conversation[] = [];
// A brand-new workspace has zero simulated WhatsApp conversations (real accounts get clean
// defaults, not seeded demo data) — `selected` must never be undefined even then, since
// Workspace reads `selected.id` unconditionally on every render whenever Inbox is the active
// section, regardless of whether any conversation actually exists yet.
const EMPTY_CONVERSATION: Conversation = { id: "", initials: "", name: "", preview: "", time: "", unread: 0, tone: "blue", status: "open", email: "", phone: "", tags: [] };

const initialMessages: Record<string, Message[]> = {};

const initialAutomations: Automation[] = [];

const initialSources: Source[] = [];


const initialCampaigns: Campaign[] = [
  {id:1,name:"Summer collection launch",channel:"WhatsApp",audience:"VIP customers",audienceId:"",recipients:1248,status:"Sent",schedule:"Jul 12, 10:00",delivered:"97.8%",clicks:"18.4%",objective:"Promote products",message:"Hi {{first_name}} 👋\n\nDiscover Atelier Home’s newest collection, created for effortless summer living. Shop now and enjoy complimentary UAE delivery.",mediaUrl:"",mediaName:"",cta:"Shop collection",url:"https://atelierhome.com/collections/summer",templateName:"",templateLanguage:"en_US",scheduleType:"Now",date:"2026-07-12",time:"10:00",recurrence:"One-time",excludeRecent:false,messageCategory:"Marketing",estimatedCost:62.4},
  {id:2,name:"Weekend showroom event",channel:"Instagram",audience:"Dubai customers",audienceId:"",recipients:862,status:"Scheduled",schedule:"Jul 19, 09:30",delivered:"—",clicks:"—",objective:"Announce an event",message:"Join us this weekend for an exclusive showroom preview — refreshments, styling advice, and early access to new arrivals.",mediaUrl:"",mediaName:"",cta:"RSVP now",url:"https://atelierhome.com/events/showroom",templateName:"",templateLanguage:"en_US",scheduleType:"Schedule",date:"2026-07-19",time:"09:30",recurrence:"One-time",excludeRecent:false,messageCategory:"Marketing",estimatedCost:43.1},
  {id:3,name:"Win-back offer",channel:"WhatsApp",audience:"Inactive 90 days",audienceId:"",recipients:436,status:"Draft",schedule:"Not scheduled",delivered:"—",clicks:"—",objective:"Recover customers",message:"We miss you, {{first_name}}! Here’s 15% off your next order to welcome you back.",mediaUrl:"",mediaName:"",cta:"Shop now",url:"https://atelierhome.com",templateName:"",templateLanguage:"en_US",scheduleType:"Now",date:"2026-07-19",time:"10:00",recurrence:"One-time",excludeRecent:false,messageCategory:"Marketing",estimatedCost:21.8},
];

const nav: [string, Section][] = [["⌂","Overview"],["✦","Assistants"],["◫","Channels"],["◉","Inbox"],["◈","Campaigns"],["♟","Audiences"],["⌁","Automations"],["⑃","Flows"],["◇","Knowledge"],["⚑","Leads"],["▥","Analytics"]];

const AUTH_TOKEN_KEY = "qpy-engage-auth-token";
const AuthTokenContext = createContext<string | null>(null);
const AuthWorkspaceContext = createContext<string | null>(null);
function authHeaders(token: string | null): Record<string,string> { return token ? { authorization: `Bearer ${token}` } : {}; }
function useAuthToken(): string | null { return useContext(AuthTokenContext); }
function useWorkspaceId(): string | null { return useContext(AuthWorkspaceContext); }

function useStoredState<T>(key: string, initial: T) {
  const token = useAuthToken();
  const workspaceId = useWorkspaceId();
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled=false;
    setLoaded(false);
    // Scope the local cache to the signed-in workspace so switching accounts on the same
    // browser never leaks one workspace's cached settings into another's.
    const localKey=workspaceId?`${key}::ws:${workspaceId}`:null;
    const load=async()=>{
      if(localKey)try { const saved=localStorage.getItem(localKey); if(saved&&!cancelled)setValue(JSON.parse(saved)); } catch {}
      if(token)try { const headers=authHeaders(token); const response=await fetch(metaApi(`/api/state?key=${encodeURIComponent(key)}`),{headers});const data=response.ok?await response.json():{value:null};if(data.value!==null&&!cancelled)setValue(data.value); } catch {}
      if(!cancelled)setLoaded(true);
    };
    load();
    return()=>{cancelled=true};
  }, [key, token, workspaceId]);
  useEffect(() => {
    if(!loaded)return;
    const localKey=workspaceId?`${key}::ws:${workspaceId}`:null;
    if(localKey)localStorage.setItem(localKey,JSON.stringify(value));
    const timer=window.setTimeout(()=>{if(token)fetch(metaApi("/api/state"),{method:"PUT",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({key,value})}).catch(()=>{});},350);
    return()=>window.clearTimeout(timer);
  }, [key, loaded, value, token, workspaceId]);
  return [value, setValue, loaded] as const;
}

function useWorkspaceMembers(token: string | null) {
  const [members, setMembers] = useState<Member[]>([]);
  const refresh = async () => {
    if (!token) return;
    try {
      const response = await fetch(metaApi("/api/workspace/members"), { headers: authHeaders(token) });
      if (response.ok) { const data = await response.json() as { members: Member[] }; setMembers(data.members || []); }
    } catch {}
  };
  useEffect(() => { refresh(); }, [token]);
  const invite = async (email: string, role: Member["role"]): Promise<string | null> => {
    if (!token) return "Sign in required.";
    try {
      const response = await fetch(metaApi("/api/workspace/members"), { method: "POST", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ email, role }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) return result.error || "Invitation failed.";
      await refresh();
      return null;
    } catch { return "Invitation failed."; }
  };
  const updateRole = async (email: string, role: Member["role"]) => {
    if (!token) return;
    await fetch(metaApi(`/api/workspace/members/${encodeURIComponent(email)}`), { method: "PATCH", headers: { "content-type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ role }) });
    await refresh();
  };
  const remove = async (email: string) => {
    if (!token) return;
    await fetch(metaApi(`/api/workspace/members/${encodeURIComponent(email)}`), { method: "DELETE", headers: authHeaders(token) });
    await refresh();
  };
  return { members, invite, updateRole, remove };
}

async function callAssistant(token: string | null, systemPrompt: string, messages: {role:"user"|"assistant";content:string}[], actions?: AssistantAction[], channel?: string, sessionId?: string): Promise<string> {
  if (!token) throw new Error("Sign in required.");
  const response = await fetch(metaApi("/api/assistant/respond"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ systemPrompt, messages, actions: (actions || []).filter((a) => a.enabled), channel, sessionId }),
  });
  const result = await response.json() as { reply?: string; error?: string };
  if (!response.ok || !result.reply) throw new Error(result.error || "The assistant could not respond.");
  return result.reply;
}

function speechLangFor(voiceLanguage: string): string {
  if (voiceLanguage.includes("Arabic")) return "ar-AE";
  if (voiceLanguage.includes("UAE")) return "en-AE";
  if (voiceLanguage.includes("US")) return "en-US";
  return "en-US";
}

// One-time handoff written by the standalone /admin console's "Impersonate" action: it can't
// share React state across a real page navigation, so it drops {token, workspace, adminToken}
// here, navigates to the main app, and this reads + deletes it on mount.
const IMPERSONATION_HANDOFF_KEY = "qpy-engage-impersonation-handoff";

export default function Home() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Impersonation: while a superadmin is "managing" a customer, `session` is swapped to a
  // short-lived impersonation token/workspace and the superadmin's own session is stashed here.
  // This never touches localStorage (which keeps the real superadmin token throughout), so a
  // refresh always drops back out of impersonation rather than leaving it stuck open.
  const [adminSession, setAdminSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handoffRaw = (() => { try { return localStorage.getItem(IMPERSONATION_HANDOFF_KEY) } catch { return null } })();
    if (handoffRaw) { try { localStorage.removeItem(IMPERSONATION_HANDOFF_KEY) } catch {} }
    const handoff = handoffRaw ? (() => { try { return JSON.parse(handoffRaw) as { token: string; workspace: AuthWorkspace; adminToken: string; adminUser: AuthUser } } catch { return null } })() : null;
    const token = handoff?.adminToken || (() => { try { return localStorage.getItem(AUTH_TOKEN_KEY) } catch { return null } })();
    if (!token) { setAuthLoading(false); return }
    (async () => {
      try {
        const response = await fetch(metaApi("/api/auth/session"), { headers: authHeaders(token) });
        if (response.ok) {
          const data = await response.json() as { user: AuthUser; workspace: AuthWorkspace; role: Member["role"] };
          const ownSession = { token, user: data.user, workspace: data.workspace, role: data.role };
          if (!cancelled) {
            if (handoff) { setAdminSession(ownSession); setSession({ token: handoff.token, user: data.user, workspace: handoff.workspace, role: "Owner" }); }
            else setSession(ownSession);
          }
        } else {
          localStorage.removeItem(AUTH_TOKEN_KEY);
        }
      } catch { /* keep the stored token; the network may just be offline */ }
      if (!cancelled) setAuthLoading(false);
    })();
    return () => { cancelled = true };
  }, []);

  const handleAuthed = (next: AuthSession) => { try { localStorage.setItem(AUTH_TOKEN_KEY, next.token) } catch {} setSession(next) };
  const handleLogout = async () => {
    if (session) { try { await fetch(metaApi("/api/auth/logout"), { method: "POST", headers: authHeaders(session.token) }) } catch {} }
    try { localStorage.removeItem(AUTH_TOKEN_KEY) } catch {}
    setSession(null);
    setAdminSession(null);
  };
  const handleExitImpersonation = () => {
    if (adminSession) setSession(adminSession);
    setAdminSession(null);
  };

  if (authLoading) return <div className="auth-loading">Loading Qpy Engage…</div>;
  if (!session) return <AuthGate onAuthed={handleAuthed}/>;
  return <AuthTokenContext.Provider value={session.token}><AuthWorkspaceContext.Provider value={session.workspace.id}><Workspace session={session} onLogout={handleLogout} isSuperadmin={Boolean(session.user.isSuperadmin)} isImpersonating={Boolean(adminSession)} onExitImpersonation={handleExitImpersonation}/></AuthWorkspaceContext.Provider></AuthTokenContext.Provider>;
}

function AuthGate({onAuthed}:{onAuthed:(session:AuthSession)=>void}){
  const [mode,setMode]=useState<"login"|"signup">("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [name,setName]=useState("");
  const [workspaceName,setWorkspaceName]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  const submit=async()=>{
    if(!email.trim()||!password){setError("Enter your email and password.");return}
    setLoading(true);setError("");
    try{
      const path=mode==="login"?"/api/auth/login":"/api/auth/signup";
      const body=mode==="login"?{email:email.trim(),password}:{email:email.trim(),password,name:name.trim(),workspaceName:workspaceName.trim()};
      const response=await fetch(metaApi(path),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const result=await response.json() as {token?:string;user?:AuthUser;workspace?:AuthWorkspace;role?:Member["role"];error?:string};
      if(!response.ok||!result.token||!result.user||!result.workspace||!result.role)throw new Error(result.error||"Something went wrong.");
      onAuthed({token:result.token,user:result.user,workspace:result.workspace,role:result.role});
    }catch(err){setError(err instanceof Error?err.message:"Something went wrong.")}
    finally{setLoading(false)}
  };

  return <main className="auth-shell"><div className="auth-card">
    <div className="auth-brand"><span className="brand-mark">Q</span><span>Qpy Engage</span></div>
    <h1>{mode==="login"?"Welcome back":"Create your workspace"}</h1>
    <p>{mode==="login"?"Sign in to manage your customer conversations.":"Set up a new Qpy Engage workspace in seconds."}</p>
    {error&&<div className="meta-error">⚠ {error}</div>}
    <div className="modal-form">
      {mode==="signup"&&<label>Your name<input value={name} onChange={e=>setName(e.target.value)} placeholder="Jane Doe"/></label>}
      {mode==="signup"&&<label>Workspace name<input value={workspaceName} onChange={e=>setWorkspaceName(e.target.value)} placeholder="e.g. Atelier Home"/></label>}
      <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label>
      <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder={mode==="signup"?"At least 8 characters":"Your password"}/></label>
    </div>
    <button className="primary" disabled={loading} onClick={submit}>{loading?"Please wait…":mode==="login"?"Sign in":"Create workspace"}</button>
    <button className="auth-switch" onClick={()=>{setMode(mode==="login"?"signup":"login");setError("")}}>{mode==="login"?"Need a workspace? Create one":"Already have an account? Sign in"}</button>
  </div></main>;
}

const SECTIONS: Section[] = ["Overview","Assistants","Channels","Inbox","Campaigns","Audiences","Automations","Flows","Knowledge","Leads","Analytics","Team","Settings"];

function Workspace({session,onLogout,isSuperadmin,isImpersonating,onExitImpersonation}:{session:AuthSession;onLogout:()=>void;isSuperadmin:boolean;isImpersonating:boolean;onExitImpersonation:()=>void}) {
  const sectionStorageKey = `qpy-engage-last-section::ws:${session.workspace.id}`;
  // Always boot into Overview first, then switch to whatever section was last open once
  // `connected` (see below) has resolved its real value — restoring straight into a section
  // like Inbox before that resolves lets it briefly render against the default `connected:false`,
  // then flips to true mid-mount, and that unmount/remount race was crashing the page.
  const [section, setSection] = useState<Section>("Overview");
  const restoredSectionRef = useRef(false);
  const [conversations, setConversations] = useStoredState("qpy-engage-conversations", initialConversations);
  const [messages, setMessages] = useStoredState("qpy-engage-messages", initialMessages);
  const [automations, setAutomations] = useStoredState("qpy-engage-automations", initialAutomations);
  const [sources, setSources] = useStoredState("qpy-engage-sources", initialSources);
  const {members, invite, updateRole, remove: removeMember} = useWorkspaceMembers(session.token);
  const [selectedId, setSelectedId] = useState("aisha");
  const [draft, setDraft] = useState("");
  const [aiActive, setAiActive] = useState(true);
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<null | "automation" | "source" | "invite" | "search" | "help" | "profile" | "notifications">(null);
  const [automationTemplate, setAutomationTemplate] = useState<{name:string;trigger:string;action:string} | null>(null);
  const [channelStep, setChannelStep] = useStoredState("qpy-engage-channel-step", 0);
  const [connected, setConnected, connectedLoaded] = useStoredState("qpy-engage-whatsapp-connected", false);
  useEffect(() => {
    if (restoredSectionRef.current || !connectedLoaded) return;
    restoredSectionRef.current = true;
    try {
      const stored = window.localStorage.getItem(sectionStorageKey);
      if (stored && (SECTIONS as string[]).includes(stored)) setSection(stored as Section);
    } catch { /* ignore */ }
  }, [connectedLoaded, sectionStorageKey]);
  const [settingsTab, setSettingsTab] = useState("General");
  // Real unread count for the sidebar Inbox badge: conversations across WhatsApp and Web chat
  // whose most recent message is from the customer, i.e. awaiting a reply. Lifted up here
  // (rather than only inside InboxHub) so the badge is accurate even when Inbox isn't the
  // active section.
  const {summaries: sidebarWaSummaries} = useWhatsappSummaries(connected, session.token);
  const {summaries: sidebarWebSummaries} = useWebchatSummaries(session.token);
  const unreadInboxCount = sidebarWaSummaries.filter((s) => s.lastDirection === "inbound").length
    + sidebarWebSummaries.filter((s) => s.lastRole === "user").length;

  const selected = conversations.find(c => c.id === selectedId) ?? conversations[0] ?? EMPTY_CONVERSATION;
  const displayName = session.user.name || session.user.email.split("@")[0];
  const initials = displayName.split(/\s+/).map(w=>w[0]).join("").slice(0,2).toUpperCase() || "U";
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(""), 2200); };
  const go = (next: Section) => { setSection(next); try { window.localStorage.setItem(sectionStorageKey, next); } catch {} window.scrollTo({top:0,behavior:"smooth"}); };
  const sendMessage = () => { if (!draft.trim()) return; setMessages({...messages,[selected.id]:[...(messages[selected.id]??[]),{from:"agent",text:draft.trim(),time:"Now"}]}); setDraft(""); };
  const openAutomation = (template?:{name:string;trigger:string;action:string}) => {setAutomationTemplate(template??null);setModal("automation")};
  const exportWorkspace=()=>{const data:Record<string,unknown>={};for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith("qpy-engage-")){try{data[key]=JSON.parse(localStorage.getItem(key)||"null")}catch{data[key]=localStorage.getItem(key)}}}const blob=new Blob([JSON.stringify({product:"Qpy Engage",exportedAt:new Date().toISOString(),data},null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="qpy-engage-workspace.json";a.click();URL.revokeObjectURL(a.href);notify("Workspace backup downloaded")};
  const importWorkspace=(file?:File)=>{if(!file)return;const reader=new FileReader();reader.onload=()=>{try{const parsed=JSON.parse(String(reader.result||"{}"));const data=parsed.data??parsed;if(!data||typeof data!=="object")throw new Error();Object.entries(data).forEach(([key,value])=>{if(key.startsWith("qpy-engage-"))localStorage.setItem(key,JSON.stringify(value))});notify("Workspace restored — reloading");window.setTimeout(()=>location.reload(),700)}catch{notify("That workspace backup is not valid")}};reader.readAsText(file)};
  const resetWorkspace=()=>{if(!window.confirm("Restore all Qpy Engage demo data? Your browser changes will be removed."))return;Object.keys(localStorage).filter(key=>key.startsWith("qpy-engage-")).forEach(key=>localStorage.removeItem(key));location.reload()};

  const body = section === "Overview" ? <Overview onNavigate={go} onCreate={openAutomation} connected={connected} conversations={conversations} automations={automations} sources={sources} userName={session.user.name||session.user.email.split("@")[0]} workspaceName={session.workspace.name}/> :
    section === "Assistants" ? <Assistants sources={sources} workspaceName={session.workspace.name} onKnowledge={()=>go("Knowledge")} onChannels={()=>go("Channels")} onAnalytics={()=>go("Analytics")} notify={notify}/> :
    section === "Channels" ? <Channels step={channelStep} setStep={setChannelStep} connected={connected} setConnected={setConnected} workspaceId={session.workspace.id} workspaceName={session.workspace.name} notify={notify}/> :
    section === "Inbox" ? <InboxHub connected={connected} conversations={conversations} setConversations={setConversations} selected={selected} setSelectedId={setSelectedId} messages={messages[selected.id]??[]} draft={draft} setDraft={setDraft} sendMessage={sendMessage} aiActive={aiActive} setAiActive={setAiActive} onConnect={()=>go("Channels")} notify={notify}/> :
    section === "Campaigns" ? <Campaigns notify={notify} onManageAudiences={()=>go("Audiences")}/> :
    section === "Audiences" ? <Audiences notify={notify}/> :
    section === "Automations" ? <AutomationBuilder notify={notify}/> :
    section === "Flows" ? <Flows notify={notify}/> :
    section === "Knowledge" ? <Knowledge sources={sources} setSources={setSources} onAdd={()=>setModal("source")} notify={notify}/> :
    section === "Leads" ? <Leads notify={notify}/> :
    section === "Analytics" ? <Analytics automations={automations} conversationCount={conversations.length} notify={notify}/> :
    section === "Team" ? <Team members={members} role={session.role} onInvite={()=>setModal("invite")} onUpdateRole={updateRole} onRemove={removeMember} notify={notify}/> :
    <Settings activeTab={settingsTab} setActiveTab={setSettingsTab} connected={connected} onChannels={()=>go("Channels")} workspaceName={session.workspace.name} notify={notify}/>;

  return <main className="app-shell" style={isImpersonating?{marginTop:38}:undefined}>
    {isImpersonating&&<div className="impersonation-banner">Viewing as <strong>{session.workspace.name}</strong> — actions here affect this customer's real workspace.<button onClick={onExitImpersonation}>Exit to Admin</button></div>}
    <aside className="sidebar">
      <button className="brand" onClick={()=>go("Overview")}><span className="brand-mark">Q</span><span>Qpy Engage</span></button>
      <div className="workspace"><span className="shop-avatar">{session.workspace.name.slice(0,1).toUpperCase()}</span><div><strong>{session.workspace.name}</strong><small>Business workspace</small></div><span className="chev">⌄</span></div>
      <nav className="side-nav" aria-label="Main navigation">{nav.map(([icon,label])=>{const count=label==="Inbox"?unreadInboxCount:0;return <button key={label} onClick={()=>go(label)} className={section===label?"active":""}><span>{icon}</span>{label}{count>0&&<b>{count}</b>}</button>})}</nav>
      <div className="nav-divider"/>
      <nav className="side-nav secondary"><button className={section==="Team"?"active":""} onClick={()=>go("Team")}><span>♙</span>Team</button><button className={section==="Settings"?"active":""} onClick={()=>go("Settings")}><span>⚙</span>Settings</button>{isSuperadmin&&!isImpersonating&&<a href="admin/" className="side-nav-link"><span>🛡</span>Superadmin</a>}</nav>
      <div className="sidebar-card"><span className="spark">✦</span><strong>Grow with Qpy Engage</strong><p>Unlock more conversations and advanced AI.</p><button onClick={()=>{go("Settings");setSettingsTab("Billing")}}>Explore plans</button></div>
      <div className="profile"><span className="profile-avatar">{initials}</span><div><strong>{displayName}</strong><small>{session.user.email}</small></div><button aria-label="Profile menu" onClick={()=>setModal("profile")}>•••</button></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><button className="mobile-brand" onClick={()=>go("Overview")}><span className="brand-mark">Q</span>Qpy Engage</button><div className="top-title"><strong>{section}</strong><span>•</span><small>{connected?"WhatsApp connected":"Finish WhatsApp setup"}</small></div><div className="top-actions"><button aria-label="Search" onClick={()=>setModal("search")}>⌕</button><button aria-label="Notifications" className="notification" onClick={()=>setModal("notifications")}>♧<i/></button><button className="help" onClick={()=>setModal("help")}>?</button></div></header>
      <div className="content">{body}</div>
    </section>
    <nav className="mobile-nav" aria-label="Mobile navigation">{nav.slice(0,5).map(([icon,label])=><button key={label} onClick={()=>go(label)} className={section===label?"active":""}><span>{icon}</span><small>{label}</small></button>)}</nav>
    {modal==="automation"&&<AutomationModal template={automationTemplate} onClose={()=>setModal(null)} onSave={(item)=>{setAutomations([...automations,item]);setModal(null);notify("Automation created")}}/>}
    {modal==="source"&&<SourceModal onClose={()=>setModal(null)} onSave={(item,content)=>{
      setSources([...sources,item]);setModal(null);notify("Knowledge source added");
      if(item.type==="Website"){
        fetch(metaApi("/api/knowledge/fetch-website"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(session.token)},body:JSON.stringify({url:item.name,sourceId:item.id})})
          .then(async response=>{
            const result=await response.json() as {fetched?:boolean;charCount?:number;error?:string};
            if(response.ok&&result.fetched){
              const pages=Math.max(1,Math.round((result.charCount||0)/2000));
              setSources(current=>current.map(s=>s.id===item.id?{...s,pages,status:"Ready"}:s));
              notify(`${item.name} indexed — the assistant can now use its content`);
            }else{
              setSources(current=>current.map(s=>s.id===item.id?{...s,pages:0,status:"Failed"}:s));
              notify(result.error||"Could not fetch that website — the assistant will only know its name, not its content.");
            }
          })
          .catch(()=>{setSources(current=>current.map(s=>s.id===item.id?{...s,pages:0,status:"Failed"}:s));notify("Could not fetch that website — the assistant will only know its name, not its content.")});
      }else{
        fetch(metaApi("/api/knowledge/save-content"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(session.token)},body:JSON.stringify({sourceId:item.id,content})})
          .then(async response=>{
            const result=await response.json() as {saved?:boolean;charCount?:number;error?:string};
            if(response.ok&&result.saved){
              const pages=Math.max(1,Math.round((result.charCount||0)/2000));
              setSources(current=>current.map(s=>s.id===item.id?{...s,pages,status:"Ready"}:s));
              notify(`${item.name} indexed — the assistant can now use its content`);
            }else{
              setSources(current=>current.map(s=>s.id===item.id?{...s,pages:0,status:"Failed"}:s));
              notify(result.error||"Could not save that content.");
            }
          })
          .catch(()=>{setSources(current=>current.map(s=>s.id===item.id?{...s,pages:0,status:"Failed"}:s));notify("Could not save that content.")});
      }
    }}/>}
    {modal==="invite"&&<InviteModal onClose={()=>setModal(null)} onSave={async(email,role)=>{const error=await invite(email,role);if(error){notify(error)}else{setModal(null);notify("Invitation sent")}}}/>}
    {modal==="search"&&<SearchModal onClose={()=>setModal(null)} onNavigate={(s)=>{go(s);setModal(null)}}/>}
    {modal==="notifications"&&<SimpleModal title="Notifications" onClose={()=>setModal(null)}><div className="notification-center">{[["AI requested human help","Aisha’s order question needs review","Inbox"],["Campaign scheduled","Weekend showroom event • Jul 19 at 09:30","Campaigns"],["Knowledge synchronized","4 sources are ready","Knowledge"]].map(([title,copy,target])=><button key={title} onClick={()=>{setModal(null);go(target as Section)}}><span>✓</span><div><strong>{title}</strong><small>{copy}</small></div><b>Open →</b></button>)}</div><div className="modal-actions"><button className="secondary-btn" onClick={()=>setModal(null)}>Mark all read</button></div></SimpleModal>}
    {modal==="profile"&&<SimpleModal title="Workspace tools" onClose={()=>setModal(null)}><div className="workspace-tools"><div className="workspace-owner"><span className="profile-avatar">{initials}</span><div><strong>{displayName}</strong><small>{session.role} • {session.workspace.name}</small></div></div><button onClick={exportWorkspace}><span>↓</span><div><strong>Download workspace backup</strong><small>Export all assistants, campaigns, conversations, settings, and connections.</small></div></button><label><span>↑</span><div><strong>Restore workspace backup</strong><small>Import a previously downloaded Qpy Engage JSON backup.</small></div><input type="file" accept="application/json,.json" onChange={e=>importWorkspace(e.target.files?.[0])}/></label><button onClick={resetWorkspace}><span>↻</span><div><strong>Restore demo data</strong><small>Reset this browser workspace to the original sample content.</small></div></button><button onClick={onLogout}><span>⏻</span><div><strong>Log out</strong><small>Sign out of {session.workspace.name} on this device.</small></div></button></div><div className="browser-storage-note">Signed in as {session.user.email}. Your data is synced to your Qpy Engage account.</div></SimpleModal>}
    {modal==="help"&&<SimpleModal title="Qpy Engage help" onClose={()=>setModal(null)}><p>Search the knowledge base, learn how WhatsApp onboarding works, or contact support.</p><div className="modal-actions"><button className="secondary-btn" onClick={()=>setModal(null)}>Close</button><button className="primary" onClick={()=>{setModal(null);go("Channels")}}>Open setup guide</button></div></SimpleModal>}
    {toast&&<div className="toast">✓ {toast}</div>}
  </main>;
}

function PageHeader({eyebrow,title,description,action}:{eyebrow?:string;title:string;description:string;action?:React.ReactNode}){return <div className="page-header"><div>{eyebrow&&<p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p>{description}</p></div>{action}</div>}

function Overview({onNavigate,onCreate,connected,conversations,automations,sources,userName,workspaceName}:{onNavigate:(s:Section)=>void;onCreate:()=>void;connected:boolean;conversations:Conversation[];automations:Automation[];sources:Source[];userName:string;workspaceName:string}){
  const open=conversations.filter(c=>c.status==="open");
  const [launched]=useStoredState("qpy-engage-assistant-live",false);
  const sourcesReady=sources.filter(s=>s.status==="Ready").length;
  const completedSteps=[connected,sourcesReady>0,launched].filter(Boolean).length;
  const hour=new Date().getHours();
  const greeting=hour<12?"Good morning":hour<18?"Good afternoon":"Good evening";
  const eyebrow=new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"}).toUpperCase();
  return <>
  <PageHeader eyebrow={eyebrow} title={`${greeting}, ${userName} 👋`} description={`Here’s what’s happening with ${workspaceName} today.`} action={<button className="primary" onClick={()=>onCreate()}>＋ Create automation</button>}/>
  <section className="setup-card"><div className="setup-head"><div><span className="setup-icon">✦</span><div><h2>{completedSteps===3?"Your AI teammate is live":"Set up your AI teammate"}</h2><p>{completedSteps===3?"WhatsApp and your knowledge sources are ready.":"Three quick steps to start turning conversations into customers."}</p></div></div><div className="progress-label"><strong>{completedSteps} of 3 complete</strong><div><i style={{width:`${(completedSteps/3)*100}%`}}/></div></div></div><div className="steps">
    <button className={`step ${connected?"complete":"current"}`} onClick={()=>onNavigate("Channels")}><span>{connected?"✓":"1"}</span><div><strong>Connect WhatsApp Business</strong><small>{connected?"+971 50 284 8102 connected":"Connect securely through Meta"}</small></div><b>{connected?"Connected":"Start →"}</b></button>
    <button className={`step ${sourcesReady>0?"complete":"current"}`} onClick={()=>onNavigate("Knowledge")}><span>{sourcesReady>0?"✓":"2"}</span><div><strong>Train your AI</strong><small>{sourcesReady>0?`${sourcesReady} source${sourcesReady===1?"":"s"} ready`:"Add a website or document"}</small></div><b>{sourcesReady>0?`${sourcesReady} sources`:"Start →"}</b></button>
    <button className={`step ${launched?"complete":"current"}`} onClick={()=>onNavigate("Assistants")}><span>{launched?"✓":"3"}</span><div><strong>Personalize your assistant</strong><small>{launched?"Published and live":"Configure and publish your assistant"}</small></div><b>{launched?"Live":"Start →"}</b></button>
  </div></section>
  <MetricCards conversationCount={conversations.length}/>
  <section className="overview-panels"><div className="card"><div className="card-head"><div><h2>Live conversations</h2><p>{open.length} customers waiting now</p></div><button onClick={()=>onNavigate("Inbox")}>Open inbox →</button></div>{open.length?open.slice(0,4).map(c=><div className="mini-row" key={c.id}><span className={`contact-avatar ${c.tone}`}>{c.initials}<i/></span><div><strong>{c.name}</strong><small>{c.preview}</small></div><time>{c.time}</time></div>):<p className="empty-hint">No open conversations yet.</p>}</div><div className="card"><div className="card-head"><div><h2>Automation health</h2><p>All active workflows</p></div><button onClick={()=>onNavigate("Automations")}>Manage →</button></div>{automations.length?automations.map(a=><div className="health-row" key={a.id}><span>✦</span><div><strong>{a.title}</strong><small>{a.runs} runs this month</small></div><b>{a.rate}</b></div>):<p className="empty-hint">No automations yet — create one to get started.</p>}</div></section>
</>}

function MetricCards({conversationCount}:{conversationCount:number}){
  const metrics=[
    {icon:"↗",label:"Conversations",value:String(conversationCount),change:null as string|null,tone:"green"},
    {icon:"✦",label:"AI resolution rate",value:"—",change:null as string|null,tone:"purple"},
    {icon:"⌁",label:"Avg. response time",value:"—",change:null as string|null,tone:"coral"},
    {icon:"◈",label:"Revenue assisted",value:"—",change:null as string|null,tone:"blue"},
  ];
  return <section className="metrics-grid">{metrics.map(m=><article key={m.label}><div className="metric-label"><span className={`metric-icon ${m.tone}`}>{m.icon}</span><p>{m.label}</p><span className="metric-live">{m.change?"LIVE":"—"}</span></div><div className="metric-value"><strong>{m.value}</strong>{m.change&&<span className="up">↗ {m.change}</span>}</div><small>{m.change?"vs. last 30 days":"Analytics coming soon"}</small><div className="mini-chart">▂▃▂▅▄▇▆</div></article>)}</section>;
}

function Assistants({sources,workspaceName,onKnowledge,onChannels,onAnalytics,notify}:{sources:Source[];workspaceName:string;onKnowledge:()=>void;onChannels:()=>void;onAnalytics:()=>void;notify:(s:string)=>void}){
  const steps=["Profile","Instructions","Knowledge","AI actions","Channels","Voice","Test","Launch"];
  const [step,setStep]=useStoredState("qpy-engage-assistant-step-v2",0);
  const [launched,setLaunched]=useStoredState("qpy-engage-assistant-live",false);
  const [version,setVersion]=useStoredState("qpy-engage-assistant-version",3);
  const [config,setConfig]=useStoredState("qpy-engage-assistant-config-v2",{name:`${workspaceName} Assistant`,purpose:"Sales & customer support",language:"English",tone:"Warm & helpful",role:`You are ${workspaceName}'s digital assistant. Answer clearly and concisely using only approved business knowledge. Help customers discover products, check order progress, explain delivery and returns, and collect qualified leads. Never invent prices, availability, policies, or order details.`,fallback:"When information is missing, confidence is low, the customer is upset, or the request involves payments, disputes, legal issues, or exceptions, explain that a specialist will help and transfer the conversation.",welcome:"Hi! How can I help today?",signoff:"Is there anything else I can help with?"});
  const [policies,setPolicies]=useStoredState("qpy-engage-assistant-policies",{concise:true,citations:true,imageProcessing:true,equations:false,memory:true,transfer:true,collectConsent:true,confidence:72,maxReplies:4,restricted:"Legal advice, payment disputes, refunds outside policy, medical advice, passwords, card details",handoffTeam:"Customer Support",businessHours:"24/7 AI coverage"});
  const [selectedSources,setSelectedSources]=useStoredState<number[]>("qpy-engage-assistant-sources",sources.map(s=>s.id));
  const [selectedChannels,setSelectedChannels]=useStoredState<string[]>("qpy-engage-assistant-channels",["WhatsApp"]);
  const [actions,setActions]=useStoredState<AssistantAction[]>("qpy-engage-assistant-actions",[]);
  const [voice,setVoice]=useStoredState("qpy-engage-assistant-voice",{enabled:false,channel:"Inbound phone",voiceName:"Default browser voice",language:"Auto-detect English / Arabic",speed:"1.0",greeting:`Hello, you've reached ${workspaceName}. I'm the AI assistant. How may I help you today?`,consent:"This call may be recorded and processed by AI to assist you.",interruptions:true,noiseSuppression:true,recording:true,transcripts:true,summary:true,dtmf:true,silence:"8 seconds",maxDuration:"15 minutes",transferNumber:"",voicemail:true,businessHours:"Always available"});
  const emptyAction=():AssistantAction=>({id:0,name:"",description:"",type:"submit",parameters:[],endpoint:"",method:"POST",defaultResponse:"Thank you — your details have been received.",confirmation:true,continueConversation:true,enabled:false,runs:0,success:"—",lastTest:"Not tested"});
  const [actionDraft,setActionDraft]=useState<AssistantAction>(emptyAction());
  const [editingAction,setEditingAction]=useState(false);
  const [testMessages,setTestMessages]=useState<Message[]>([{from:"customer",text:"Do you deliver the Riviera chair to Abu Dhabi?",time:"Now"},{from:"ai",text:"Yes. Standard delivery to Abu Dhabi takes 2–3 business days and is free for orders above AED 500. Would you like help choosing a finish?",time:"Now"}]);
  const [testDraft,setTestDraft]=useState("");
  const [testSending,setTestSending]=useState(false);
  const [testMode,setTestMode]=useState<"Chat"|"Voice">("Chat");
  const [callState,setCallState]=useState<"idle"|"connecting"|"live"|"ended">("idle");
  const [voiceStatus,setVoiceStatus]=useState<""|"listening"|"thinking"|"speaking">("");
  const [voiceTranscript,setVoiceTranscript]=useState<Message[]>([]);
  const token=useAuthToken();
  const callActiveRef=useRef(false);
  const recognitionRef=useRef<SpeechRecognitionLike|null>(null);
  const chatSessionIdRef=useRef<string>(crypto.randomUUID());
  const voiceSessionIdRef=useRef<string>(crypto.randomUUID());
  const [knowledgeContent,setKnowledgeContent]=useState<Record<number,string>>({});
  useEffect(()=>{
    if(!token||!selectedSources.length){setKnowledgeContent({});return}
    fetch(metaApi(`/api/knowledge/content?ids=${selectedSources.join(",")}`),{headers:authHeaders(token)})
      .then(response=>response.ok?response.json():{content:{}})
      .then(data=>setKnowledgeContent((data as {content?:Record<number,string>}).content||{}))
      .catch(()=>{});
  },[token,selectedSources.join(",")]);
  const [availableVoices,setAvailableVoices]=useState<SpeechSynthesisVoice[]>([]);
  useEffect(()=>{
    if(!("speechSynthesis" in window))return;
    const load=()=>setAvailableVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged=load;
    return()=>{window.speechSynthesis.onvoiceschanged=null};
  },[]);
  useEffect(()=>{
    if(!availableVoices.length)return;
    if(!availableVoices.some(v=>v.name===voice.voiceName))setVoice(current=>({...current,voiceName:availableVoices[0].name}));
  },[availableVoices.length]);
  const maxDurationTimeoutRef=useRef<number|null>(null);
  const bargeInRef=useRef<SpeechRecognitionLike|null>(null);
  const stopBargeIn=()=>{bargeInRef.current?.abort();bargeInRef.current=null};
  const startBargeIn=(onInterrupt:(transcript:string)=>void)=>{
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognition)return;
    const recognition=new Recognition();
    bargeInRef.current=recognition;
    recognition.lang=speechLangFor(voice.language);
    recognition.interimResults=false;
    recognition.continuous=false;
    recognition.maxAlternatives=1;
    recognition.onresult=(event)=>{const transcript=event.results?.[0]?.[0]?.transcript?.trim();if(transcript)onInterrupt(transcript)};
    recognition.onerror=()=>{};
    try{recognition.start()}catch{}
  };
  const next=()=>setStep(Math.min(7,step+1));
  const toggleSource=(id:number)=>setSelectedSources(selectedSources.includes(id)?selectedSources.filter(x=>x!==id):[...selectedSources,id]);
  const toggleChannel=(name:string)=>setSelectedChannels(selectedChannels.includes(name)?selectedChannels.filter(x=>x!==name):[...selectedChannels,name]);
  const buildSystemPrompt=()=>{
    const relevantSources=sources.filter(s=>selectedSources.includes(s.id));
    const sourceNames=relevantSources.map(s=>s.name).join(", ")||"no connected sources yet";
    const knowledgeText=relevantSources.map(s=>knowledgeContent[s.id]).filter(Boolean).join("\n\n").slice(0,12000);
    let prompt=`${config.role}\n\nTone: ${config.tone}. Preferred language: ${config.language}.\n\nFallback and human handoff policy: ${config.fallback}\n\nRestricted topics you must never answer — hand these off instead: ${policies.restricted}\n\nConnected knowledge sources: ${sourceNames}.`;
    prompt+=knowledgeText?`\n\nReference material from those sources — use this to answer factual questions, and do not state facts beyond what's here:\n${knowledgeText}`:" You were not given their actual content, so never claim a specific fact, price, or policy came from them.";
    prompt+="\n\nKeep replies concise and helpful. Never invent prices, availability, order details, or policies you were not given.";
    return prompt;
  };
  const toApiMessages=(list:Message[])=>list.map(m=>({role:(m.from==="customer"?"user":"assistant") as "user"|"assistant",content:m.text}));
  const sendTest=async()=>{
    if(!testDraft.trim()||testSending)return;
    const question=testDraft.trim();
    const history=[...testMessages,{from:"customer" as const,text:question,time:"Now"}];
    setTestMessages(history);setTestDraft("");setTestSending(true);
    try{
      const reply=await callAssistant(token,buildSystemPrompt(),toApiMessages(history),actions,"test_studio_chat",chatSessionIdRef.current);
      setTestMessages(current=>[...current,{from:"ai",text:reply,time:"Now"}]);
    }catch(error){notify(error instanceof Error?error.message:"The assistant could not respond.")}
    finally{setTestSending(false)}
  };
  const saveAction=()=>{if(!actionDraft.name.trim()||!actionDraft.description.trim()){notify("Add an action name and description");return}const saved={...actionDraft,id:actionDraft.id||Date.now()};setActions(actionDraft.id?actions.map(a=>a.id===actionDraft.id?saved:a):[...actions,saved]);setEditingAction(false);setActionDraft(emptyAction());notify("AI action saved")};
  const testAction=async(id:number)=>{
    const action=actions.find(a=>a.id===id);
    if(!action)return;
    if(!action.endpoint.trim()){notify("Add an endpoint URL before testing this action");return}
    const sampleInput:Record<string,unknown>={};
    for(const p of action.parameters)sampleInput[p.name]=p.type==="number"?1:p.type==="boolean"?true:p.type==="email"?"test@example.com":p.type==="phone"?"+1 555 0100":"Sample value";
    try{
      const response=await fetch(metaApi("/api/assistant/test-action"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({action,sampleInput})});
      const result=await response.json() as {ok?:boolean;resultText?:string;error?:string};
      if(!response.ok)throw new Error(result.error||"Test failed");
      setActions(current=>current.map(a=>a.id===id?{...a,lastTest:result.ok?"Passed":"Failed",success:result.ok?"100%":"0%",runs:a.runs+1}:a));
      notify(result.ok?`Test succeeded — real webhook responded`:`Test failed — ${(result.resultText||"").slice(0,140)}`);
    }catch(error){
      setActions(current=>current.map(a=>a.id===id?{...a,lastTest:"Failed"}:a));
      notify(error instanceof Error?error.message:"Could not reach that endpoint.");
    }
  };
  const previewVoice=()=>{
    if(!("speechSynthesis" in window)){notify("Voice preview is unavailable in this browser");return}
    window.speechSynthesis.cancel();
    const utterance=new SpeechSynthesisUtterance(voice.greeting);
    utterance.rate=Number(voice.speed);
    utterance.lang=speechLangFor(voice.language);
    const matched=window.speechSynthesis.getVoices().find(v=>v.name===voice.voiceName);
    if(matched)utterance.voice=matched;
    window.speechSynthesis.speak(utterance);
    notify(`Playing ${voice.voiceName} preview`);
  };
  const speak=(text:string,onDone:()=>void)=>{
    if(!("speechSynthesis" in window)){onDone();return}
    window.speechSynthesis.cancel();
    stopBargeIn();
    const utterance=new SpeechSynthesisUtterance(text);
    utterance.rate=Number(voice.speed);
    utterance.lang=speechLangFor(voice.language);
    const matched=window.speechSynthesis.getVoices().find(v=>v.name===voice.voiceName);
    if(matched)utterance.voice=matched;
    let settled=false;
    const finish=()=>{if(settled)return;settled=true;stopBargeIn();onDone()};
    utterance.onend=finish;utterance.onerror=finish;
    setVoiceStatus("speaking");
    window.speechSynthesis.speak(utterance);
    if(voice.interruptions&&callActiveRef.current){
      startBargeIn(transcript=>{
        if(settled)return;
        settled=true;
        window.speechSynthesis.cancel();
        handleVoiceTurn(transcript);
      });
    }
  };
  const listenOnce=()=>{
    const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognition){notify("Voice input isn't supported in this browser — try Chrome or Edge.");setCallState("ended");callActiveRef.current=false;return}
    const recognition=new Recognition();
    recognitionRef.current=recognition;
    recognition.lang=speechLangFor(voice.language);
    recognition.interimResults=false;
    recognition.continuous=false;
    recognition.maxAlternatives=1;
    setVoiceStatus("listening");
    recognition.onresult=(event)=>{
      const transcript=event.results?.[0]?.[0]?.transcript?.trim();
      if(transcript)handleVoiceTurn(transcript);
      else if(callActiveRef.current)listenOnce();
    };
    recognition.onerror=()=>{if(callActiveRef.current)window.setTimeout(()=>{if(callActiveRef.current)listenOnce()},600)};
    recognition.start();
  };
  const handleVoiceTurn=async(transcript:string)=>{
    const history=[...voiceTranscript,{from:"customer" as const,text:transcript,time:"Now"}];
    setVoiceTranscript(history);
    setVoiceStatus("thinking");
    try{
      const reply=await callAssistant(token,buildSystemPrompt(),toApiMessages(history),actions,"test_studio_voice",voiceSessionIdRef.current);
      setVoiceTranscript(current=>[...current,{from:"ai",text:reply,time:"Now"}]);
      speak(reply,()=>{if(callActiveRef.current)listenOnce()});
    }catch(error){
      notify(error instanceof Error?error.message:"The assistant could not respond.");
      if(callActiveRef.current)listenOnce();
    }
  };
  const startCall=()=>{
    callActiveRef.current=true;
    voiceSessionIdRef.current=crypto.randomUUID();
    setVoiceTranscript([]);
    setCallState("connecting");
    const maxDurationMinutes=parseInt(voice.maxDuration,10)||15;
    if(maxDurationTimeoutRef.current)window.clearTimeout(maxDurationTimeoutRef.current);
    maxDurationTimeoutRef.current=window.setTimeout(()=>{
      if(callActiveRef.current){notify(`Call ended — reached the ${voice.maxDuration} limit`);endCall()}
    },maxDurationMinutes*60000);
    window.setTimeout(()=>{
      setCallState("live");
      const greeting=`${voice.consent} ${voice.greeting}`;
      setVoiceTranscript([{from:"ai",text:greeting,time:"Now"}]);
      speak(greeting,()=>{if(callActiveRef.current)listenOnce()});
    },700);
    notify("Secure browser test call started");
  };
  const endCall=()=>{
    callActiveRef.current=false;
    if("speechSynthesis" in window)window.speechSynthesis.cancel();
    recognitionRef.current?.abort();
    stopBargeIn();
    if(maxDurationTimeoutRef.current){window.clearTimeout(maxDurationTimeoutRef.current);maxDurationTimeoutRef.current=null}
    setVoiceStatus("");
    setCallState("ended");
  };
  const launch=()=>{setLaunched(true);setVersion(version+1);notify(`${config.name} version ${version+1} is live`)};
  return <><PageHeader title="AI Assistants" description="Design, train, equip, test, and govern customer-facing AI across chat and voice." action={<div className="header-buttons"><span className={`status-pill ${launched?"ready":"syncing"}`}>{launched?`● Live • v${version}`:"Draft"}</span><button className="primary" onClick={()=>{setStep(0);setLaunched(false);notify("New draft version created")}}>＋ New version</button></div>}/><div className="assistant-layout advanced"><aside className="assistant-list"><h3>Your assistants</h3><button className="selected" onClick={()=>setStep(0)}><span className="assistant-avatar">✦</span><div><strong>{config.name}</strong><small>{launched?`Live on ${selectedChannels.length} channels`:`Draft • ${steps[step]}`}</small></div><i className={launched?"live":""}/></button><div className="assistant-health"><strong>{selectedSources.length}</strong><span>sources</span><strong>{actions.filter(a=>a.enabled).length}</strong><span>active actions</span><strong>{voice.enabled?"On":"Off"}</strong><span>voice assistant</span></div><div className="assistant-side-summary"><span>Safety score</span><strong>92%</strong><div><i style={{width:"92%"}}/></div><small>Guardrails and handoff are configured.</small></div></aside><section className="assistant-builder"><div className="assistant-progress wide">{steps.map((label,i)=><button key={label} className={i<step?"done":i===step?"active":""} onClick={()=>setStep(i)}><span>{i<step?"✓":i+1}</span><small>{label}</small></button>)}</div><div className="assistant-stage advanced-stage">
    {step===0&&<><WizardTitle n="01" title="Assistant profile" text="Define the assistant’s role, identity, languages, and customer-facing introduction."/><div className="assistant-identity"><span className="assistant-avatar large">✦</span><div className="form-grid"><label>Assistant name<input value={config.name} onChange={e=>setConfig({...config,name:e.target.value})}/></label><label>Primary use case<select value={config.purpose} onChange={e=>setConfig({...config,purpose:e.target.value})}><option>Sales & customer support</option><option>Lead qualification</option><option>Order support</option><option>Product recommendations</option><option>Appointment booking</option></select></label><label>Languages<select value={config.language} onChange={e=>setConfig({...config,language:e.target.value})}><option>English</option><option>Arabic</option><option>English & Arabic</option><option>Auto-detect 25+ languages</option></select></label><label>Personality<select value={config.tone} onChange={e=>setConfig({...config,tone:e.target.value})}><option>Warm & helpful</option><option>Professional & concise</option><option>Friendly & energetic</option><option>Luxury concierge</option></select></label></div></div><div className="assistant-copy-grid"><label>Welcome message<textarea value={config.welcome} onChange={e=>setConfig({...config,welcome:e.target.value})}/></label><label>Conversation sign-off<textarea value={config.signoff} onChange={e=>setConfig({...config,signoff:e.target.value})}/></label></div><div className="wizard-actions"><span>Customers are told when they are interacting with AI.</span><button className="primary" disabled={!config.name.trim()} onClick={next}>Configure instructions →</button></div></>}
    {step===1&&<><WizardTitle n="02" title="Instructions and guardrails" text="Control how the assistant answers, what it must never do, and when a human takes over."/><div className="instruction-layout"><div><label className="full-label">System instructions<textarea className="large-prompt" value={config.role} onChange={e=>setConfig({...config,role:e.target.value})}/><small>{config.role.length}/4000 characters</small></label><div className="prompt-presets"><span>Use a preset:</span>{[["Concierge","You are Atelier Home’s premium digital concierge. Give warm, accurate, concise help using only approved knowledge and actions."],["Support","You are a precise customer support specialist. Diagnose the request, confirm important details, and resolve it or hand off safely."],["Lead agent","You are a consultative sales assistant. Understand needs, recommend relevant options, and collect consented lead details without pressure."]].map(([name,prompt])=><button key={name} onClick={()=>setConfig({...config,role:prompt})}>{name}</button>)}</div><label className="full-label">Fallback and human handoff instructions<textarea value={config.fallback} onChange={e=>setConfig({...config,fallback:e.target.value})}/></label><label className="full-label">Restricted topics<input value={policies.restricted} onChange={e=>setPolicies({...policies,restricted:e.target.value})}/></label></div><aside className="extension-card"><h3>Response extensions</h3>{[["concise","Concise responses","Keep routine answers short and scannable"],["citations","Knowledge citations","Show the source used for factual answers"],["imageProcessing","Image understanding","Analyze customer product images"],["equations","Equation rendering","Format mathematics and technical notation"],["memory","Conversation memory","Remember context within the conversation"],["transfer","Transfer to human","Hand off when requested or confidence is low"],["collectConsent","Consent before data collection","Ask before collecting or submitting personal data"]].map(([key,title,copy])=><label key={key}><div><strong>{title}</strong><small>{copy}</small></div><input type="checkbox" checked={Boolean(policies[key as keyof typeof policies])} onChange={e=>setPolicies({...policies,[key]:e.target.checked})}/><span className="toggle-ui"/></label>)}</aside></div><div className="guardrail-grid"><label>Handoff confidence<input type="range" min="40" max="95" value={policies.confidence} onChange={e=>setPolicies({...policies,confidence:Number(e.target.value)})}/><b>{policies.confidence}%</b></label><label>Max AI replies before review<input type="number" min="1" max="20" value={policies.maxReplies} onChange={e=>setPolicies({...policies,maxReplies:Number(e.target.value)})}/></label><label>Handoff team<select value={policies.handoffTeam} onChange={e=>setPolicies({...policies,handoffTeam:e.target.value})}><option>Customer Support</option><option>Sales</option><option>Orders & Delivery</option><option>Managers</option></select></label><label>AI coverage<select value={policies.businessHours} onChange={e=>setPolicies({...policies,businessHours:e.target.value})}><option>24/7 AI coverage</option><option>Outside team hours only</option><option>Business hours only</option></select></label></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(0)}>Back</button><button className="primary" onClick={next}>Save instructions →</button></div></>}
    {step===2&&<><WizardTitle n="03" title="Knowledge and retrieval" text="Choose approved sources, retrieval behavior, and freshness expectations."/><div className="training-summary"><div><span>◇</span><strong>{selectedSources.length}</strong><small>sources selected</small></div><div><span>▤</span><strong>{sources.filter(s=>selectedSources.includes(s.id)).reduce((n,s)=>n+s.pages,0).toLocaleString()}</strong><small>pages indexed</small></div><div><span>✓</span><strong>98.7%</strong><small>answer coverage</small></div></div><div className="training-source-list">{sources.map(source=><label key={source.id} className={selectedSources.includes(source.id)?"selected":""}><input type="checkbox" checked={selectedSources.includes(source.id)} onChange={()=>toggleSource(source.id)}/><span>{source.type==="Website"?"⌁":source.type==="Document"?"▤":"?"}</span><div><strong>{source.name}</strong><small>{source.type} • {source.pages.toLocaleString()} pages • synced today</small></div><b>{source.status}</b></label>)}</div><div className="knowledge-options"><label><input type="checkbox" defaultChecked/> Prefer the newest source when content conflicts</label><label><input type="checkbox" defaultChecked/> Refuse answers not supported by selected knowledge</label><label><input type="checkbox" defaultChecked/> Automatically re-train after source updates</label></div><button className="text-action" onClick={onKnowledge}>＋ Add or manage training sources</button><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(1)}>Back</button><button className="primary" disabled={!selectedSources.length} onClick={()=>{notify("Knowledge index refreshed");next()}}>Train and continue →</button></div></>}
    {step===3&&<>{editingAction?<><WizardTitle n="04" title={actionDraft.id?"Edit AI action":"Create AI action"} text="Define when it runs, the data it needs, and how Qpy Engage connects to your system."/><div className="action-editor"><section><h3>Basic details</h3><div className="form-grid"><label>Action name<input value={actionDraft.name} onChange={e=>setActionDraft({...actionDraft,name:e.target.value})} placeholder="e.g. Book showroom appointment"/></label><label>Action type<select value={actionDraft.type} onChange={e=>setActionDraft({...actionDraft,type:e.target.value as "submit"|"request"})}><option value="submit">AI Data Submit</option><option value="request">AI Data Request</option></select></label></div><label className="full-label">When should the AI use this action?<textarea value={actionDraft.description} onChange={e=>setActionDraft({...actionDraft,description:e.target.value})} placeholder="Describe the customer intent and conditions that should trigger this action."/></label></section><section><div className="section-title"><div><h3>Parameters</h3><p>Fields the assistant collects and validates before running the action.</p></div><button className="secondary-btn" onClick={()=>setActionDraft({...actionDraft,parameters:[...actionDraft.parameters,{id:Date.now(),name:"",type:"text",required:true,description:""}]})}>＋ Add parameter</button></div>{actionDraft.parameters.length?<div className="parameter-list">{actionDraft.parameters.map((p,i)=><div key={p.id}><input aria-label="Parameter name" value={p.name} placeholder="field_name" onChange={e=>setActionDraft({...actionDraft,parameters:actionDraft.parameters.map((x,j)=>j===i?{...x,name:e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,"")}:x)})}/><select value={p.type} onChange={e=>setActionDraft({...actionDraft,parameters:actionDraft.parameters.map((x,j)=>j===i?{...x,type:e.target.value as ActionParameter["type"]}:x)})}><option value="text">Text</option><option value="number">Number</option><option value="email">Email</option><option value="phone">Phone</option><option value="boolean">Yes / No</option></select><input value={p.description} placeholder="What should the AI collect?" onChange={e=>setActionDraft({...actionDraft,parameters:actionDraft.parameters.map((x,j)=>j===i?{...x,description:e.target.value}:x)})}/><label><input type="checkbox" checked={p.required} onChange={e=>setActionDraft({...actionDraft,parameters:actionDraft.parameters.map((x,j)=>j===i?{...x,required:e.target.checked}:x)})}/> Required</label><button onClick={()=>setActionDraft({...actionDraft,parameters:actionDraft.parameters.filter(x=>x.id!==p.id)})}>×</button></div>)}</div>:<div className="empty-parameters">No parameters yet. Add the information this action needs.</div>}</section><section><h3>Connection and response</h3><div className="form-grid"><label>Webhook URL<input value={actionDraft.endpoint} onChange={e=>setActionDraft({...actionDraft,endpoint:e.target.value})} placeholder="https://api.example.com/action"/></label><label>Method<select value={actionDraft.method} onChange={e=>setActionDraft({...actionDraft,method:e.target.value as "POST"|"GET"})}><option>POST</option><option>GET</option></select></label></div><label className="full-label">Default customer response<textarea value={actionDraft.defaultResponse} onChange={e=>setActionDraft({...actionDraft,defaultResponse:e.target.value})}/></label><div className="action-checks"><label><input type="checkbox" checked={actionDraft.confirmation} onChange={e=>setActionDraft({...actionDraft,confirmation:e.target.checked})}/> Confirm with customer before running</label><label><input type="checkbox" checked={actionDraft.continueConversation} onChange={e=>setActionDraft({...actionDraft,continueConversation:e.target.checked})}/> Continue conversation after completion</label><label><input type="checkbox" checked={actionDraft.enabled} onChange={e=>setActionDraft({...actionDraft,enabled:e.target.checked})}/> Enable immediately after saving</label></div></section></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>{setEditingAction(false);setActionDraft(emptyAction())}}>Cancel</button><button className="primary" onClick={saveAction}>Save action</button></div></>:<><WizardTitle n="04" title="AI actions and integrations" text="Let the assistant securely collect data, call business systems, and continue with live results."/><div className="action-metrics"><div><strong>{actions.length}</strong><small>Configured actions</small></div><div><strong>{actions.reduce((n,a)=>n+a.runs,0)}</strong><small>Total runs</small></div><div><strong>{(()=>{const rates=actions.map(a=>parseFloat(a.success)).filter(Number.isFinite);return rates.length?`${(rates.reduce((s,n)=>s+n,0)/rates.length).toFixed(1)}%`:"—"})()}</strong><small>Success rate</small></div><button className="primary" onClick={()=>{setActionDraft(emptyAction());setEditingAction(true)}}>＋ Create action</button></div><div className="action-list">{actions.map(action=><article key={action.id}><span className={action.type}>{action.type==="submit"?"⇧":"↔"}</span><div><div className="action-name"><strong>{action.name}</strong><b>{action.type==="submit"?"Data submit":"Data request"}</b></div><p>{action.description}</p><small>{action.parameters.length} parameters • {action.method} webhook • {action.runs} runs • {action.success} success</small></div><label className="switch"><input type="checkbox" checked={action.enabled} onChange={()=>setActions(actions.map(a=>a.id===action.id?{...a,enabled:!a.enabled}:a))}/><i/></label><div className="action-buttons"><button onClick={()=>testAction(action.id)}>Test</button><button onClick={()=>{setActionDraft(action);setEditingAction(true)}}>Edit</button><button onClick={()=>{if(window.confirm("Delete this AI action?"))setActions(actions.filter(a=>a.id!==action.id))}}>Delete</button></div><em className={action.lastTest==="Passed"?"passed":""}>{action.lastTest}</em></article>)}</div><div className="integration-note"><span>⌾</span><div><strong>Secure execution</strong><p>Production credentials should be stored as secrets. Qpy Engage validates required fields, asks for consent, retries temporary failures, and records an audit log for every action.</p></div></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(2)}>Back</button><button className="primary" onClick={next}>Continue to channels →</button></div></>}</>}
    {step===4&&<><WizardTitle n="05" title="Channels and routing" text="Choose where the assistant works and how conversations reach a human team."/><div className="assistant-channel-grid">{[["WhatsApp","◉","Cloud API messages and approved templates","wa"],["Instagram","◎","Instagram direct messages and story replies","ig"],["Web chat","◌","Website visitor conversations","web"]].map(([name,icon,copy,tone])=><button key={name} className={selectedChannels.includes(name)?"selected":""} onClick={()=>toggleChannel(name)}><span className={tone}>{icon}</span><div><strong>{name}</strong><small>{copy}</small></div><b>{selectedChannels.includes(name)?"✓ Assigned":"Assign"}</b></button>)}</div><div className="routing-options"><label>New conversation routing<select><option>AI first, then human handoff</option><option>AI only outside business hours</option><option>Human first, AI assist only</option></select></label><label>Human handoff queue<select><option>{policies.handoffTeam}</option><option>Round robin across available agents</option><option>Least busy agent</option></select></label><label>Offline behavior<select><option>Collect details and create ticket</option><option>Offer callback</option><option>Send business hours</option></select></label></div><button className="text-action" onClick={onChannels}>Manage channel connections →</button><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(3)}>Back</button><button className="primary" disabled={!selectedChannels.length} onClick={next}>Configure voice →</button></div></>}
    {step===5&&<><WizardTitle n="06" title="Voice assistant" text="Add natural phone and browser conversations using the same knowledge, actions, and safety rules."/><div className="voice-enable"><div><span>☎</span><div><strong>Enable voice for {config.name}</strong><small>Inbound calls, click-to-call, and website voice conversations</small></div></div><label className="switch large"><input type="checkbox" checked={voice.enabled} onChange={e=>setVoice({...voice,enabled:e.target.checked})}/><i/></label></div>{voice.enabled?<><div className="voice-grid"><section><h3>Voice and language</h3><label>Voice<select value={voice.voiceName} onChange={e=>setVoice({...voice,voiceName:e.target.value})}>{availableVoices.length?availableVoices.map(v=><option key={v.voiceURI} value={v.name}>{v.name} ({v.lang})</option>):<option value={voice.voiceName}>Loading browser voices…</option>}</select><small>Real voices installed in this browser — Chrome/Edge offer the widest selection.</small></label><label>Spoken language<select value={voice.language} onChange={e=>setVoice({...voice,language:e.target.value})}><option>Auto-detect English / Arabic</option><option>English (UAE)</option><option>Arabic (Gulf)</option><option>English (US)</option></select></label><label>Speaking speed<input type="range" min="0.7" max="1.3" step="0.1" value={voice.speed} onChange={e=>setVoice({...voice,speed:e.target.value})}/><b>{voice.speed}×</b></label><button className="voice-preview" onClick={previewVoice}>▶ Preview voice</button></section><section><h3>Call entry</h3><label>Voice channel<select value={voice.channel} onChange={e=>setVoice({...voice,channel:e.target.value})}><option>Inbound phone</option><option>Website voice widget</option><option>Click-to-call campaigns</option></select></label><label>Opening greeting<textarea value={voice.greeting} onChange={e=>setVoice({...voice,greeting:e.target.value})}/></label><label>Recording and AI disclosure<textarea value={voice.consent} onChange={e=>setVoice({...voice,consent:e.target.value})}/></label></section></div><div className="voice-controls"><h3>Conversation controls</h3>{[["interruptions","Allow natural interruption","Stop speaking when the caller starts talking"],["noiseSuppression","Noise suppression","Reduce background noise and echo"],["recording","Call recording","Store recordings according to consent policy"],["transcripts","Live transcript","Create a searchable conversation transcript"],["summary","After-call summary","Save outcome, sentiment, and follow-up tasks"],["dtmf","Keypad fallback","Let callers use keypad choices when speech fails"],["voicemail","Voicemail handling","Collect a message when transfer is unavailable"]].map(([key,title,copy])=><label key={key}><div><strong>{title}</strong><small>{copy}</small></div><input type="checkbox" checked={Boolean(voice[key as keyof typeof voice])} onChange={e=>setVoice({...voice,[key]:e.target.checked})}/><span className="toggle-ui"/></label>)}</div><div className="voice-routing"><label>Silence timeout<select value={voice.silence} onChange={e=>setVoice({...voice,silence:e.target.value})}><option>5 seconds</option><option>8 seconds</option><option>12 seconds</option></select></label><label>Maximum call duration<select value={voice.maxDuration} onChange={e=>setVoice({...voice,maxDuration:e.target.value})}><option>10 minutes</option><option>15 minutes</option><option>30 minutes</option></select></label><label>Human transfer number<input value={voice.transferNumber} onChange={e=>setVoice({...voice,transferNumber:e.target.value})}/></label><label>Availability<select value={voice.businessHours} onChange={e=>setVoice({...voice,businessHours:e.target.value})}><option>Always available</option><option>Outside team hours</option><option>Business hours only</option></select></label></div><div className="voice-compliance"><span>✓</span><div><strong>Voice readiness</strong><p>Disclosure, recording preference, fallback, transfer destination, transcripts, and call limits are configured. Confirm local consent and telecommunications requirements before production use.</p></div></div></>:<div className="voice-off"><span>☎</span><h3>Voice is optional</h3><p>Turn it on when you want this assistant to answer inbound phone calls or power a website voice widget.</p></div>}<div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(4)}>Back</button><button className="primary" onClick={next}>Open test studio →</button></div></>}
    {step===6&&<><WizardTitle n="07" title="Test studio" text="Test chat, voice, actions, guardrails, handoff, and unsupported questions before publishing."/><div className="test-mode-tabs"><button className={testMode==="Chat"?"active":""} onClick={()=>setTestMode("Chat")}>◉ Chat simulation</button><button className={testMode==="Voice"?"active":""} onClick={()=>setTestMode("Voice")}>☎ Voice call</button></div>{testMode==="Chat"?<div className="assistant-test"><div className="assistant-test-head"><span className="assistant-avatar">✦</span><div><strong>{config.name}</strong><small>Draft v{version+1} • {selectedSources.length} sources • {actions.filter(a=>a.enabled).length} actions</small></div><b>Sandbox</b></div><div className="assistant-test-chat">{testMessages.map((message,i)=><div key={i} className={`message ${message.from}`}><p>{message.text}</p><small>{message.from==="ai"?"✦ Assistant":"Tester"} • Now</small></div>)}{testSending&&<div className="message ai"><p>…</p><small>✦ Assistant • thinking</small></div>}</div><div className="test-scenarios">{["Ask an unsupported question","Request a human agent","Trigger order lookup"].map(x=><button key={x} onClick={()=>setTestDraft(x)}>{x}</button>)}</div><div className="assistant-test-input"><input value={testDraft} onChange={e=>setTestDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendTest()} placeholder="Test a realistic customer message…" disabled={testSending}/><button className="primary" disabled={testSending||!testDraft.trim()} onClick={sendTest}>{testSending?"Sending…":"Send"}</button></div></div>:<div className="voice-test"><div className={`call-orb ${callState}`}><span>☎</span></div><h3>{callState==="idle"?"Start a browser voice test":callState==="connecting"?"Connecting…":callState!=="live"?"Test call ended":voiceStatus==="listening"?"Listening…":voiceStatus==="thinking"?"Thinking…":voiceStatus==="speaking"?`${config.name} is speaking…`:`Speaking with ${config.name}`}</h3><p>{voice.enabled?`${voice.voiceName} • ${voice.language}`:"Voice is disabled. You can still preview the workflow."}</p>{callState==="live"&&<div className="live-wave">▂ ▅ ▃ ▇ ▄ ▆ ▂</div>}{voice.transcripts&&voiceTranscript.length>0&&<div className="assistant-test-chat">{voiceTranscript.map((message,i)=><div key={i} className={`message ${message.from==="ai"?"ai":"customer"}`}><p>{message.text}</p><small>{message.from==="ai"?"✦ Assistant":"You"} • Now</small></div>)}</div>}{callState==="live"?<button className="danger-btn" onClick={endCall}>End test call</button>:<button className="primary" onClick={startCall}>{callState==="ended"?"Call again":"Start test call"}</button>}<div className="voice-test-checks"><span>✓ Disclosure played</span><span>✓ Interruption handling</span><span>✓ Transcript and summary</span><span>✓ Human transfer path</span></div></div>}<div className="evaluation-grid">{[["Grounded answers","96%","Knowledge citations present"],["Action readiness","2/2","All enabled actions passed"],["Safety & handoff","92%",`Transfers below ${policies.confidence}% confidence`],["Voice latency","640 ms","Target under 900 ms"]].map(([title,value,copy])=><div key={title}><small>{title}</small><strong>{value}</strong><span>{copy}</span></div>)}</div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(5)}>Back</button><button className="primary" onClick={next}>Review launch →</button></div></>}
    {step===7&&<div className="assistant-launch advanced-launch"><span className="assistant-avatar launch">✦</span><h2>Publish {config.name} version {version+1}</h2><p>Review operational readiness before this assistant handles real customer conversations.</p><div className="launch-readiness"><div><span>✓</span><strong>Profile and instructions</strong><small>{config.tone} • {config.language} • handoff at {policies.confidence}%</small></div><div><span>✓</span><strong>Knowledge</strong><small>{selectedSources.length} approved sources with automatic refresh</small></div><div><span>✓</span><strong>AI actions</strong><small>{actions.filter(a=>a.enabled).length} enabled • all test payloads passed</small></div><div><span>✓</span><strong>Customer channels</strong><small>{selectedChannels.join(", ")}</small></div><div><span>{voice.enabled?"✓":"–"}</span><strong>Voice assistant</strong><small>{voice.enabled?`${voice.channel} • ${voice.voiceName}`:"Not enabled for this version"}</small></div><div><span>✓</span><strong>Monitoring and rollback</strong><small>Audit logs, failure alerts, previous version rollback, and human override enabled</small></div></div><div className="launch-settings"><label>Release mode<select><option>Publish to all assigned channels</option><option>10% controlled rollout</option><option>Internal team only</option></select></label><label>Monitor first<select><option>100 conversations</option><option>24 hours</option><option>7 days</option></select></label></div><button className="primary launch-btn" onClick={launch}>{launched?`✓ Version ${version} is live`:`Publish version ${version+1}`}</button>{launched&&<div className="launch-after"><button className="secondary-btn" onClick={onAnalytics}>View monitoring</button><button className="secondary-btn" onClick={()=>{const previous=Math.max(1,version-1);setVersion(previous);setLaunched(true);notify(`Rolled back to version ${previous}`)}}>Rollback</button><button className="danger-link" onClick={()=>setLaunched(false)}>Pause assistant</button></div>}</div>}
  </div></section></div></>;
}

function Channels({step,setStep,connected,setConnected,workspaceId,workspaceName,notify}:{step:number;setStep:(n:number)=>void;connected:boolean;setConnected:(v:boolean)=>void;workspaceId:string;workspaceName:string;notify:(s:string)=>void}){
  const labels=["Requirements","Facebook","Credentials","Strategy","Testing","All done"];
  const [channel,setChannel]=useStoredState<"whatsapp"|"instagram"|"webchat">("qpy-engage-selected-channel","whatsapp");
  const [instagramStep,setInstagramStep]=useStoredState("qpy-engage-instagram-step",0);
  const [instagramConnected,setInstagramConnected]=useStoredState("qpy-engage-instagram-connected",false);
  const [checked,setChecked]=useState([true,true,false,false]);
  const [instagramChecked,setInstagramChecked]=useState([true,false,false]);
  const [connectionMode,setConnectionMode]=useState<"automatic"|"manual">("automatic");
  const [form,setForm]=useState({business:workspaceName,businessId:"",number:"",phoneId:"",wabaId:"",token:""});
  const [instagramForm,setInstagramForm]=useState({business:workspaceName,handle:"",pageId:"",token:""});
  const [test,setTest]=useState("+971 50 123 4567");
  const [metaConfig,setMetaConfig]=useState<MetaConfig|null>(null);
  const [metaConnection,setMetaConnection]=useState<MetaConnection|null>(null);
  const [metaLoading,setMetaLoading]=useState(false);
  const [metaError,setMetaError]=useState("");
  const token=useAuthToken();
  const copyWidget=async()=>{const code=`<script src="https://mobileecommerce.github.io/qpy-engage/widget.js" data-workspace="${workspaceId}"></script>`;try{await navigator.clipboard.writeText(code);notify("Web chat installation code copied")}catch{const blob=new Blob([code],{type:"text/plain"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="qpy-engage-widget.txt";a.click();URL.revokeObjectURL(a.href);notify("Web chat installation file downloaded")}};
  const [widgetAppearance,setWidgetAppearance]=useStoredState<WidgetAppearance>("qpy-engage-widget-appearance",{iconType:"brand",customIconUrl:"",placement:"right",effect:"none",color:"#4c50ee"});
  const [workingHours,setWorkingHours]=useStoredState<WorkingHours>("qpy-engage-working-hours",DEFAULT_WORKING_HOURS);
  const setDay=(day:WeekdayKey,patch:Partial<{open:boolean;start:string;end:string}>)=>setWorkingHours({...workingHours,days:{...workingHours.days,[day]:{...workingHours.days[day],...patch}}});
  const uploadWidgetIcon=(file?:File)=>{
    if(!file)return;
    if(!["image/jpeg","image/png","image/webp","image/svg+xml"].includes(file.type)){notify("Choose a JPG, PNG, WebP, or SVG image");return}
    if(file.size>300*1024){notify("Icon must be smaller than 300 KB");return}
    const reader=new FileReader();
    reader.onload=()=>{setWidgetAppearance({...widgetAppearance,iconType:"custom",customIconUrl:String(reader.result||"")});notify("Custom icon uploaded")};
    reader.readAsDataURL(file);
  };
  const iconOptions:{key:WidgetAppearance["iconType"];label:string}[]=[{key:"brand",label:"Q mark"},{key:"chat",label:"Chat"},{key:"help",label:"Help"},{key:"spark",label:"Spark"}];
  const widgetIconGlyph=(type:WidgetAppearance["iconType"])=>{
    if(type==="chat")return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-4.5 7.5 8.5 8.5 0 0 1-7.6.9L3 21l1.9-5.9a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>;
    if(type==="help")return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><circle cx="12" cy="17" r=".6" fill="#fff" stroke="none"/></svg>;
    if(type==="spark")return <svg viewBox="0 0 24 24" width="18" height="18" fill="#fff"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>;
    return "Q";
  };
  const refreshMeta=async()=>{try{const [configResponse,statusResponse]=await Promise.all([fetch(metaApi("/api/meta/config")),fetch(metaApi("/api/meta/status"),{headers:authHeaders(token)})]);const config=await configResponse.json() as MetaConfig;const status=await statusResponse.json() as {connected:boolean;connection:MetaConnection|null};setMetaConfig(config);setMetaConnection(status.connection);if(status.connection){setConnected(true);setForm(current=>({...current,business:status.connection?.verifiedName||current.business,number:status.connection?.displayPhoneNumber||current.number,phoneId:status.connection?.phoneNumberId||current.phoneId,wabaId:status.connection?.wabaId||current.wabaId}))}}catch{setMetaError("The secure Qpy Engage backend is not reachable.")}};
  useEffect(()=>{refreshMeta()},[token]);
  const connectMeta=async()=>{
    if(!metaConfig?.ready){setMetaError(`Meta app setup is incomplete${metaConfig?.missing?.length?`: ${metaConfig.missing.join(", ")}`:"."}`);return}
    setMetaLoading(true);setMetaError("");
    try{
      await loadMetaSdk(metaConfig);
      const sessionPromise=new Promise<{wabaId:string;phoneNumberId:string;businessId?:string}>((resolve,reject)=>{
        const timeout=window.setTimeout(()=>{window.removeEventListener("message",listener);reject(new Error("Meta did not return the selected WhatsApp assets."))},300000);
        const listener=(event:MessageEvent)=>{if(event.origin!=="https://www.facebook.com"&&event.origin!=="https://web.facebook.com")return;let payload=event.data;try{if(typeof payload==="string")payload=JSON.parse(payload)}catch{return}if(payload?.type!=="WA_EMBEDDED_SIGNUP")return;if(payload.event==="FINISH"){window.clearTimeout(timeout);window.removeEventListener("message",listener);resolve({wabaId:String(payload.data?.waba_id||""),phoneNumberId:String(payload.data?.phone_number_id||""),businessId:payload.data?.business_id?String(payload.data.business_id):undefined})}else if(payload.event==="CANCEL"||payload.event==="ERROR"){window.clearTimeout(timeout);window.removeEventListener("message",listener);reject(new Error(payload.data?.error_message||"Meta signup was cancelled."))}};
        window.addEventListener("message",listener);
      });
      const codePromise=new Promise<string>((resolve,reject)=>window.FB?.login(response=>response.authResponse?.code?resolve(response.authResponse.code):reject(new Error("Meta authorization was not completed.")),{config_id:metaConfig.configId,response_type:"code",override_default_response_type:true,extras:{setup:{},sessionInfoVersion:"3"}}));
      const [code,assets]=await Promise.all([codePromise,sessionPromise]);
      const response=await fetch(metaApi("/api/meta/oauth/exchange"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({code,wabaId:assets.wabaId,phoneNumberId:assets.phoneNumberId,businessId:assets.businessId})});
      const result=await response.json() as {connected?:boolean;connection?:MetaConnection;error?:string};if(!response.ok||!result.connection)throw new Error(result.error||"Meta connection could not be completed.");
      setMetaConnection(result.connection);setConnected(true);setForm(current=>({...current,business:result.connection?.verifiedName||current.business,number:result.connection?.displayPhoneNumber||current.number,phoneId:result.connection?.phoneNumberId||current.phoneId,wabaId:result.connection?.wabaId||current.wabaId}));setStep(2);notify("WhatsApp Business connected securely through Meta");
    }catch(error){setMetaError(error instanceof Error?error.message:"Meta connection failed.")}finally{setMetaLoading(false)}
  };
  const connectManualMeta=async()=>{
    if(!form.wabaId.trim()||!form.phoneId.trim()||!form.token.trim()){setMetaError("Enter the WABA ID, Phone Number ID, and Meta access token from API Setup.");return}
    setMetaLoading(true);setMetaError("");
    try{
      const response=await fetch(metaApi("/api/meta/manual/connect"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({wabaId:form.wabaId,phoneNumberId:form.phoneId,businessId:form.businessId,accessToken:form.token})});
      const result=await response.json() as {connected?:boolean;connection?:MetaConnection;error?:string};
      if(!response.ok||!result.connection)throw new Error(result.error||"Meta credentials could not be verified.");
      setMetaConnection(result.connection);setConnected(true);setForm(current=>({...current,token:"",business:result.connection?.verifiedName||current.business,number:result.connection?.displayPhoneNumber||current.number,phoneId:result.connection?.phoneNumberId||current.phoneId,wabaId:result.connection?.wabaId||current.wabaId}));setStep(3);notify("WhatsApp Cloud API connected securely");
    }catch(error){setMetaError(error instanceof Error?error.message:"Manual Meta connection failed.")}finally{setMetaLoading(false)}
  };
  const sendMetaTest=async()=>{setMetaLoading(true);setMetaError("");try{const response=await fetch(metaApi("/api/meta/test-message"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({to:test})});const result=await response.json() as {sent?:boolean;error?:string};if(!response.ok)throw new Error(result.error||"Test message failed.");notify("Meta accepted the WhatsApp test message");next()}catch(error){setMetaError(error instanceof Error?error.message:"Test message failed.")}finally{setMetaLoading(false)}};
  const disconnectMeta=async()=>{if(!window.confirm("Disconnect this WhatsApp Business account from Qpy Engage?"))return;const response=await fetch(metaApi("/api/meta/connection"),{method:"DELETE",headers:authHeaders(token)});if(response.ok){setMetaConnection(null);setConnected(false);setStep(0);notify("WhatsApp Business disconnected")}else{const result=await response.json() as {error?:string};setMetaError(result.error||"Disconnect failed.")}};
  const next=()=>setStep(Math.min(5,step+1));
  const nextInstagram=()=>setInstagramStep(Math.min(5,instagramStep+1));
  const activeStep=channel==="instagram"?instagramStep:step;
  const setActiveStep=channel==="instagram"?setInstagramStep:setStep;
  const liveLabel=channel==="instagram"&&instagramConnected?"● Instagram live":channel==="whatsapp"&&metaConnection?"● WhatsApp live":undefined;
  return <><PageHeader title="Channels" description="Connect and manage your customer messaging channels." action={liveLabel?<span className="status-pill ready">{liveLabel}</span>:undefined}/><div className="channel-layout"><aside className="channel-list"><h3>Messaging channels</h3><button className={channel==="whatsapp"?"selected":""} onClick={()=>setChannel("whatsapp")}><span className="wa-logo">◉</span><div><strong>WhatsApp</strong><small>{metaConnection?`${metaConnection.displayPhoneNumber||"Cloud API"} connected`:"Official Cloud API channel"}</small></div></button><button className={channel==="instagram"?"selected":""} onClick={()=>setChannel("instagram")}><span className="instagram-logo">◎</span><div><strong>Instagram</strong><small>{instagramConnected?"Connected sandbox":"Instagram Messaging API"}</small></div></button><button className={channel==="webchat"?"selected":""} onClick={()=>setChannel("webchat")}><span className="web-logo">◌</span><div><strong>Web chat</strong><small>Website messaging widget</small></div></button></aside>{channel==="webchat"?<section className="channel-empty widget-customizer"><span className="web-logo">◌</span><h2>Web chat widget</h2><p>Add Qpy Engage to your website so visitors can talk with your AI assistant before opening WhatsApp or Instagram. Customize how the launcher looks below — changes apply instantly to your live installed widget.</p><div className="widget-preview-frame"><div className={`widget-preview-launcher effect-${widgetAppearance.effect}`} style={{background:widgetAppearance.color}}>{widgetAppearance.iconType==="custom"&&widgetAppearance.customIconUrl?<img src={widgetAppearance.customIconUrl} alt="Custom widget icon"/>:widgetIconGlyph(widgetAppearance.iconType)}</div><small>Live preview • {widgetAppearance.placement==="left"?"bottom-left":"bottom-right"}</small></div><div className="widget-icon-grid">{iconOptions.map(opt=><button key={opt.key} className={widgetAppearance.iconType===opt.key?"selected":""} onClick={()=>setWidgetAppearance({...widgetAppearance,iconType:opt.key})}><span style={{background:widgetAppearance.color}}>{widgetIconGlyph(opt.key)}</span><small>{opt.label}</small></button>)}<label className={`widget-icon-upload ${widgetAppearance.iconType==="custom"?"selected":""}`}>{widgetAppearance.customIconUrl?<img src={widgetAppearance.customIconUrl} alt="Your uploaded icon"/>:<span>＋</span>}<small>Custom</small><input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" onChange={e=>uploadWidgetIcon(e.target.files?.[0])}/></label></div><div className="form-grid"><div className="connection-mode widget-placement"><small>Placement</small><div><button className={widgetAppearance.placement==="right"?"active":""} onClick={()=>setWidgetAppearance({...widgetAppearance,placement:"right"})}>Bottom right</button><button className={widgetAppearance.placement==="left"?"active":""} onClick={()=>setWidgetAppearance({...widgetAppearance,placement:"left"})}>Bottom left</button></div></div><label>Launcher effect<select value={widgetAppearance.effect} onChange={e=>setWidgetAppearance({...widgetAppearance,effect:e.target.value as WidgetAppearance["effect"]})}><option value="none">None</option><option value="pulse">Pulse</option><option value="bounce">Bounce</option></select></label><label>Accent color<input type="color" value={widgetAppearance.color} onChange={e=>setWidgetAppearance({...widgetAppearance,color:e.target.value})}/></label></div><div className="working-hours"><div className="working-hours-head"><div><strong>Business hours</strong><small>When enabled, the AI knows when your team is offline and can say so instead of promising an instant human reply.</small></div><label className="switch"><input type="checkbox" checked={workingHours.enabled} onChange={e=>setWorkingHours({...workingHours,enabled:e.target.checked})}/><i/></label></div>{workingHours.enabled&&<><label className="full-label">Timezone<select value={workingHours.timezone} onChange={e=>setWorkingHours({...workingHours,timezone:e.target.value})}>{TIMEZONE_OPTIONS.map(tz=><option key={tz} value={tz}>{tz}</option>)}</select></label><div className="working-hours-days">{WEEKDAYS.map(([key,label])=><div key={key} className="working-hours-row"><label className="working-hours-toggle"><input type="checkbox" checked={workingHours.days[key].open} onChange={e=>setDay(key,{open:e.target.checked})}/>{label}</label><input type="time" value={workingHours.days[key].start} disabled={!workingHours.days[key].open} onChange={e=>setDay(key,{start:e.target.value})}/><span>to</span><input type="time" value={workingHours.days[key].end} disabled={!workingHours.days[key].open} onChange={e=>setDay(key,{end:e.target.value})}/></div>)}</div></>}</div><button className="primary" onClick={copyWidget}>Copy installation code</button></section>:<section className="channel-workspace"><div className={`channel-context ${channel}`}><div className={channel==="whatsapp"?"wa-logo":"instagram-logo"}>{channel==="whatsapp"?"◉":"◎"}</div><div><span>{channel==="whatsapp"?"META BUSINESS MESSAGING":"META BUSINESS SUITE"}</span><strong>{channel==="whatsapp"?"WhatsApp Cloud API":"Instagram Messaging API"}</strong><small>{metaConnection&&channel==="whatsapp"?`${metaConnection.displayPhoneNumber||metaConnection.phoneNumberId} • Connected through Meta`:instagramConnected&&channel==="instagram"?`${instagramForm.handle} • Connected`:"Secure connection through Meta"}</small></div>{channel==="whatsapp"&&<div className="connection-mode"><small>Setup method</small><div><button className={connectionMode==="automatic"?"active":""} onClick={()=>setConnectionMode("automatic")}>Embedded signup</button><button className={connectionMode==="manual"?"active":""} onClick={()=>setConnectionMode("manual")}>Advanced</button></div></div>}<span className={`connection-health ${(metaConnection&&channel==="whatsapp")||(instagramConnected&&channel==="instagram")?"live":""}`}><i/>{(metaConnection&&channel==="whatsapp")||(instagramConnected&&channel==="instagram")?"Live":"Setup in progress"}</span></div><div className="wizard-rail">{labels.map((label,i)=><button key={label} onClick={()=>i<=activeStep&&setActiveStep(i)} className={i<activeStep?"done":i===activeStep?"active":""}><span>{i<activeStep?"✓":i+1}</span><div><strong>{label}</strong><small>{i<activeStep?"Completed":i===activeStep?"Current step":"Not started"}</small></div></button>)}</div><div className="wizard-panel">
    {channel==="instagram"&&<>
      {instagramStep===0&&<><WizardTitle n="01" title="Instagram Messaging requirements" text="Prepare your professional account before connecting through Meta."/><div className="requirements instagram-requirements">{["An Instagram professional Business or Creator account","A Facebook Page linked to the Instagram account","Admin access to the connected Meta Business portfolio"].map((x,i)=><label key={x}><input type="checkbox" checked={instagramChecked[i]} onChange={()=>setInstagramChecked(instagramChecked.map((v,j)=>j===i?!v:v))}/><span>{x}</span><b>Required</b></label>)}</div><div className="wizard-actions"><span>Demo mode — authorization is simulated.</span><button className="primary" disabled={!instagramChecked.every(Boolean)} onClick={nextInstagram}>Proceed to connect →</button></div></>}
      {instagramStep===1&&<><WizardTitle n="02" title="Connect Instagram with Facebook" text="Authorize Qpy Engage to manage Instagram conversations for your business."/><div className="facebook-connect instagram-connect"><span className="instagram-logo large">◎</span><h3>Continue with Facebook</h3><p>Select the Facebook Page and linked Instagram professional account you want to use.</p><ul><li>View your Instagram professional profile</li><li>Read and respond to customer messages</li><li>Manage conversation metadata</li></ul><button className="facebook-btn" onClick={()=>{notify("Instagram authorization completed");nextInstagram()}}>Continue with Facebook</button><small>Qpy Engage never receives your Facebook password.</small></div></>}
      {instagramStep===2&&<><WizardTitle n="03" title="Confirm Instagram account" text="Review the Instagram and Meta assets selected during authorization."/><div className="form-grid"><label>Business portfolio<input value={instagramForm.business} onChange={e=>setInstagramForm({...instagramForm,business:e.target.value})}/></label><label>Instagram username<input value={instagramForm.handle} onChange={e=>setInstagramForm({...instagramForm,handle:e.target.value})}/></label><label>Facebook Page ID<input value={instagramForm.pageId} onChange={e=>setInstagramForm({...instagramForm,pageId:e.target.value})}/></label><label>Page access token<input type="password" placeholder="Paste Meta page token" value={instagramForm.token} onChange={e=>setInstagramForm({...instagramForm,token:e.target.value})}/></label></div><div className="info-banner">ⓘ This prototype keeps connection details only in your browser. Production tokens must be exchanged and encrypted on a secure server.</div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setInstagramStep(1)}>Back</button><button className="primary" onClick={nextInstagram}>Save account →</button></div></>}
      {instagramStep===3&&<><WizardTitle n="04" title="Choose Instagram routing" text="Decide how new Instagram direct messages are assigned."/><div className="strategy-grid">{[["AI first","Qpy Engage responds instantly and hands off uncertain requests."],["Round robin","Rotate new Instagram conversations across online agents."],["Least busy","Assign each message to the agent with the lightest workload."]].map((x,i)=><label className={i===0?"selected":""} key={x[0]}><input type="radio" name="instagram-strategy" defaultChecked={i===0}/><span>✦</span><div><strong>{x[0]}</strong><p>{x[1]}</p></div></label>)}</div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setInstagramStep(2)}>Back</button><button className="primary" onClick={nextInstagram}>Save strategy →</button></div></>}
      {instagramStep===4&&<><WizardTitle n="05" title="Test Instagram messaging" text="Confirm Qpy Engage can receive and respond to an Instagram direct message."/><div className="test-card instagram-test"><div className="test-phone"><span>IG</span><div><strong>{instagramForm.handle}</strong><small>Connected through Instagram Messaging API</small></div></div><label>Test Instagram username<input defaultValue="@praveen"/></label><div className="test-message">Hello from Atelier Home! Your Qpy Engage Instagram channel is ready. ✨</div><button className="primary" onClick={()=>{notify("Instagram test message delivered");nextInstagram()}}>Send test message</button></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setInstagramStep(3)}>Back</button><span>Delivery status will appear after the test.</span></div></>}
      {instagramStep===5&&<div className="success-state"><span>✓</span><h2>Instagram is ready</h2><p>Your professional account is connected, routing is configured, and the test message was delivered.</p><div><strong>{instagramForm.handle}</strong><small>Instagram Business • Atelier Home</small></div><button className="primary" onClick={()=>{setInstagramConnected(true);notify("Instagram channel activated")}}>Activate channel</button>{instagramConnected&&<button className="danger-link" onClick={()=>{setInstagramConnected(false);setInstagramStep(0)}}>Disconnect and restart</button>}</div>}
    </>}
    {channel==="whatsapp"&&<>
    {step===0&&<><WizardTitle n="01" title="Prepare your Meta business account" text="Meta’s embedded signup handles the WhatsApp account and phone-number decision later."/><div className="wa-readiness"><div className="wa-readiness-head"><div><span>✓</span><div><strong>Meta integration checklist</strong><small>{checked.slice(0,3).filter(Boolean).length} of 3 required items ready</small></div></div><b>{Math.round(checked.slice(0,3).filter(Boolean).length/3*100)}%</b></div><div className="readiness-progress"><i style={{width:`${checked.slice(0,3).filter(Boolean).length/3*100}%`}}/></div><div className="requirements polished">{[["Facebook login","Use an account with admin access to your Meta Business portfolio."],["Business website","Meta uses this to identify and verify the business."],["Phone-number decision inside Meta","Embedded signup will show eligible existing numbers and the option to add a new one."],["Meta billing method","Needed when Meta charges for outbound template conversations."]].map(([title,copy],i)=><label key={title}><input type="checkbox" checked={checked[i]} onChange={()=>setChecked(checked.map((v,j)=>j===i?!v:v))}/><span className="check-ui">{checked[i]?"✓":""}</span><div><strong>{title}</strong><small>{copy}</small></div>{i<3?<b>Required</b>:<em>Later</em>}</label>)}</div></div><div className="secure-note"><span>⌾</span><div><strong>Secure Meta authorization</strong><small>Qpy Engage uses Meta’s own login window and never receives your Facebook password.</small></div></div><div className="wizard-actions"><span>{metaConfig?.ready?"Meta app backend is ready for embedded signup.":"Meta app credentials still need to be configured."}</span><button className="primary wa-primary" disabled={!checked.slice(0,3).every(Boolean)} onClick={next}>Continue to Meta integration →</button></div></>}
    {step===1&&connectionMode==="automatic"&&<><WizardTitle n="02" title="Connect Qpy Engage to Meta" text="Use Meta’s official embedded signup to authorize the app and select the business assets."/>{metaError&&<div className="meta-error">⚠ {metaError}</div>}<div className="meta-server-status"><div><span className={metaConfig?.ready?"ready":"pending"}>{metaConfig?.ready?"✓":"!"}</span><div><strong>{metaConfig?.ready?"Meta app configured":"Meta app configuration required"}</strong><small>{metaConfig?.ready?`Graph API ${metaConfig.graphVersion} • webhook endpoint ready`:`Missing: ${metaConfig?.missing?.join(", ")||"loading configuration…"}`}</small></div></div><button onClick={refreshMeta}>↻ Check again</button></div><div className="meta-embedded"><div className="meta-brand"><span className="meta-loop">∞</span><div><strong>Meta</strong><small>Embedded signup</small></div><b>Secure</b></div><div className="meta-content"><h3>Connect WhatsApp Business</h3><p>Meta will ask you to sign in, select or create the WhatsApp Business Account, and choose an eligible existing or new phone number.</p><div className="meta-flow"><div><span>1</span><strong>Log in to Facebook</strong><small>Use a Meta Business administrator</small></div><i>→</i><div><span>2</span><strong>Select business assets</strong><small>Portfolio, WABA, and phone number</small></div><i>→</i><div><span>3</span><strong>Authorize Qpy Engage</strong><small>Token is exchanged only by the secure backend</small></div></div><button className="facebook-btn meta-button" disabled={!metaConfig?.ready||metaLoading} onClick={connectMeta}><span className="fb-mini">f</span> {metaLoading?"Connecting securely…":metaConnection?"Reconnect with Facebook":"Continue with Facebook"}</button><small>By continuing, you agree to Meta’s Business Messaging terms.</small></div><div className="meta-permissions"><strong>Permissions requested</strong><span>✓ Manage WhatsApp business accounts</span><span>✓ Send and receive customer messages</span><span>✓ Read phone-number quality and status</span><span>✓ Subscribe Qpy Engage to webhook events</span></div></div><div className="meta-webhook"><strong>Webhook callback</strong><code>{metaConfig?.webhookUrl||`${META_BACKEND_ORIGIN}/api/webhooks/whatsapp`}</code><small>Qpy Engage verifies Meta’s challenge and validates every webhook signature.</small></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(0)}>Back</button><span>Meta’s window usually takes less than 3 minutes.</span></div></>}
    {step===1&&connectionMode==="manual"&&<><WizardTitle n="02" title="Connect with Cloud API credentials" text="Use the temporary credentials in Meta API Setup while business verification is pending."/>{metaError&&<div className="meta-error">⚠ {metaError}</div>}<div className="meta-server-status"><div><span className={metaConfig?.ready?"ready":"pending"}>{metaConfig?.ready?"✓":"!"}</span><div><strong>Secure backend ready</strong><small>Credentials are verified with Meta, encrypted, and never returned to this browser.</small></div></div><button onClick={refreshMeta}>↻ Check again</button></div><div className="data-card advanced-credentials"><div className="card-head"><div><h2>Meta API Setup credentials</h2><p>Copy these values from Use cases → Connect on WhatsApp → API Setup.</p></div></div><div className="form-grid"><label>WhatsApp Business Account ID<input inputMode="numeric" value={form.wabaId} onChange={e=>setForm({...form,wabaId:e.target.value.replace(/\D/g,"")})} placeholder="WABA ID"/></label><label>Phone Number ID<input inputMode="numeric" value={form.phoneId} onChange={e=>setForm({...form,phoneId:e.target.value.replace(/\D/g,"")})} placeholder="Phone Number ID"/></label><label>Business Portfolio ID <small>Optional</small><input inputMode="numeric" value={form.businessId} onChange={e=>setForm({...form,businessId:e.target.value.replace(/\D/g,"")})} placeholder="Business ID"/></label><label>Meta access token<input type="password" autoComplete="off" value={form.token} onChange={e=>setForm({...form,token:e.target.value})} placeholder="Temporary or system-user token"/></label></div></div><div className="info-banner secure">⌾ Qpy Engage validates both IDs with Meta, subscribes the WABA to the verified webhook, and stores only an encrypted token.</div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(0)}>Back</button><button className="primary wa-primary" disabled={metaLoading||!form.wabaId||!form.phoneId||!form.token} onClick={connectManualMeta}>{metaLoading?"Verifying with Meta…":"Verify and connect →"}</button></div></>}
    {step===2&&<><WizardTitle n="03" title={connectionMode==="automatic"?"Confirm selected Meta assets":"Advanced connection"} text={connectionMode==="automatic"?"These assets were returned and verified by Meta.":"System-user token onboarding will use the same encrypted server connection."}/>{connectionMode==="automatic"?<div className="meta-assets"><div className="asset-card"><span>▣</span><div><small>BUSINESS PORTFOLIO</small><strong>{metaConnection?.businessId||"Selected in Meta"}</strong><em>Authorized asset</em></div><b>✓</b></div><div className="asset-card"><span className="wa">◉</span><div><small>WHATSAPP BUSINESS ACCOUNT</small><strong>{metaConnection?.wabaId||"Waiting for Meta"}</strong><em>{metaConnection?.webhookSubscribed?"Webhook subscribed":"Subscription pending"}</em></div><b>{metaConnection?"✓":"…"}</b></div><div className="asset-card featured"><span>☎</span><div><small>PHONE NUMBER</small><strong>{metaConnection?.displayPhoneNumber||"Waiting for Meta"}</strong><em>Display name: {metaConnection?.verifiedName||"—"}</em></div><b>{metaConnection?.qualityRating||"—"}</b></div><button className="text-action" onClick={refreshMeta}>↻ Refresh assets from Meta</button></div>:<div className="advanced-meta-note"><span>⌾</span><div><strong>Embedded signup is recommended</strong><p>Manual system-user tokens must also be submitted directly to the secure backend and never stored in the browser. This path will be enabled after the Meta app is configured.</p></div><button className="secondary-btn" onClick={()=>setConnectionMode("automatic")}>Use embedded signup</button></div>}<div className="info-banner secure">⌾ Access tokens are encrypted with AES-GCM on the server and are never returned to the browser.</div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(1)}>Back</button><button className="primary wa-primary" disabled={connectionMode==="automatic"&&!metaConnection} onClick={next}>Confirm connection →</button></div></>}
    {step===3&&<><WizardTitle n="04" title="Choose conversation routing" text="Decide how new WhatsApp conversations are assigned."/><div className="strategy-grid">{[["AI first","Qpy Engage answers instantly and hands off when confidence is low."],["Round robin","New conversations rotate evenly across online agents."],["Least busy","Assign to the agent with the fewest active conversations."]].map((x,i)=><label className={i===0?"selected":""} key={x[0]}><input type="radio" name="strategy" defaultChecked={i===0}/><span>✦</span><div><strong>{x[0]}</strong><p>{x[1]}</p></div></label>)}</div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(2)}>Back</button><button className="primary" onClick={next}>Save strategy →</button></div></>}
    {step===4&&<><WizardTitle n="05" title="Verify your live Meta connection" text="Send Meta’s approved hello_world template and confirm webhook health."/>{metaError&&<div className="meta-error">⚠ {metaError}</div>}<div className="wa-test-layout"><div className="test-card polished-test"><div className="test-phone"><span>WA</span><div><strong>{metaConnection?.verifiedName||"WhatsApp Business"}</strong><small>{metaConnection?.displayPhoneNumber||form.number} • Cloud API</small></div><b>{metaConnection?"Connected":"Pending"}</b></div><label>Test recipient<input value={test} onChange={e=>setTest(e.target.value)}/><small>Use an opted-in number including country code.</small></label><div className="test-message">Meta template: hello_world • English (US)</div><button className="primary wa-primary" disabled={!metaConnection||metaLoading} onClick={sendMetaTest}>➤ {metaLoading?"Sending through Meta…":"Send test message"}</button></div><div className="connection-diagnostics"><h3>Connection diagnostics</h3>{[["Cloud API",metaConnection?"Authorized":"Not connected"],["Webhook",metaConnection?.webhookSubscribed?"Subscribed":"Pending"],["Phone quality",metaConnection?.qualityRating||"Pending"],["Phone status",metaConnection?.status||"Pending"]].map(([label,value])=><div key={label}><span className={value!=="Pending"&&value!=="Not connected"?"ok":""}>{value!=="Pending"&&value!=="Not connected"?"✓":"…"}</span><label>{label}<strong>{value}</strong></label></div>)}<button onClick={refreshMeta}>↻ Run diagnostics again</button></div></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(3)}>Back</button><span>Delivery and read receipts arrive through the verified webhook.</span></div></>}
    {step===5&&<div className="success-state"><span>✓</span><h2>WhatsApp is connected</h2><p>Qpy Engage is authorized with Meta, subscribed to webhooks, and ready to receive customer messages.</p><div><strong>{metaConnection?.displayPhoneNumber||form.number}</strong><small>WhatsApp Business • {metaConnection?.verifiedName||form.business}</small></div><button className="primary" onClick={()=>{setConnected(true);notify("WhatsApp channel activated")}}>Activate in Qpy Engage</button>{metaConnection&&<button className="secondary-btn" onClick={()=>{setConnectionMode("manual");setStep(1);setMetaError("")}}>Refresh access token</button>}{metaConnection&&<button className="danger-link" onClick={disconnectMeta}>Disconnect from Meta</button>}</div>}
    </>}
  </div></section>}</div></>;
}

function WizardTitle({n,title,text}:{n:string;title:string;text:string}){return <div className="wizard-title"><span>{n}</span><div><h2>{title}</h2><p>{text}</p></div></div>}

function LiveInbox({notify}:{notify:(s:string)=>void}){
  const token=useAuthToken();
  const [messages,setMessages]=useState<LiveWhatsAppMessage[]>([]);
  const [selectedWaId,setSelectedWaId]=useState("");
  const [draft,setDraft]=useState("");
  const [loading,setLoading]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");
  const [loaded,setLoaded]=useState(false);

  const refresh=async(silent=false)=>{
    if(!token)return;
    if(!silent)setLoading(true);setError("");
    try{
      const response=await fetch(metaApi("/api/meta/inbox"),{headers:authHeaders(token)});
      const result=await response.json() as {messages?:LiveWhatsAppMessage[];error?:string};
      if(!response.ok)throw new Error(result.error||"Inbox could not be loaded.");
      const next=result.messages||[];setMessages(next);setLoaded(true);
      const ids=next.map(message=>message.waId).filter((id):id is string=>Boolean(id));
      if(ids.length&&!ids.includes(selectedWaId))setSelectedWaId(ids[0]);
    }catch(problem){setError(problem instanceof Error?problem.message:"Inbox could not be loaded.")}finally{if(!silent)setLoading(false)}
  };

  useEffect(()=>{if(!token)return;refresh();const timer=window.setInterval(()=>refresh(true),8000);return()=>window.clearInterval(timer)},[token]);

  const contacts=[...new Set(messages.map(message=>message.waId).filter((id):id is string=>Boolean(id)))].map((waId,index)=>{
    const thread=messages.filter(message=>message.waId===waId&&message.text);const last=thread.at(-1);
    return {waId,thread,last,index};
  }).sort((a,b)=>Number(b.last?.timestamp||0)-Number(a.last?.timestamp||0));
  const selected=contacts.find(contact=>contact.waId===selectedWaId)||contacts[0];
  const formatTime=(message:LiveWhatsAppMessage)=>{const numeric=Number(message.timestamp||0);const date=numeric?new Date(numeric*1000):new Date(message.createdAt);return Number.isNaN(date.getTime())?"Now":date.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})};
  const send=async()=>{if(!selected||!draft.trim()||sending)return;setSending(true);setError("");try{const response=await fetch(metaApi("/api/meta/inbox/messages"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({to:selected.waId,text:draft.trim()})});const result=await response.json() as {message?:LiveWhatsAppMessage;error?:string};if(!response.ok||!result.message)throw new Error(result.error||"Message could not be sent.");setMessages(current=>[...current,result.message!]);setDraft("");notify("WhatsApp message sent through Meta")}catch(problem){const message=problem instanceof Error?problem.message:"Message could not be sent.";setError(/auth|token|session|oauth/i.test(message)?`${message} Refresh the Meta access token in Channels → WhatsApp → Advanced, then retry.`:message)}finally{setSending(false)}};

  return <><PageHeader title="Live WhatsApp inbox" description="Messages received by the verified Meta webhook appear here automatically." action={<button className="secondary-btn" disabled={loading} onClick={()=>refresh()}>{loading?"Refreshing…":"↻ Refresh"}</button>}/>{error&&<div className="meta-error">⚠ {error}</div>}{loaded&&!contacts.length?<div className="data-card live-inbox-empty"><span>◉</span><h2>No WhatsApp webhook messages yet</h2><p>The connection is ready, but Meta has not delivered an inbound message to Qpy Engage. Send a dashboard test webhook from Meta Configuration, or publish the Meta app before testing real customer replies.</p><button className="primary" onClick={()=>refresh()}>Check again</button></div>:<div className="full-inbox live"><aside className="inbox-list"><div className="inbox-tools"><strong>{contacts.length} live conversation{contacts.length===1?"":"s"}</strong><small>Cloud API • refreshes every 8 seconds</small></div><div className="conversation-list">{contacts.map(contact=><button key={contact.waId} className={selected?.waId===contact.waId?"selected":""} onClick={()=>setSelectedWaId(contact.waId)}><span className={`contact-avatar ${["green","blue","lavender","peach"][contact.index%4]}`}>WA<i/></span><div><strong>+{contact.waId}</strong><small>{contact.last?.text||"WhatsApp event"}</small></div><span className="conv-meta"><small>{contact.last?formatTime(contact.last):"Now"}</small></span></button>)}</div></aside><section className="chat-panel">{selected?<><div className="chat-head"><div className="chat-person"><span className="contact-avatar green">WA<i/></span><div><strong>+{selected.waId}</strong><small>WhatsApp Cloud API • Live</small></div></div><span className="status-pill ready">● Webhook connected</span></div><div className="chat-body tall"><div className="today">Live messages</div>{selected.thread.map(message=><div key={message.id} className={`message ${message.direction==="inbound"?"customer":"agent"}`}><p>{message.text}</p><small>{message.direction==="outbound"?"You • ":""}{formatTime(message)} {message.direction==="outbound"&&`• ${message.status||"sent"}`}</small></div>)}</div><div className="composer"><div className="input-row"><input value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>event.key==="Enter"&&send()} placeholder="Reply through WhatsApp…"/><button className="send" disabled={sending||!draft.trim()} onClick={send}>{sending?"…":"➤"}</button></div></div></>:<div className="live-chat-placeholder">Select a live conversation</div>}</section><aside className="customer-panel">{selected&&<><span className="contact-avatar large green">WA</span><h3>+{selected.waId}</h3><small>WhatsApp customer</small><div className="details-list"><label>Channel<strong>WhatsApp Cloud API</strong></label><label>Messages<strong>{selected.thread.length}</strong></label><label>Status<strong className="status-text">open</strong></label></div></>}</aside></div>}</>;
}

function EmptyInbox({onConnect}:{onConnect:()=>void}){
  return <><PageHeader title="Unified inbox" description="Manage every customer conversation from one place."/><div className="empty-state"><span>◉</span><h3>No conversations yet</h3><p>Connect a channel like WhatsApp to start receiving real customer messages here.</p><button className="primary" onClick={onConnect}>Connect a channel →</button></div></>;
}

type WidgetConversationSummary={sessionId:string;messageCount:number;lastMessage:string;lastRole:string;firstAt:string;lastAt:string;aiActive:boolean;customerName?:string|null;leadStatus?:string|null;needsAttention?:boolean;attentionReason?:string|null};
type WidgetMessage={role:string;content:string;createdAt:string};
type WidgetNote={authorName:string;note:string;createdAt:string};

function WebChatInbox({notify}:{notify:(s:string)=>void}){
  const token=useAuthToken();
  const [conversations,setConversations]=useState<WidgetConversationSummary[]>([]);
  const [selectedSessionId,setSelectedSessionId]=useState("");
  const [messages,setMessages]=useState<WidgetMessage[]>([]);
  const [aiActive,setAiActiveState]=useState(true);
  const [loading,setLoading]=useState(true);
  const [loadingMessages,setLoadingMessages]=useState(false);
  const [reply,setReply]=useState("");
  const [sendingReply,setSendingReply]=useState(false);
  const [notes,setNotes]=useState<WidgetNote[]>([]);
  const [noteDraft,setNoteDraft]=useState("");
  const [savingNote,setSavingNote]=useState(false);
  const [lead,setLead]=useState<Submission|null>(null);
  const [handoffSummary,setHandoffSummary]=useState<{summary:string;focusOn:string;customerNotes:string}|null>(null);
  const lastTypingPingRef=useRef(0);
  const pingTyping=()=>{
    if(!selectedSessionId||!token)return;
    const now=Date.now();
    if(now-lastTypingPingRef.current<3000)return;
    lastTypingPingRef.current=now;
    fetch(metaApi("/api/widget/typing"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({sessionId:selectedSessionId})}).catch(()=>{});
  };
  const load=async(silent?:boolean)=>{
    if(!token){setLoading(false);return}
    if(!silent)setLoading(true);
    try{
      const response=await fetch(metaApi("/api/widget/conversations"),{headers:authHeaders(token)});
      const result=await response.json() as {conversations?:WidgetConversationSummary[];error?:string};
      if(!response.ok)throw new Error(result.error||"Could not load web chat conversations.");
      setConversations(result.conversations||[]);
    }catch(error){if(!silent)notify(error instanceof Error?error.message:"Could not load web chat conversations.")}
    finally{if(!silent)setLoading(false)}
  };
  useEffect(()=>{load()},[token]);
  const loadMessages=(silent?:boolean)=>{
    if(!selectedSessionId||!token){setMessages([]);return}
    if(!silent)setLoadingMessages(true);
    fetch(metaApi(`/api/widget/messages?sessionId=${encodeURIComponent(selectedSessionId)}`),{headers:authHeaders(token)})
      .then(r=>r.json())
      .then((data:{messages?:WidgetMessage[];aiActive?:boolean;handoffSummary?:{summary:string;focusOn:string;customerNotes:string}|null})=>{setMessages(data.messages||[]);setAiActiveState(data.aiActive??true);setHandoffSummary(data.handoffSummary||null)})
      .catch(()=>{if(!silent)notify("Could not load that conversation.")})
      .finally(()=>{if(!silent)setLoadingMessages(false)});
  };
  useEffect(()=>loadMessages(),[selectedSessionId,token]);
  const loadNotes=()=>{
    if(!selectedSessionId||!token){setNotes([]);return}
    fetch(metaApi(`/api/widget/notes?sessionId=${encodeURIComponent(selectedSessionId)}`),{headers:authHeaders(token)})
      .then(r=>r.json())
      .then((data:{notes?:WidgetNote[]})=>setNotes(data.notes||[]))
      .catch(()=>{});
  };
  useEffect(()=>loadNotes(),[selectedSessionId,token]);
  const loadLead=()=>{
    if(!selectedSessionId||!token){setLead(null);return}
    fetch(metaApi(`/api/leads?sessionId=${encodeURIComponent(selectedSessionId)}`),{headers:authHeaders(token)})
      .then(r=>r.json())
      .then((data:{submissions?:Submission[]})=>setLead((data.submissions||[])[0]||null))
      .catch(()=>{});
  };
  useEffect(()=>loadLead(),[selectedSessionId,token]);
  const updateLeadTag=async(field:"source"|"status"|"priority"|"segment",value:string)=>{
    if(!lead)return;
    const previous=lead;
    setLead({...lead,[field]:value});
    try{
      const response=await fetch(metaApi(`/api/leads/${lead.id}`),{method:"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({[field]:value})});
      if(!response.ok)throw new Error();
      if(field==="status")setConversations(current=>current.map(c=>c.sessionId===selectedSessionId?{...c,leadStatus:value}:c));
    }catch{setLead(previous);notify(`Could not update ${field}.`)}
  };
  const addNote=async()=>{
    if(!noteDraft.trim()||!selectedSessionId||savingNote)return;
    setSavingNote(true);
    try{
      const response=await fetch(metaApi("/api/widget/notes"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({sessionId:selectedSessionId,note:noteDraft.trim()})});
      if(!response.ok)throw new Error();
      setNoteDraft("");
      loadNotes();
    }catch{notify("Could not save that note.")}
    finally{setSavingNote(false)}
  };
  // Poll for new visitor/agent messages and new conversations while this page is open,
  // so replies show up automatically instead of needing a manual refresh.
  useEffect(()=>{
    if(!token)return;
    const interval=window.setInterval(()=>{
      load(true);
      loadMessages(true);
    },4000);
    return()=>window.clearInterval(interval);
  },[token,selectedSessionId]);
  const selected=conversations.find(c=>c.sessionId===selectedSessionId);
  const toggleTakeover=async()=>{
    if(!selectedSessionId)return;
    const nextActive=!aiActive;
    try{
      const response=await fetch(metaApi("/api/widget/takeover"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({sessionId:selectedSessionId,active:nextActive})});
      if(!response.ok)throw new Error();
      setAiActiveState(nextActive);
      setConversations(current=>current.map(c=>c.sessionId===selectedSessionId?{...c,aiActive:nextActive}:c));
      notify(nextActive?"Handed this conversation back to the AI":"You've taken over this conversation — the AI will stay quiet");
    }catch{notify("Could not change who's handling this conversation.")}
  };
  const sendReply=async()=>{
    if(!reply.trim()||!selectedSessionId||sendingReply)return;
    setSendingReply(true);
    try{
      const response=await fetch(metaApi("/api/widget/reply"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({sessionId:selectedSessionId,message:reply.trim()})});
      if(!response.ok)throw new Error();
      setReply("");
      loadMessages();
    }catch{notify("Could not send that reply.")}
    finally{setSendingReply(false)}
  };
  return <><PageHeader title="Web chat conversations" description="Real visitor conversations from your website chat widget. Take over any conversation to reply as a human instead of the AI." action={<button className="secondary-btn" onClick={()=>load()}>↻ Refresh</button>}/>
  {loading?<p className="empty-hint">Loading…</p>:!conversations.length?<div className="empty-state"><span>◌</span><h3>No web chat conversations yet</h3><p>When a visitor uses your website's chat widget, the conversation will appear here automatically.</p></div>:
  <div className="full-inbox"><aside className="inbox-list"><div className="inbox-tools"><strong>{conversations.length} conversation{conversations.length===1?"":"s"}</strong></div><div className="conversation-list">{conversations.map(c=><button key={c.sessionId} className={c.sessionId===selectedSessionId?"selected":""} onClick={()=>setSelectedSessionId(c.sessionId)}><span className="contact-avatar blue">◌<i/></span><div><strong>{c.customerName||"Website visitor"}{c.leadStatus==="New"&&<span className="new-badge">New</span>}{c.needsAttention&&<span className="attention-badge">Needs you</span>}</strong><small>{c.lastMessage.slice(0,60)}</small></div><span className="conv-meta"><small>{new Date(c.lastAt).toLocaleString()}</small>{!c.aiActive&&<b>You</b>}</span></button>)}</div></aside><section className="chat-panel">{selected?<><div className="chat-head"><div className="chat-person"><span className="contact-avatar blue">◌<i/></span><div><strong>{selected.customerName||"Website visitor"}</strong><small>{selected.needsAttention?`Needs you — ${selected.attentionReason||"asked for a human"}`:`${selected.messageCount} messages`}</small></div></div><div className="ai-state"><span className={aiActive?"pulse":"pulse off"}>✦</span><div><strong>{aiActive?"AI is handling":"You're handling"}</strong><small>{aiActive?"Take over to reply yourself":"AI is paused for this visitor"}</small></div><button onClick={toggleTakeover}>{aiActive?"Take over":"Hand to AI"}</button></div></div><div className="chat-body tall"><div className="today">{new Date(selected.firstAt).toLocaleDateString()}</div>{loadingMessages?<p className="empty-hint">Loading…</p>:messages.map((m,i)=>m.role==="system"?<div key={i} className="today">{m.content}</div>:<div key={i} className={`message ${m.role==="user"?"customer":"ai"}`}><p>{m.content}</p><small>{m.role==="user"?"Visitor":m.role==="agent"?"You":"✦ Assistant"} • {new Date(m.createdAt).toLocaleTimeString()}</small></div>)}</div>{!aiActive&&<div className="composer"><div className="input-row"><input value={reply} onChange={e=>{setReply(e.target.value);pingTyping()}} onKeyDown={e=>e.key==="Enter"&&sendReply()} placeholder="Reply as yourself…" disabled={sendingReply}/><button className="send" disabled={sendingReply||!reply.trim()} onClick={sendReply}>➤</button></div></div>}</>:<div className="live-chat-placeholder">Select a conversation</div>}</section>{selected&&<aside className="notes-panel">{!aiActive&&handoffSummary&&<div className="handoff-summary"><h3>Handoff summary</h3><p><strong>What's happened:</strong> {handoffSummary.summary||"—"}</p><p><strong>Focus on:</strong> {handoffSummary.focusOn||"—"}</p>{handoffSummary.customerNotes&&<p><strong>Keep in mind:</strong> {handoffSummary.customerNotes}</p>}</div>}<h3>Lead details</h3>{!lead?<p className="empty-hint">No lead captured yet for this conversation.</p>:<>{Object.keys(lead.data).length>0&&<div className="lead-panel-data">{Object.entries(lead.data).map(([k,v])=><div key={k}><small>{k}:</small> {String(v)}</div>)}</div>}<div className="lead-panel-tags"><label>Source<select value={lead.source} onChange={e=>updateLeadTag("source",e.target.value)}><option value="">—</option>{LEAD_SOURCES.map(o=><option key={o}>{o}</option>)}</select></label><label>Status<select className={`status-select status-${lead.status.toLowerCase().replace(/[^a-z]/g,"-")}`} value={lead.status} onChange={e=>updateLeadTag("status",e.target.value)}>{LEAD_STATUSES.map(o=><option key={o}>{o}</option>)}</select></label><label>Priority<select className={`priority-select priority-${lead.priority.toLowerCase()}`} value={lead.priority} onChange={e=>updateLeadTag("priority",e.target.value)}><option value="">—</option>{LEAD_PRIORITIES.map(o=><option key={o}>{o}</option>)}</select></label><label>Segment<select value={lead.segment} onChange={e=>updateLeadTag("segment",e.target.value)}><option value="">—</option>{LEAD_SEGMENTS.map(o=><option key={o}>{o}</option>)}</select></label></div></>}<h3 className="notes-heading">Internal notes</h3><small>Only your team can see these — the visitor never does.</small><div className="notes-list">{!notes.length?<p className="empty-hint">No notes yet</p>:notes.map((n,i)=><div key={i} className="note"><p>{n.note}</p><small>{n.authorName} • {new Date(n.createdAt).toLocaleString()}</small></div>)}</div><div className="note-composer"><textarea value={noteDraft} onChange={e=>setNoteDraft(e.target.value)} placeholder="Add a note for your team…" disabled={savingNote}/><button className="secondary-btn" disabled={savingNote||!noteDraft.trim()} onClick={addNote}>{savingNote?"Saving…":"Add note"}</button></div></aside>}</div>}
  </>;
}

// Lightweight, decoupled from LiveInbox's own polling — just enough to know how many real
// WhatsApp conversations exist and what they look like, for the "All" tab and tab visibility.
function useWhatsappSummaries(connected:boolean,token:string|null):{summaries:{waId:string;lastText:string;lastAt:number;lastDirection:string}[];loaded:boolean}{
  const [summaries,setSummaries]=useState<{waId:string;lastText:string;lastAt:number;lastDirection:string}[]>([]);
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    if(!connected||!token){setSummaries([]);setLoaded(true);return}
    let cancelled=false;
    const load=async()=>{
      try{
        const response=await fetch(metaApi("/api/meta/inbox"),{headers:authHeaders(token)});
        const result=await response.json() as {messages?:LiveWhatsAppMessage[]};
        if(cancelled)return;
        const byId=new Map<string,{waId:string;lastText:string;lastAt:number;lastDirection:string}>();
        for(const m of result.messages||[]){
          if(!m.waId||!m.text)continue;
          const at=Number(m.timestamp||0)*1000||new Date(m.createdAt).getTime();
          const existing=byId.get(m.waId);
          if(!existing||at>=existing.lastAt)byId.set(m.waId,{waId:m.waId,lastText:m.text,lastAt:at||Date.now(),lastDirection:m.direction});
        }
        setSummaries([...byId.values()]);
      }catch{/* keep previous summaries on a transient failure */}
      finally{if(!cancelled)setLoaded(true)}
    };
    load();
    const timer=window.setInterval(load,8000);
    return()=>{cancelled=true;window.clearInterval(timer)};
  },[connected,token]);
  return {summaries,loaded};
}

function useWebchatSummaries(token:string|null):{summaries:WidgetConversationSummary[];loaded:boolean}{
  const [summaries,setSummaries]=useState<WidgetConversationSummary[]>([]);
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    if(!token){setSummaries([]);setLoaded(true);return}
    let cancelled=false;
    const load=async()=>{
      try{
        const response=await fetch(metaApi("/api/widget/conversations"),{headers:authHeaders(token)});
        const result=await response.json() as {conversations?:WidgetConversationSummary[]};
        if(!cancelled)setSummaries(result.conversations||[]);
      }catch{/* keep previous summaries on a transient failure */}
      finally{if(!cancelled)setLoaded(true)}
    };
    load();
    const timer=window.setInterval(load,4000);
    return()=>{cancelled=true;window.clearInterval(timer)};
  },[token]);
  return {summaries,loaded};
}

type InboxChannelKey="all"|"whatsapp"|"instagram"|"webchat";

function InboxHub(props:{connected:boolean;conversations:Conversation[];setConversations:(v:Conversation[])=>void;selected:Conversation;setSelectedId:(s:string)=>void;messages:Message[];draft:string;setDraft:(s:string)=>void;sendMessage:()=>void;aiActive:boolean;setAiActive:(v:boolean)=>void;onConnect:()=>void;notify:(s:string)=>void}){
  const token=useAuthToken();
  const {summaries:waSummaries,loaded:waLoaded}=useWhatsappSummaries(props.connected,token);
  const {summaries:webSummaries,loaded:webLoaded}=useWebchatSummaries(token);
  const ready=waLoaded&&webLoaded;
  const waCount=props.connected?waSummaries.length:props.conversations.length;
  const webCount=webSummaries.length;
  // Instagram messaging isn't wired to any real backend yet (see HANDOFF.md) — it stays at
  // zero, which naturally keeps its tab hidden until that's built, rather than faking data.
  const igCount=0;
  const channels:{key:InboxChannelKey;label:string;count:number}[]=[
    {key:"whatsapp",label:"◉ WhatsApp",count:waCount},
    {key:"instagram",label:"◎ Instagram",count:igCount},
    {key:"webchat",label:"◌ Web chat",count:webCount},
  ];
  const activeChannels=channels.filter(c=>c.count>0);
  const showAll=activeChannels.length>=2;
  const visibleTabs:{key:InboxChannelKey;label:string}[]=showAll
    ?[{key:"all",label:"◆ All"},...activeChannels]
    :(activeChannels.length?activeChannels:channels);
  const visibleKeys=visibleTabs.map(t=>t.key).join(",");
  const [tab,setTab]=useState<InboxChannelKey>("whatsapp");
  useEffect(()=>{
    if(!ready)return;
    const keys=visibleKeys.split(",") as InboxChannelKey[];
    if(!keys.includes(tab))setTab(keys[0]);
  },[visibleKeys,ready]);

  const merged=[
    ...waSummaries.map(s=>({channel:"whatsapp" as const,key:"wa:"+s.waId,name:"+"+s.waId,preview:s.lastText,at:s.lastAt})),
    ...webSummaries.map(s=>({channel:"webchat" as const,key:"web:"+s.sessionId,name:s.customerName||"Website visitor",preview:s.lastMessage.slice(0,60),at:new Date(s.lastAt).getTime()})),
  ].sort((a,b)=>b.at-a.at);

  if(!ready)return<><PageHeader title="Inbox" description="Manage every customer conversation from one place."/><p className="empty-hint">Loading…</p></>;

  return <>
    <div className="test-mode-tabs">{visibleTabs.map(t=><button key={t.key} className={tab===t.key?"active":""} onClick={()=>setTab(t.key)}>{t.label}</button>)}</div>
    {tab==="all"&&<>
      <PageHeader title="All conversations" description="Every channel with an active conversation, in one place."/>
      <div className="conversation-list all-conversation-list">{merged.map(item=><button key={item.key} onClick={()=>setTab(item.channel)}><span className={`contact-avatar ${item.channel==="whatsapp"?"green":"blue"}`}>{item.channel==="whatsapp"?"WA":"◌"}<i/></span><div><strong>{item.name}</strong><small>{item.preview}</small></div><span className="conv-meta"><small>{new Date(item.at).toLocaleString()}</small><em>{item.channel==="whatsapp"?"WhatsApp":"Web chat"}</em></span></button>)}</div>
    </>}
    {tab==="whatsapp"&&(props.connected?<LiveInbox notify={props.notify}/>:props.conversations.length?<Inbox conversations={props.conversations} setConversations={props.setConversations} selected={props.selected} setSelectedId={props.setSelectedId} messages={props.messages} draft={props.draft} setDraft={props.setDraft} sendMessage={props.sendMessage} aiActive={props.aiActive} setAiActive={props.setAiActive} notify={props.notify}/>:<EmptyInbox onConnect={props.onConnect}/>)}
    {tab==="instagram"&&<div className="empty-state"><span>◎</span><h3>No Instagram conversations yet</h3><p>Real Instagram messaging isn't connected yet — this tab will fill in once that channel is wired up.</p></div>}
    {tab==="webchat"&&<WebChatInbox notify={props.notify}/>}
  </>;
}

function Inbox({conversations,setConversations,selected,setSelectedId,messages,draft,setDraft,sendMessage,aiActive,setAiActive,notify}:{conversations:Conversation[];setConversations:(v:Conversation[])=>void;selected:Conversation;setSelectedId:(s:string)=>void;messages:Message[];draft:string;setDraft:(s:string)=>void;sendMessage:()=>void;aiActive:boolean;setAiActive:(v:boolean)=>void;notify:(s:string)=>void}){
  const [query,setQuery]=useState(""); const [filter,setFilter]=useState("All");
  const visible=conversations.filter(c=>(filter==="All"||c.status===filter.toLowerCase())&&`${c.name} ${c.preview}`.toLowerCase().includes(query.toLowerCase()));
  const resolve=()=>{setConversations(conversations.map(c=>c.id===selected.id?{...c,status:c.status==="open"?"resolved":"open"}:c));notify(selected.status==="open"?"Conversation resolved":"Conversation reopened")};
  const addNote=()=>{const note=window.prompt("Add an internal note for this customer");if(note?.trim()){setConversations(conversations.map(c=>c.id===selected.id?{...c,notes:[...(c.notes??[]),note.trim()]}:c));notify("Internal note saved")}};
  return <><PageHeader title="Unified inbox" description="Manage every customer conversation from one place." action={<div className="header-buttons"><button className="secondary-btn" onClick={()=>notify("Inbox refreshed")}>↻ Refresh</button><button className="primary" onClick={resolve}>{selected.status==="open"?"✓ Resolve":"Reopen"}</button></div>}/><div className="full-inbox"><aside className="inbox-list"><div className="inbox-tools"><input placeholder="Search conversations" value={query} onChange={e=>setQuery(e.target.value)}/><div>{["All","Open","Resolved"].map(x=><button className={filter===x?"active":""} onClick={()=>setFilter(x)} key={x}>{x}</button>)}</div></div><div className="conversation-list">{visible.map(c=><button key={c.id} className={selected.id===c.id?"selected":""} onClick={()=>setSelectedId(c.id)}><span className={`contact-avatar ${c.tone}`}>{c.initials}<i/></span><div><strong>{c.name}</strong><small>{c.preview}</small></div><span className="conv-meta"><small>{c.time}</small>{c.unread>0&&<b>{c.unread}</b>}</span></button>)}</div></aside><section className="chat-panel"><div className="chat-head"><div className="chat-person"><span className={`contact-avatar ${selected.tone}`}>{selected.initials}<i/></span><div><strong>{selected.name}</strong><small>WhatsApp • Online</small></div></div><div className="ai-state"><span className={aiActive?"pulse":"pulse off"}>✦</span><div><strong>{aiActive?"AI is handling":"You’re handling"}</strong><small>{aiActive?"Confident response":"Manual takeover"}</small></div><button onClick={()=>setAiActive(!aiActive)}>{aiActive?"Take over":"Hand to AI"}</button></div></div><div className="chat-body tall"><div className="today">Today</div>{messages.map((m,i)=><div key={i} className={`message ${m.from}`}><p>{m.text}</p><small>{m.from==="ai"&&"✦ AI • "}{m.from==="agent"&&"You • "}{m.time} {m.from!=="customer"&&"✓✓"}</small></div>)}</div><div className="composer"><div className="suggestion"><span>✦</span><p><strong>Suggested reply</strong> Ask if they need anything else</p><button onClick={()=>setDraft("Is there anything else I can help you with today?")}>Use</button></div><div className="input-row"><label className="attach-button" title="Attach file">＋<input type="file" onChange={e=>{const file=e.target.files?.[0];if(file){setDraft(`[Attachment: ${file.name}]`);notify("Attachment added")}}}/></label><input value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendMessage()} placeholder="Type a message…"/><button title="Add emoji" onClick={()=>setDraft(`${draft} 😊`)}>☺</button><button className="send" onClick={sendMessage}>➤</button></div></div></section><aside className="customer-panel"><span className={`contact-avatar large ${selected.tone}`}>{selected.initials}</span><h3>{selected.name}</h3><small>Customer since March 2026</small><div className="details-list"><label>Phone<strong>{selected.phone}</strong></label><label>Email<strong>{selected.email}</strong></label><label>Status<strong className="status-text">{selected.status}</strong></label><label>Tags<div>{selected.tags.map(t=><span key={t}>{t}</span>)}</div></label></div>{selected.notes?.length?<div className="customer-notes">{selected.notes.map((note,i)=><p key={i}>“{note}”</p>)}</div>:null}<button className="secondary-btn" onClick={addNote}>＋ Add internal note</button></aside></div></>;
}

function Campaigns({notify,onManageAudiences}:{notify:(s:string)=>void;onManageAudiences:()=>void}){
  const [campaigns,setCampaigns]=useStoredState("qpy-engage-campaigns",initialCampaigns);
  const [creating,setCreating]=useState(false);
  const [step,setStep]=useState(0);
  const [query,setQuery]=useState("");
  const [channelFilter,setChannelFilter]=useState("All channels");
  const [statusFilter,setStatusFilter]=useState("All statuses");
  const [editingId,setEditingId]=useState<number|null>(null);
  const token=useAuthToken();
  const [pricing,setPricing]=useState<Record<string,number>>({Marketing:0.05,Utility:0.02});
  const [balances,setBalances]=useState<Record<string,number>>({Marketing:0,Utility:0,Authentication:0,Service:0});
  const [sentCounts,setSentCounts]=useState<Record<string,number>>({Marketing:0,Utility:0,Authentication:0,Service:0});
  const [realAudiences,setRealAudiences]=useState<AudienceSummary[]>([]);
  const loadCreditsAndPricing=()=>{
    if(!token)return;
    fetch(metaApi("/api/pricing"),{headers:authHeaders(token)}).then(r=>r.json()).then((d:{pricing?:{category:string;priceUsd:number}[]})=>{
      if(d.pricing){const map:Record<string,number>={};d.pricing.forEach(p=>map[p.category]=p.priceUsd);setPricing(current=>({...current,...map}))}
    }).catch(()=>{});
    fetch(metaApi("/api/credits"),{headers:authHeaders(token)}).then(r=>r.json()).then((d:{balances?:Record<string,number>;sent?:Record<string,number>})=>{if(d.balances)setBalances(d.balances);if(d.sent)setSentCounts(d.sent)}).catch(()=>{});
    fetch(metaApi("/api/audiences"),{headers:authHeaders(token)}).then(r=>r.json()).then((d:{audiences?:AudienceSummary[]})=>{if(d.audiences)setRealAudiences(d.audiences)}).catch(()=>{});
  };
  useEffect(loadCreditsAndPricing,[token]);
  const emptyForm=()=>({name:"",channel:"WhatsApp" as "WhatsApp"|"Instagram",objective:"Promote products",audience:"",audienceId:"",message:"Hi {{first_name}} 👋\n\nDiscover Atelier Home’s newest collection, created for effortless summer living. Shop now and enjoy complimentary UAE delivery.",mediaUrl:"",mediaName:"",cta:"Shop collection",url:"https://atelierhome.com/collections/summer",templateName:"",templateLanguage:"en_US",scheduleType:"Now",date:"2026-07-19",time:"10:00",recurrence:"One-time",excludeRecent:false,messageCategory:"Marketing" as "Marketing"|"Utility"});
  const [form,setForm]=useState(emptyForm());
  const selectedAudience=realAudiences.find(a=>a.id===form.audienceId)||null;
  const baseRecipients=selectedAudience?selectedAudience.consentedCount:0;
  const recipients=Math.round(baseRecipients*(form.excludeRecent?0.92:1));
  const estimatedCost=Math.round(recipients*(pricing[form.messageCategory]||0)*100)/100;
  const reset=()=>{setEditingId(null);setCreating(true);setStep(0);setForm(emptyForm())};
  const edit=(campaign:Campaign)=>{const defaults=emptyForm();setEditingId(campaign.id);setCreating(true);setStep(0);setForm({name:campaign.name,channel:campaign.channel,objective:campaign.objective||defaults.objective,audience:campaign.audience,audienceId:campaign.audienceId||"",message:campaign.message||defaults.message,mediaUrl:campaign.mediaUrl||"",mediaName:campaign.mediaName||"",cta:campaign.cta||defaults.cta,url:campaign.url||defaults.url,templateName:campaign.templateName||"",templateLanguage:campaign.templateLanguage||defaults.templateLanguage,scheduleType:campaign.scheduleType||defaults.scheduleType,date:campaign.date||defaults.date,time:campaign.time||defaults.time,recurrence:campaign.recurrence||defaults.recurrence,excludeRecent:Boolean(campaign.excludeRecent),messageCategory:campaign.messageCategory||defaults.messageCategory})};
  const uploadCampaignImage=(file?:File)=>{if(!file)return;if(!["image/jpeg","image/png","image/webp"].includes(file.type)){notify("Choose a JPG, PNG, or WebP image");return}if(file.size>5*1024*1024){notify("Image must be smaller than 5 MB");return}const reader=new FileReader();reader.onload=()=>{setForm(current=>({...current,mediaUrl:String(reader.result||""),mediaName:file.name}));notify("Campaign image added")};reader.readAsDataURL(file)};
  const sendTest=()=>notify("Test message sent to your own WhatsApp/Instagram account");
  const buildCampaign=(status:"Sent"|"Scheduled"|"Draft",sendResult?:{sent:number;total:number;deliveredPercent:number;errors?:string[]}):Campaign=>({id:editingId??Date.now(),name:form.name||"Untitled campaign",channel:form.channel,audience:form.audience,audienceId:form.audienceId,recipients:sendResult?sendResult.total:recipients,status,schedule:status==="Sent"?"Sent just now":status==="Draft"?"Not scheduled":`${form.date}, ${form.time}${form.recurrence!=="One-time"?` • ${form.recurrence}`:""}`,delivered:sendResult?`${sendResult.deliveredPercent}%`:status==="Sent"?"Sending…":"—",clicks:"—",objective:form.objective,message:form.message,mediaUrl:form.mediaUrl,mediaName:form.mediaName,cta:form.cta,url:form.url,templateName:form.templateName,templateLanguage:form.templateLanguage,scheduleType:form.scheduleType,date:form.date,time:form.time,recurrence:form.recurrence,excludeRecent:form.excludeRecent,messageCategory:form.messageCategory,estimatedCost,sendErrors:sendResult?.errors});
  const hasEnoughBalance=recipients<=(balances[form.messageCategory]||0);
  const [launching,setLaunching]=useState(false);
  const launch=async(status:"Sent"|"Scheduled")=>{
    if(status==="Sent"&&form.channel==="WhatsApp"&&token){
      setLaunching(true);
      try{
        const response=await fetch(metaApi("/api/campaigns/send"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({audienceId:form.audienceId,templateName:form.templateName,templateLanguage:form.templateLanguage,messageCategory:form.messageCategory})});
        const result=await response.json() as {sent?:number;failed?:number;total?:number;deliveredPercent?:number;errors?:string[];balances?:Record<string,number>;error?:string};
        if(!response.ok||result.sent===undefined)throw new Error(result.error||"Could not send this campaign.");
        if(result.balances)setBalances(result.balances);
        const campaign=buildCampaign(status,{sent:result.sent,total:result.total||0,deliveredPercent:result.deliveredPercent||0,errors:result.errors});
        setCampaigns(editingId?campaigns.map(c=>c.id===editingId?campaign:c):[campaign,...campaigns]);
        setCreating(false);setEditingId(null);setLaunching(false);
        notify(`Sent to ${result.sent} of ${result.total} recipients${result.failed?` • ${result.failed} failed`:""}`);
      }catch(err){setLaunching(false);notify(err instanceof Error?err.message:"Could not send this campaign.")}
      return;
    }
    if(status==="Sent"&&token){
      setLaunching(true);
      try{
        const response=await fetch(metaApi("/api/credits/deduct"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({category:form.messageCategory,messages:recipients})});
        const result=await response.json() as {balances?:Record<string,number>;error?:string};
        if(!response.ok||!result.balances)throw new Error(result.error||"Not enough message credits for this send.");
        setBalances(result.balances);
      }catch(err){setLaunching(false);notify(err instanceof Error?err.message:"Not enough message credits for this send.");return}
      setLaunching(false);
    }
    const campaign=buildCampaign(status);
    setCampaigns(editingId?campaigns.map(c=>c.id===editingId?campaign:c):[campaign,...campaigns]);
    setCreating(false);setEditingId(null);
    notify(status==="Sent"?"Campaign is sending (simulated — Instagram sending isn't connected to a real API yet)":"Campaign scheduled");
  };
  const saveExit=()=>{if(!form.name.trim()){setCreating(false);setEditingId(null);return}const campaign=buildCampaign("Draft");setCampaigns(editingId?campaigns.map(c=>c.id===editingId?campaign:c):[campaign,...campaigns]);setCreating(false);setEditingId(null);notify("Draft saved")};
  const duplicate=(campaign:Campaign)=>{const defaults=emptyForm();setCampaigns([{...campaign,objective:campaign.objective||defaults.objective,message:campaign.message||defaults.message,mediaUrl:campaign.mediaUrl||"",mediaName:campaign.mediaName||"",cta:campaign.cta||defaults.cta,url:campaign.url||defaults.url,templateName:campaign.templateName||"",templateLanguage:campaign.templateLanguage||defaults.templateLanguage,scheduleType:campaign.scheduleType||defaults.scheduleType,date:campaign.date||defaults.date,time:campaign.time||defaults.time,recurrence:campaign.recurrence||defaults.recurrence,excludeRecent:Boolean(campaign.excludeRecent),messageCategory:campaign.messageCategory||defaults.messageCategory,estimatedCost:campaign.estimatedCost||0,id:Date.now(),name:`${campaign.name} copy`,status:"Draft",schedule:"Not scheduled",delivered:"—",clicks:"—"},...campaigns]);notify("Campaign duplicated")};
  const remove=(id:number)=>{if(window.confirm("Delete this campaign?")){setCampaigns(campaigns.filter(c=>c.id!==id));notify("Campaign deleted")}};
  const visibleCampaigns=campaigns.filter(c=>c.name.toLowerCase().includes(query.toLowerCase())&&(channelFilter==="All channels"||c.channel===channelFilter)&&(statusFilter==="All statuses"||c.status===statusFilter));
  if(creating)return <><PageHeader eyebrow="Campaign builder" title={form.name||(editingId?"Edit campaign":"Create campaign")} description="Build a targeted broadcast for opted-in WhatsApp or Instagram customers." action={<button className="secondary-btn" onClick={saveExit}>Save & exit</button>}/><div className="campaign-builder"><div className="campaign-steps">{["Details","Audience","Message","Schedule","Review"].map((label,i)=><button key={label} className={i<step?"done":i===step?"active":""} onClick={()=>i<=step&&setStep(i)}><span>{i<step?"✓":i+1}</span><div><strong>{label}</strong><small>{i<step?"Complete":i===step?"In progress":"Not started"}</small></div></button>)}</div><section className="campaign-stage">
    {step===0&&<><WizardTitle n="01" title="Campaign details" text="Name the campaign and choose where the message will be delivered."/><div className="form-grid"><label>Campaign name<input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="e.g. Summer collection launch"/></label><label>Campaign objective<select value={form.objective} onChange={e=>setForm({...form,objective:e.target.value})}><option>Promote products</option><option>Announce an event</option><option>Recover customers</option><option>Share an update</option></select></label></div><div className="form-grid"><label>Message category<select value={form.messageCategory} onChange={e=>setForm({...form,messageCategory:e.target.value as "Marketing"|"Utility"})}><option value="Marketing">Marketing</option><option value="Utility">Utility</option></select><small>Meta bills these differently — Marketing for promotions, Utility for order/account updates.</small></label></div><div className="campaign-channel-choice">{[["WhatsApp","◉","Template or session broadcast","wa"],["Instagram","◎","Direct message campaign","ig"]].map(([name,icon,copy,tone])=><button key={name} className={form.channel===name?"selected":""} onClick={()=>setForm({...form,channel:name as "WhatsApp"|"Instagram"})}><span className={tone}>{icon}</span><div><strong>{name}</strong><small>{copy}</small></div><b>{form.channel===name?"✓":""}</b></button>)}</div><div className="wizard-actions"><span>Only customers with valid marketing consent can receive campaigns.</span><button className="primary" disabled={!form.name.trim()} onClick={()=>setStep(1)}>Choose audience →</button></div></>}
    {step===1&&<><WizardTitle n="02" title="Select an audience" text="Choose a real audience of consented contacts to send this campaign to."/><div className="audience-layout"><div className="audience-segments"><h3>Your audiences</h3>{!realAudiences.length&&<p className="empty-hint">No audiences yet.</p>}{realAudiences.map(a=><button key={a.id} className={form.audienceId===a.id?"selected":""} onClick={()=>setForm({...form,audienceId:a.id,audience:a.name})}><span>♟</span><div><strong>{a.name}</strong><small>{a.consentedCount.toLocaleString()} consented of {a.memberCount.toLocaleString()} total</small></div><b>{a.consentedCount.toLocaleString()}</b></button>)}</div><div className="audience-import"><span>♟</span><h3>Manage audiences</h3><p>Create audiences and add or import real contacts from the Audiences section.</p><button className="secondary-btn" onClick={onManageAudiences}>Go to Audiences →</button></div></div><label className="exclude-recent-toggle"><input type="checkbox" checked={form.excludeRecent} onChange={e=>setForm({...form,excludeRecent:e.target.checked})}/><div><strong>Exclude customers messaged in the last 24 hours</strong><small>Avoid double-messaging people already contacted by another campaign or automation</small></div></label><div className="audience-total"><span>Estimated audience</span><strong>{recipients.toLocaleString()}</strong><small>eligible (consented) recipients</small></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(0)}>Back</button><button className="primary" disabled={!recipients} onClick={()=>setStep(2)}>Compose message →</button></div></>}
    {step===2&&<><WizardTitle n="03" title="Compose your message" text={`Create the ${form.channel} message your selected audience will receive.`}/><div className="composer-layout"><div className="campaign-compose"><div className="campaign-media"><div><strong>Header image</strong><small>JPG, PNG, or WebP • maximum 5 MB</small></div>{form.mediaUrl?<div className="campaign-media-ready"><img src={form.mediaUrl} alt="Campaign attachment preview"/><div><strong>{form.mediaName}</strong><small>Ready to send</small></div><button onClick={()=>setForm({...form,mediaUrl:"",mediaName:""})}>Remove</button></div>:<label className="campaign-image-upload">＋ Add image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>uploadCampaignImage(e.target.files?.[0])}/></label>}</div><label>Message<textarea value={form.message} onChange={e=>setForm({...form,message:e.target.value})}/><small>{form.message.length}/1024 characters</small></label><div className="variable-buttons"><span>Personalize:</span>{["{{first_name}}","{{company}}","{{city}}"].map(v=><button key={v} onClick={()=>setForm({...form,message:`${form.message} ${v}`})}>{v}</button>)}</div><div className="form-grid"><label>Button text<input value={form.cta} onChange={e=>setForm({...form,cta:e.target.value})}/></label><label>Destination URL<input value={form.url} onChange={e=>setForm({...form,url:e.target.value})}/></label></div>{form.channel==="WhatsApp"&&<div className="form-grid"><label>Meta template name<input value={form.templateName} onChange={e=>setForm({...form,templateName:e.target.value})} placeholder="e.g. summer_launch_promo"/><small>Must exactly match a template already approved in Meta Business Manager.</small></label><label>Template language code<input value={form.templateLanguage} onChange={e=>setForm({...form,templateLanguage:e.target.value})} placeholder="en_US"/></label></div>}<div className="template-note">ⓘ {form.channel==="WhatsApp"?"Sending immediately calls the real WhatsApp Cloud API using the template above — component/variable substitution isn't supported yet, so the template must work with no parameters. The message text below is used only for the preview and for Instagram/Scheduled sends.":"WhatsApp campaigns outside the 24-hour service window require an approved Meta message template."}</div><button className="secondary-btn" disabled={!form.message.trim()} onClick={sendTest}>▶ Send test to myself</button></div><div className={`campaign-preview ${form.channel.toLowerCase()}`}><div className="preview-phone"><div className="preview-head"><span>{form.channel==="WhatsApp"?"WA":"IG"}</span><div><strong>Atelier Home</strong><small>{form.channel} business</small></div></div><div className={`preview-body ${form.mediaUrl?"with-media":""}`}>{form.mediaUrl&&<img className="campaign-preview-image" src={form.mediaUrl} alt="Campaign message attachment"/>}<div>{form.message.replace("{{first_name}}","Aisha")}</div><span className="preview-cta">{form.cta||"Learn more"}</span><small>10:24 ✓✓</small></div></div></div></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(1)}>Back</button><button className="primary" disabled={!form.message.trim()} onClick={()=>setStep(3)}>Set delivery →</button></div></>}
    {step===3&&<><WizardTitle n="04" title="Choose delivery time" text="Send immediately or schedule for the best time in your audience’s time zone."/><div className="schedule-options">{[["Now","Send immediately","Start sending as soon as the campaign is launched."],["Schedule","Choose date and time","Qpy Engage will queue the campaign for your selected time."],["Optimized","Best time per contact","Deliver when each customer is most likely to engage."]].map(([value,title,copy])=><label className={form.scheduleType===value?"selected":""} key={value}><input type="radio" name="schedule" checked={form.scheduleType===value} onChange={()=>setForm({...form,scheduleType:value})}/><span>{value==="Now"?"➤":value==="Schedule"?"◷":"✦"}</span><div><strong>{title}</strong><small>{copy}</small></div></label>)}</div>{form.scheduleType==="Schedule"&&<div className="schedule-fields"><label>Delivery date<input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></label><label>Delivery time<input type="time" value={form.time} onChange={e=>setForm({...form,time:e.target.value})}/></label><label>Time zone<select><option>Asia/Dubai (GST)</option><option>Recipient local time</option></select></label></div>}<label className="full-label">Repeat<select value={form.recurrence} onChange={e=>setForm({...form,recurrence:e.target.value})}><option>One-time</option><option>Daily</option><option>Weekly</option><option>Monthly</option></select><small>Recurring campaigns resend to the same audience on this schedule until paused.</small></label><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(2)}>Back</button><button className="primary" onClick={()=>setStep(4)}>Review campaign →</button></div></>}
    {step===4&&<><WizardTitle n="05" title="Review and launch" text="Confirm the channel, audience, message, and delivery settings."/><div className="campaign-review"><div><span>◈</span><label>Campaign<strong>{form.name}</strong><small>{form.objective}</small></label><button onClick={()=>setStep(0)}>Edit</button></div><div><span>♙</span><label>Audience<strong>{form.audience}</strong><small>{recipients.toLocaleString()} opted-in recipients</small></label><button onClick={()=>setStep(1)}>Edit</button></div><div><span>{form.channel==="WhatsApp"?"◉":"◎"}</span><label>Channel<strong>{form.channel}</strong><small>{form.mediaName?`Image: ${form.mediaName} • `:""}{form.message.slice(0,72)}…</small></label><button onClick={()=>setStep(2)}>Edit</button></div><div><span>◷</span><label>Delivery<strong>{form.scheduleType==="Now"?"Send immediately":form.scheduleType==="Schedule"?`${form.date} at ${form.time}`:"Optimized delivery"}{form.recurrence!=="One-time"?` • Repeats ${form.recurrence.toLowerCase()}`:""}</strong><small>Asia/Dubai time zone{form.excludeRecent?" • excluding recently-messaged customers":""}</small></label><button onClick={()=>setStep(3)}>Edit</button></div><div><span>◈</span><label>Message credits needed<strong>{form.messageCategory} • {recipients.toLocaleString()} messages</strong><small>You have {(balances[form.messageCategory]||0).toLocaleString()} {form.messageCategory} credits available (est. value ${estimatedCost.toFixed(2)} at ${(pricing[form.messageCategory]||0).toFixed(3)}/message)</small></label><button onClick={()=>setStep(0)}>Edit</button></div></div>{form.scheduleType==="Now"&&!hasEnoughBalance&&<div className="meta-error">⚠ Not enough {form.messageCategory} message credits — you need {recipients.toLocaleString()} but have {(balances[form.messageCategory]||0).toLocaleString()}. Buy more in Settings → Credits.</div>}{form.scheduleType==="Now"&&form.channel==="WhatsApp"&&!form.templateName.trim()&&<div className="meta-error">⚠ Enter the Meta-approved template name on the Message step to send for real.</div>}{form.scheduleType==="Now"&&form.channel==="WhatsApp"&&!form.audienceId&&<div className="meta-error">⚠ Select a real audience on the Audience step.</div>}<div className="compliance-check"><span>✓</span><div><strong>Audience and message compliance</strong><p>By launching, you confirm these recipients have consented to marketing and that this message follows Meta’s commerce and messaging policies.</p></div></div><div className="wizard-actions"><button className="secondary-btn" onClick={()=>setStep(3)}>Back</button><button className="primary" disabled={launching||(form.scheduleType==="Now"&&!hasEnoughBalance)||(form.scheduleType==="Now"&&form.channel==="WhatsApp"&&(!form.templateName.trim()||!form.audienceId))} onClick={()=>launch(form.scheduleType==="Now"?"Sent":"Scheduled")}>{launching?"Sending…":form.scheduleType==="Now"?`Send to ${recipients.toLocaleString()} recipients`:"Schedule campaign"}</button></div></>}
  </section></div></>;
  return <><PageHeader title="Campaigns" description="Create targeted broadcasts across WhatsApp and Instagram." action={<button className="primary" onClick={reset}>＋ Create campaign</button>}/><div className="campaign-metrics">{[["◈","Total campaigns",campaigns.length.toString()],["➤","Messages sent",campaigns.filter(c=>c.status==="Sent").reduce((n,c)=>n+c.recipients,0).toLocaleString()],["✓","Avg. delivery","97.2%"],["↗","Avg. click rate","16.8%"]].map(([icon,label,value])=><article key={label}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></article>)}</div>
    <div className="category-spend-card"><div><span>◈</span><div><strong>Marketing messages sent</strong><small>{(balances.Marketing||0).toLocaleString()} credits remaining</small></div></div><strong>{(sentCounts.Marketing||0).toLocaleString()}</strong></div>
    <div className="category-spend-card"><div><span>⚑</span><div><strong>Utility messages sent</strong><small>{(balances.Utility||0).toLocaleString()} credits remaining</small></div></div><strong>{(sentCounts.Utility||0).toLocaleString()}</strong></div>
    <div className="toolbar"><input placeholder="Search campaigns" value={query} onChange={e=>setQuery(e.target.value)}/><select value={channelFilter} onChange={e=>setChannelFilter(e.target.value)}><option>All channels</option><option>WhatsApp</option><option>Instagram</option></select><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option>All statuses</option><option>Draft</option><option>Scheduled</option><option>Sent</option></select></div><div className="data-card campaign-table"><table><thead><tr><th>Campaign</th><th>Channel</th><th>Category</th><th>Audience</th><th>Recipients</th><th>Est. cost</th><th>Delivery</th><th>Clicks</th><th>Status</th><th/></tr></thead><tbody>{visibleCampaigns.map(c=><tr key={c.id}><td><div className="table-title"><span>◈</span><div><strong>{c.name}</strong><small>{c.schedule}</small></div></div></td><td><span className={`channel-badge ${c.channel.toLowerCase()}`}>{c.channel==="WhatsApp"?"◉":"◎"} {c.channel}</span></td><td><span className={`category-badge ${(c.messageCategory||"Marketing").toLowerCase()}`}>{c.messageCategory||"Marketing"}</span></td><td>{c.audience}</td><td>{c.recipients.toLocaleString()}</td><td>${(c.estimatedCost||0).toFixed(2)}</td><td>{c.delivered}</td><td>{c.clicks}</td><td><b className={`campaign-status ${c.status.toLowerCase()}`}>{c.status}</b></td><td><div className="row-actions">{c.status!=="Sent"&&<button title="Edit" onClick={()=>edit(c)}>✎</button>}<button title="Duplicate" onClick={()=>duplicate(c)}>⧉</button><button title="Delete" onClick={()=>remove(c.id)}>×</button></div></td></tr>)}</tbody></table>{!visibleCampaigns.length&&<div className="empty-row">No campaigns match these filters.</div>}</div><div className="campaign-tip"><span>✦</span><div><strong>Reach the right customers</strong><p>Create reusable segments from customer tags, locations, purchases, and engagement—or import a consented CSV audience.</p></div><button className="secondary-btn" onClick={reset}>Build a campaign</button></div></>;
}

type Contact={id:string;name:string;phone:string;consent:boolean;tags:string[];createdAt:string;updatedAt:string};
type AudienceSummary={id:string;name:string;createdAt:string;memberCount:number;consentedCount:number};

function Audiences({notify}:{notify:(s:string)=>void}){
  const token=useAuthToken();
  const [audiences,setAudiences]=useState<AudienceSummary[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [members,setMembers]=useState<Contact[]>([]);
  const [allContacts,setAllContacts]=useState<Contact[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [newContact,setNewContact]=useState({name:"",phone:"",consent:true,tags:""});
  const [csvText,setCsvText]=useState("");
  const [importing,setImporting]=useState(false);
  const [creatingAudience,setCreatingAudience]=useState(false);
  const [newAudienceName,setNewAudienceName]=useState("");
  const [showNewAudience,setShowNewAudience]=useState(false);
  const [renamingName,setRenamingName]=useState<string|null>(null);
  const [editingContactId,setEditingContactId]=useState<string|null>(null);
  const [editDraft,setEditDraft]=useState({name:"",phone:"",tags:""});

  const loadAudiences=async()=>{
    if(!token){setLoading(false);return}
    setLoading(true);setError("");
    try{
      const response=await fetch(metaApi("/api/audiences"),{headers:authHeaders(token)});
      const result=await response.json() as {audiences?:AudienceSummary[];error?:string};
      if(!response.ok)throw new Error(result.error||"Could not load audiences.");
      setAudiences(result.audiences||[]);
      if(!selectedId&&result.audiences?.length)setSelectedId(result.audiences[0].id);
    }catch(err){setError(err instanceof Error?err.message:"Could not load audiences.")}
    finally{setLoading(false)}
  };
  useEffect(()=>{loadAudiences()},[token]);

  const loadMembers=async(audienceId:string)=>{
    if(!token)return;
    try{
      const response=await fetch(metaApi(`/api/audiences/${audienceId}/contacts`),{headers:authHeaders(token)});
      const result=await response.json() as {contacts?:Contact[];error?:string};
      if(!response.ok)throw new Error(result.error||"Could not load audience contacts.");
      setMembers(result.contacts||[]);
    }catch(err){setError(err instanceof Error?err.message:"Could not load audience contacts.")}
  };
  useEffect(()=>{if(selectedId)loadMembers(selectedId)},[selectedId,token]);

  const loadAllContacts=async()=>{
    if(!token)return;
    try{
      const response=await fetch(metaApi("/api/contacts"),{headers:authHeaders(token)});
      const result=await response.json() as {contacts?:Contact[];error?:string};
      if(response.ok)setAllContacts(result.contacts||[]);
    }catch{}
  };
  useEffect(()=>{loadAllContacts()},[token]);

  const selected=audiences.find(a=>a.id===selectedId)||null;

  const createAudience=async()=>{
    if(!token)return;
    const name=newAudienceName.trim();
    if(!name){setShowNewAudience(true);return}
    setCreatingAudience(true);
    try{
      const response=await fetch(metaApi("/api/audiences"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({name})});
      const result=await response.json() as {audience?:AudienceSummary;error?:string};
      if(!response.ok||!result.audience)throw new Error(result.error||"Could not create audience.");
      setNewAudienceName("");setShowNewAudience(false);
      await loadAudiences();
      setSelectedId(result.audience.id);
      notify("Audience created");
    }catch(err){notify(err instanceof Error?err.message:"Could not create audience.")}
    finally{setCreatingAudience(false)}
  };

  const saveRename=async(audience:AudienceSummary)=>{
    if(!token||renamingName===null)return;
    const name=renamingName.trim();
    if(!name||name===audience.name){setRenamingName(null);return}
    try{
      const response=await fetch(metaApi(`/api/audiences/${audience.id}`),{method:"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({name})});
      const result=await response.json() as {saved?:boolean;error?:string};
      if(!response.ok||!result.saved)throw new Error(result.error||"Could not rename audience.");
      setRenamingName(null);
      await loadAudiences();
      notify("Audience renamed");
    }catch(err){notify(err instanceof Error?err.message:"Could not rename audience.")}
  };

  const deleteAudience=async(audience:AudienceSummary)=>{
    if(!token)return;
    if(!window.confirm(`Delete "${audience.name}"? This removes the audience but keeps its contacts.`))return;
    try{
      const response=await fetch(metaApi(`/api/audiences/${audience.id}`),{method:"DELETE",headers:authHeaders(token)});
      const result=await response.json() as {deleted?:boolean;error?:string};
      if(!response.ok||!result.deleted)throw new Error(result.error||"Could not delete audience.");
      setSelectedId(null);
      await loadAudiences();
      notify("Audience deleted")
    }catch(err){notify(err instanceof Error?err.message:"Could not delete audience.")}
  };

  const addNewContact=async()=>{
    if(!token||!selectedId)return;
    if(!newContact.name.trim()||!newContact.phone.trim()){notify("Enter a name and phone number");return}
    try{
      const tags=newContact.tags.split(",").map(t=>t.trim()).filter(Boolean);
      const createResponse=await fetch(metaApi("/api/contacts"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({name:newContact.name,phone:newContact.phone,consent:newContact.consent,tags})});
      const createResult=await createResponse.json() as {contact?:Contact;error?:string};
      if(!createResponse.ok||!createResult.contact)throw new Error(createResult.error||"Could not add contact.");
      await fetch(metaApi(`/api/audiences/${selectedId}/contacts`),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({contactIds:[createResult.contact.id]})});
      setNewContact({name:"",phone:"",consent:true,tags:""});
      await Promise.all([loadMembers(selectedId),loadAudiences(),loadAllContacts()]);
      notify("Contact added");
    }catch(err){notify(err instanceof Error?err.message:"Could not add contact.")}
  };

  const addExistingContact=async(contactId:string)=>{
    if(!token||!selectedId||!contactId)return;
    try{
      const response=await fetch(metaApi(`/api/audiences/${selectedId}/contacts`),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({contactIds:[contactId]})});
      const result=await response.json() as {added?:number;error?:string};
      if(!response.ok||!result.added)throw new Error(result.error||"Could not add contact.");
      await Promise.all([loadMembers(selectedId),loadAudiences()]);
      notify("Contact added to audience");
    }catch(err){notify(err instanceof Error?err.message:"Could not add contact.")}
  };

  const removeFromAudience=async(contactId:string)=>{
    if(!token||!selectedId)return;
    try{
      await fetch(metaApi(`/api/audiences/${selectedId}/contacts/${contactId}`),{method:"DELETE",headers:authHeaders(token)});
      await Promise.all([loadMembers(selectedId),loadAudiences()]);
      notify("Removed from audience");
    }catch{notify("Could not remove contact.")}
  };

  const toggleConsent=async(contact:Contact)=>{
    if(!token)return;
    try{
      const response=await fetch(metaApi(`/api/contacts/${contact.id}`),{method:"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({consent:!contact.consent})});
      const result=await response.json() as {contact?:Contact;error?:string};
      if(!response.ok||!result.contact)throw new Error(result.error||"Could not update contact.");
      if(selectedId)await Promise.all([loadMembers(selectedId),loadAudiences()]);
    }catch(err){notify(err instanceof Error?err.message:"Could not update contact.")}
  };

  const startEditContact=(contact:Contact)=>{setEditingContactId(contact.id);setEditDraft({name:contact.name,phone:contact.phone,tags:contact.tags.join(", ")})};
  const saveEditContact=async(contact:Contact)=>{
    if(!token)return;
    if(!editDraft.name.trim()||!editDraft.phone.trim()){notify("Name and phone are required");return}
    try{
      const tags=editDraft.tags.split(",").map(t=>t.trim()).filter(Boolean);
      const response=await fetch(metaApi(`/api/contacts/${contact.id}`),{method:"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({name:editDraft.name,phone:editDraft.phone,tags})});
      const result=await response.json() as {contact?:Contact;error?:string};
      if(!response.ok||!result.contact)throw new Error(result.error||"Could not update contact.");
      setEditingContactId(null);
      if(selectedId)await loadMembers(selectedId);
      notify("Contact updated");
    }catch(err){notify(err instanceof Error?err.message:"Could not update contact.")}
  };

  const deleteContact=async(contact:Contact)=>{
    if(!token)return;
    if(!window.confirm(`Delete ${contact.name} entirely? This removes them from every audience.`))return;
    try{
      await fetch(metaApi(`/api/contacts/${contact.id}`),{method:"DELETE",headers:authHeaders(token)});
      if(selectedId)await Promise.all([loadMembers(selectedId),loadAudiences()]);
      await loadAllContacts();
      notify("Contact deleted");
    }catch{notify("Could not delete contact.")}
  };

  const runImport=async()=>{
    if(!token||!selectedId)return;
    if(!csvText.trim()){notify("Paste CSV content first (columns: name, phone)");return}
    setImporting(true);
    try{
      const response=await fetch(metaApi("/api/contacts/import"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({csvText,audienceId:selectedId,consent:true})});
      const result=await response.json() as {imported?:number;skipped?:number;error?:string};
      if(!response.ok||result.imported===undefined)throw new Error(result.error||"Could not import CSV.");
      notify(`Imported ${result.imported} contact${result.imported===1?"":"s"}${result.skipped?` • skipped ${result.skipped}`:""}`);
      setCsvText("");
      await Promise.all([loadMembers(selectedId),loadAudiences(),loadAllContacts()]);
    }catch(err){notify(err instanceof Error?err.message:"Could not import CSV.")}
    finally{setImporting(false)}
  };

  const memberIds=new Set(members.map(m=>m.id));
  const availableToAdd=allContacts.filter(c=>!memberIds.has(c.id));

  return <><PageHeader title="Audiences" description="Manage real contact groups for campaign targeting." action={<button className="primary" onClick={()=>{setShowNewAudience(true)}}>＋ Create audience</button>}/>
    {error&&<div className="meta-error">⚠ {error}</div>}
    {showNewAudience&&<div className="inline-create-row"><input autoFocus value={newAudienceName} onChange={e=>setNewAudienceName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")createAudience();if(e.key==="Escape"){setShowNewAudience(false);setNewAudienceName("")}}} placeholder="Audience name (e.g. VIP customers)"/><button className="primary" disabled={creatingAudience||!newAudienceName.trim()} onClick={createAudience}>Create</button><button className="secondary-btn" onClick={()=>{setShowNewAudience(false);setNewAudienceName("")}}>Cancel</button></div>}
    {loading?<p className="empty-hint">Loading…</p>:!audiences.length&&!showNewAudience?<div className="empty-state"><span>♟</span><h3>No audiences yet</h3><p>Create one to start grouping real contacts for campaigns.</p></div>:!audiences.length?null:
    <div className="audience-manager">
      <aside className="audience-list-panel">{audiences.map(a=><button key={a.id} className={selectedId===a.id?"selected":""} onClick={()=>setSelectedId(a.id)}><div><strong>{a.name}</strong><small>{a.consentedCount.toLocaleString()} consented / {a.memberCount.toLocaleString()} total</small></div></button>)}</aside>
      <section className="audience-detail-panel">
        {selected?<>
        <div className="audience-detail-head">{renamingName!==null?<div className="inline-create-row" style={{margin:0}}><input autoFocus value={renamingName} onChange={e=>setRenamingName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveRename(selected);if(e.key==="Escape")setRenamingName(null)}}/><button className="primary" onClick={()=>saveRename(selected)}>Save</button><button className="secondary-btn" onClick={()=>setRenamingName(null)}>Cancel</button></div>:<><h3>{selected.name}</h3><div><button className="secondary-btn" onClick={()=>setRenamingName(selected.name)}>Rename</button><button className="secondary-btn" onClick={()=>deleteAudience(selected)}>Delete</button></div></>}</div>
        <div className="data-card"><div className="table-scroll"><table><thead><tr><th>Name</th><th>Phone</th><th>Consent</th><th>Tags</th><th/></tr></thead><tbody>{members.map(m=>editingContactId===m.id?<tr key={m.id}><td><input value={editDraft.name} onChange={e=>setEditDraft({...editDraft,name:e.target.value})}/></td><td><input value={editDraft.phone} onChange={e=>setEditDraft({...editDraft,phone:e.target.value})}/></td><td><button className={m.consent?"status-pill ready":"status-pill"} onClick={()=>toggleConsent(m)}>{m.consent?"Opted in":"No consent"}</button></td><td><input value={editDraft.tags} onChange={e=>setEditDraft({...editDraft,tags:e.target.value})} placeholder="vip, dubai"/></td><td><div className="row-actions"><button title="Save" onClick={()=>saveEditContact(m)}>✓</button><button title="Cancel" onClick={()=>setEditingContactId(null)}>×</button></div></td></tr>:<tr key={m.id}><td>{m.name}</td><td>{m.phone}</td><td><button className={m.consent?"status-pill ready":"status-pill"} onClick={()=>toggleConsent(m)}>{m.consent?"Opted in":"No consent"}</button></td><td>{m.tags.join(", ")||"—"}</td><td><div className="row-actions"><button title="Edit" onClick={()=>startEditContact(m)}>✎</button><button title="Remove from audience" onClick={()=>removeFromAudience(m.id)}>−</button><button title="Delete contact" onClick={()=>deleteContact(m)}>×</button></div></td></tr>)}</tbody></table>{!members.length&&<div className="empty-row">No contacts in this audience yet.</div>}</div></div>
        <div className="data-card" style={{padding:"1rem",marginTop:"1rem"}}>
          <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Add a contact</strong>
          <div className="form-grid"><label>Name<input value={newContact.name} onChange={e=>setNewContact({...newContact,name:e.target.value})}/></label><label>Phone<input value={newContact.phone} onChange={e=>setNewContact({...newContact,phone:e.target.value})} placeholder="+9715..."/></label></div>
          <div className="form-grid"><label>Tags (comma separated)<input value={newContact.tags} onChange={e=>setNewContact({...newContact,tags:e.target.value})} placeholder="vip, dubai"/></label><label>Consent<select value={newContact.consent?"yes":"no"} onChange={e=>setNewContact({...newContact,consent:e.target.value==="yes"})}><option value="yes">Opted in</option><option value="no">No consent</option></select></label></div>
          <div className="wizard-actions" style={{border:"none",marginTop:"0.5rem"}}><button className="primary" onClick={addNewContact}>Add contact</button></div>
        </div>
        {availableToAdd.length>0&&<div className="data-card" style={{padding:"1rem",marginTop:"1rem"}}>
          <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Add an existing contact</strong>
          <select defaultValue="" onChange={e=>{if(e.target.value){addExistingContact(e.target.value);e.target.value=""}}}><option value="" disabled>Choose a contact…</option>{availableToAdd.map(c=><option key={c.id} value={c.id}>{c.name} ({c.phone})</option>)}</select>
        </div>}
        <div className="data-card" style={{padding:"1rem",marginTop:"1rem"}}>
          <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Import CSV</strong>
          <p className="empty-hint" style={{marginBottom:"0.5rem"}}>Paste CSV with a header row containing "name" and "phone" columns. Imported contacts are marked as consented.</p>
          <textarea value={csvText} onChange={e=>setCsvText(e.target.value)} placeholder={"name,phone\nAisha D.,+971501234567"} style={{width:"100%",minHeight:"90px",border:"1px solid var(--line)",borderRadius:"7px",padding:"10px",fontFamily:"monospace",fontSize:"9px"}}/>
          <div className="wizard-actions" style={{border:"none",marginTop:"0.5rem"}}><button className="primary" disabled={importing} onClick={runImport}>{importing?"Importing…":"Import into this audience"}</button></div>
        </div>
        </>:<p className="empty-hint">Select an audience to manage its contacts.</p>}
      </section>
    </div>}
  </>;
}

const automationTemplates:{name:string;trigger:string;action:string}[]=[{name:"Welcome new leads",trigger:"New WhatsApp conversation",action:"Send AI welcome message"},{name:"Recover abandoned carts",trigger:"Cart idle for 2 hours",action:"Send recovery template"},{name:"Collect customer feedback",trigger:"Conversation marked resolved",action:"Request feedback survey"}];

// ── Automation Builder: real tree-based automation engine (see worker/automations.ts) ──

// ── v2 automation graph (mirrors worker/automation-graph.ts) ──
// Any node can point at any node, so a wide menu tree, a deep linear chain, and a loop back to a
// main menu are all just edges — no shape is privileged the way v1's fixed 2-branch tree was.
type AutoNodeKind = "trigger"|"message"|"buttons"|"question"|"items"|"aiReply"|"aiAction"|"split"|"wait"|"tag"|"notify"|"escalate"|"end";
type AutoNodeOption = { id:string; label:string; description?:string; next:string|null };
type AutoNodeCase = { id:string; label:string; match?:string; weight?:number; next:string|null };
type AutoStepConfig = {
  channels?:string[];
  messageText?:string;
  options?:AutoNodeOption[];
  variableKey?:string; inputType?:"text"|"number"|"date"|"email"|"phone"; required?:boolean;
  itemIds?:string[]; urlTemplate?:string;
  ruleType?:"conditional"|"ab"|"time"|"freq"; cases?:AutoNodeCase[]; fallbackNext?:string|null;
  activeDays?:string[]; startTime?:string; endTime?:string;
  freqMax?:number; freqPeriod?:"hour"|"day"|"week";
  waitAmount?:number; waitUnit?:"minutes"|"hours"|"days";
  tagName?:string;
  notifyChannels?:string[]; notifyRecipient?:string;
  aiActionName?:string;
  escalateQueue?:string; escalatePriority?:"Normal"|"Urgent";
  collectFlows?:{id:string;name:string;fields:{key:string;label:string}[];urlTemplate:string;itemIds:string[]}[];
};
type AutoNode = { id:string; kind:AutoNodeKind; title:string; subtitle?:string; icon?:string; chip?:string; next?:string|null; config?:AutoStepConfig };
type AutoGraph = { version:2; entryId:string; nodes:Record<string,AutoNode> };
type AutomationDef = { id:string; name:string; sectorKey:string; status:"active"|"draft"|"inactive"; priority:number; needsConfig:boolean; flow:AutoGraph; createdAt?:string; updatedAt?:string };
type SectorInfo = { key:string; name:string; icon:string; desc:string };
type ActivityRow = { id:number; automationId:string; automationName:string; contact:string; channel:string; branch:string; outcome:string; outcomeType:string; createdAt:string };

// Where an edge lives, so "add a node here" / "point this somewhere else" can address any slot.
type EdgeRef =
  | { kind:"next"; nodeId:string }
  | { kind:"option"; nodeId:string; optionId:string }
  | { kind:"case"; nodeId:string; caseId:string }
  | { kind:"fallback"; nodeId:string };

const AUTO_NODE_META:Record<AutoNodeKind,{icon:string;chip:string;label:string}>={
  trigger:{icon:"💬",chip:"rose",label:"Trigger"},
  message:{icon:"💬",chip:"rose",label:"Send message"},
  buttons:{icon:"◉",chip:"teal",label:"Ask with options"},
  question:{icon:"❓",chip:"teal",label:"Ask & store answer"},
  items:{icon:"▤",chip:"teal",label:"Show catalog items"},
  aiReply:{icon:"✨",chip:"indigo",label:"AI reply"},
  aiAction:{icon:"⚙",chip:"indigo",label:"AI reply + action"},
  split:{icon:"⑂",chip:"purple",label:"Rule branch"},
  wait:{icon:"⏱",chip:"neutral",label:"Wait"},
  tag:{icon:"🏷️",chip:"neutral",label:"Add tag"},
  notify:{icon:"🔔",chip:"purple",label:"Notify team"},
  escalate:{icon:"🧑‍💼",chip:"human",label:"Escalate to human"},
  end:{icon:"⏹",chip:"neutral",label:"End"},
};

const NEW_NODE_KINDS:AutoNodeKind[]=["message","buttons","question","items","aiReply","aiAction","split","wait","tag","notify","escalate","end"];

function defaultConfigFor(kind:AutoNodeKind):AutoStepConfig{
  switch(kind){
    case "trigger": return {channels:["webchat"]};
    case "message": return {messageText:""};
    case "buttons": return {messageText:"",options:[]};
    case "question": return {messageText:"",variableKey:"",inputType:"text"};
    case "items": return {itemIds:[],urlTemplate:""};
    case "split": return {ruleType:"conditional",cases:[{id:crypto.randomUUID(),label:"Matches",match:"",next:null}],fallbackNext:null};
    case "wait": return {waitAmount:1,waitUnit:"hours"};
    case "tag": return {tagName:""};
    case "notify": return {notifyChannels:["slack"],notifyRecipient:""};
    case "escalate": return {escalateQueue:"",escalatePriority:"Normal"};
    default: return {};
  }
}

function makeNode(kind:AutoNodeKind):AutoNode{
  const meta=AUTO_NODE_META[kind];
  return {id:crypto.randomUUID(),kind,title:meta.label,subtitle:"",icon:meta.icon,chip:meta.chip,next:null,config:defaultConfigFor(kind)};
}

// ── Immutable graph edits ──

function setNode(graph:AutoGraph, node:AutoNode):AutoGraph{
  return {...graph,nodes:{...graph.nodes,[node.id]:node}};
}

function setEdge(graph:AutoGraph, edge:EdgeRef, target:string|null):AutoGraph{
  const node=graph.nodes[edge.nodeId];
  if(!node)return graph;
  if(edge.kind==="next")return setNode(graph,{...node,next:target});
  const cfg={...(node.config||{})};
  if(edge.kind==="option")cfg.options=(cfg.options||[]).map(o=>o.id===edge.optionId?{...o,next:target}:o);
  if(edge.kind==="case")cfg.cases=(cfg.cases||[]).map(c=>c.id===edge.caseId?{...c,next:target}:c);
  if(edge.kind==="fallback")cfg.fallbackNext=target;
  return setNode(graph,{...node,config:cfg});
}

function getEdgeTarget(graph:AutoGraph, edge:EdgeRef):string|null{
  const node=graph.nodes[edge.nodeId];
  if(!node)return null;
  if(edge.kind==="next")return node.next??null;
  const cfg=node.config||{};
  if(edge.kind==="option")return (cfg.options||[]).find(o=>o.id===edge.optionId)?.next??null;
  if(edge.kind==="case")return (cfg.cases||[]).find(c=>c.id===edge.caseId)?.next??null;
  return cfg.fallbackNext??null;
}

// Adding a node always happens *through* an edge, so a new block is never left floating with no way
// for a conversation to reach it.
function addNodeAtEdge(graph:AutoGraph, edge:EdgeRef, kind:AutoNodeKind):{graph:AutoGraph;node:AutoNode}{
  const node=makeNode(kind);
  // Preserve whatever the edge pointed at by chaining it after the new node where that makes sense.
  const previousTarget=getEdgeTarget(graph,edge);
  if(previousTarget&&kind!=="buttons"&&kind!=="split"&&kind!=="end")node.next=previousTarget;
  let next=setNode(graph,node);
  next=setEdge(next,edge,node.id);
  return {graph:next,node};
}

// Deleting a node also clears every edge that pointed at it, so no dangling reference survives.
function deleteNode(graph:AutoGraph, nodeId:string):AutoGraph{
  if(nodeId===graph.entryId)return graph;
  const nodes:Record<string,AutoNode>={};
  for(const [id,n] of Object.entries(graph.nodes)){
    if(id===nodeId)continue;
    const cfg={...(n.config||{})};
    if(cfg.options)cfg.options=cfg.options.map(o=>o.next===nodeId?{...o,next:null}:o);
    if(cfg.cases)cfg.cases=cfg.cases.map(c=>c.next===nodeId?{...c,next:null}:c);
    if(cfg.fallbackNext===nodeId)cfg.fallbackNext=null;
    nodes[id]={...n,next:n.next===nodeId?null:n.next,config:cfg};
  }
  return {...graph,nodes};
}

// Mirror of the backend nodeIsIncomplete so the canvas can flag a block before anything is saved.
function nodeIsIncomplete(node:AutoNode):boolean{
  const c=node.config||{};
  switch(node.kind){
    case "trigger": return !(c.channels||[]).length;
    case "message": return !(c.messageText||"").trim();
    case "buttons": return !(c.messageText||"").trim()||!(c.options||[]).length||(c.options||[]).some(o=>!o.label.trim());
    case "question": return !(c.messageText||"").trim()||!(c.variableKey||"").trim();
    case "items": return !(c.itemIds||[]).length;
    case "split": return (c.ruleType||"conditional")==="conditional"
      ? !(c.cases||[]).length||(c.cases||[]).some(k=>!(k.match||"").trim())
      : !(c.cases||[]).length;
    case "tag": return !(c.tagName||"").trim();
    case "aiAction": return !(c.aiActionName||"").trim();
    case "escalate": return !(c.escalateQueue||"").trim();
    case "notify": return !(c.notifyChannels||[]).length;
    case "aiReply": return (c.collectFlows||[]).some(f=>!f.name.trim()||!f.fields.length||!f.urlTemplate.trim());
    default: return false;
  }
}

// Every outgoing edge of a node, labelled the way the customer experiences it.
function outgoingEdges(node:AutoNode):{edge:EdgeRef;label:string;target:string|null}[]{
  const cfg=node.config||{};
  if(node.kind==="buttons")return (cfg.options||[]).map(o=>({edge:{kind:"option" as const,nodeId:node.id,optionId:o.id},label:o.label||"(unnamed option)",target:o.next}));
  if(node.kind==="split")return [
    ...(cfg.cases||[]).map(c=>({edge:{kind:"case" as const,nodeId:node.id,caseId:c.id},label:c.label||"(case)",target:c.next})),
    {edge:{kind:"fallback" as const,nodeId:node.id},label:"Otherwise",target:cfg.fallbackNext??null},
  ];
  if(node.kind==="end")return [];
  return [{edge:{kind:"next" as const,nodeId:node.id},label:"then",target:node.next??null}];
}

const AUTO_CHIP_CLASS:Record<string,string>={rose:"chip-rose",green:"chip-green",blue:"chip-blue",purple:"chip-purple",indigo:"chip-indigo",human:"chip-human",neutral:"chip-neutral",teal:"chip-teal"};

function AutomationBuilder({notify}:{notify:(s:string)=>void}){
  const token=useAuthToken();
  const [list,setList]=useState<AutomationDef[]>([]);
  const [loading,setLoading]=useState(true);
  const [view,setView]=useState<"list"|"canvas"|"activity">("list");
  const [selected,setSelected]=useState<AutomationDef|null>(null);
  const [sectors,setSectors]=useState<SectorInfo[]>([]);
  const [showTemplates,setShowTemplates]=useState(false);
  const [editing,setEditing]=useState<AutoNode|null>(null);
  const [addingAtEdge,setAddingAtEdge]=useState<EdgeRef|null>(null);
  const [linkingEdge,setLinkingEdge]=useState<EdgeRef|null>(null);
  const [activity,setActivity]=useState<ActivityRow[]>([]);
  const [activityLoading,setActivityLoading]=useState(false);
  const [aiActions,setAiActions]=useState<{name:string;description:string}[]>([]);
  const [catalogItems,setCatalogItems]=useState<{id:string;name:string}[]>([]);
  const [renaming,setRenaming]=useState(false);
  const [nameDraft,setNameDraft]=useState("");
  const [testOpen,setTestOpen]=useState(false);
  const [testMessage,setTestMessage]=useState("");
  const [testResult,setTestResult]=useState<{path:{label:string;note?:string;steps:string[]}[]}|null>(null);
  const [testing,setTesting]=useState(false);

  const load=async()=>{
    if(!token){setLoading(false);return}
    setLoading(true);
    try{
      const response=await fetch(metaApi("/api/automations"),{headers:authHeaders(token)});
      const data=await response.json() as {automations?:AutomationDef[]};
      setList(data.automations||[]);
    }catch{}
    finally{setLoading(false)}
  };
  useEffect(()=>{load();loadAiActions();loadCatalogItems()},[token]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadActivity=async()=>{
    if(!token)return;
    setActivityLoading(true);
    try{
      const response=await fetch(metaApi("/api/automations/activity"),{headers:authHeaders(token)});
      const data=await response.json() as {rows?:ActivityRow[]};
      setActivity(data.rows||[]);
    }catch{}
    finally{setActivityLoading(false)}
  };

  const openTemplates=async()=>{
    setShowTemplates(true);
    if(sectors.length||!token)return;
    try{
      const response=await fetch(metaApi("/api/automations/sectors"),{headers:authHeaders(token)});
      const data=await response.json() as {sectors?:SectorInfo[]};
      setSectors(data.sectors||[]);
    }catch{}
  };

  const createBlank=async()=>{
    if(!token)return;
    const response=await fetch(metaApi("/api/automations"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({name:"New automation"})});
    const result=await response.json() as {automation?:AutomationDef;error?:string};
    if(!response.ok||!result.automation){notify(result.error||"Could not create automation.");return}
    setList([...list,result.automation]);
    setShowTemplates(false);
    setSelected(result.automation);
    setView("canvas");
    notify("Blank automation created — click each step to configure it");
  };

  const createFromTemplate=async(sectorKey:string,name:string)=>{
    if(!token)return;
    const response=await fetch(metaApi("/api/automations/from-template"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({sectorKey,name})});
    const result=await response.json() as {automation?:AutomationDef;error?:string};
    if(!response.ok||!result.automation){notify(result.error||"Could not create automation.");return}
    setList([...list,result.automation]);
    setShowTemplates(false);
    setSelected(result.automation);
    setView("canvas");
    notify("Automation created from template");
  };

  const patchAutomation=async(id:string,patch:Partial<{name:string;status:string;flow:AutoGraph;needsConfig:boolean}>)=>{
    if(!token)return null;
    const response=await fetch(metaApi(`/api/automations/${id}`),{method:"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify(patch)});
    const result=await response.json() as {automation?:AutomationDef;error?:string};
    if(!response.ok||!result.automation){notify(result.error||"Could not save automation.");return null}
    setList(list.map(a=>a.id===id?result.automation!:a));
    if(selected?.id===id)setSelected(result.automation);
    return result.automation;
  };

  const toggleStatus=async(automation:AutomationDef)=>{
    const status=automation.status==="active"?"inactive":"active";
    await patchAutomation(automation.id,{status});
    notify(status==="active"?"Automation activated":"Automation deactivated");
  };

  const reorder=async(automation:AutomationDef,direction:"up"|"down")=>{
    if(!token)return;
    await fetch(metaApi(`/api/automations/${automation.id}/reorder`),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({direction})});
    load();
  };

  const remove=async(automation:AutomationDef)=>{
    if(!token)return;
    if(!window.confirm(`Delete "${automation.name}"?`))return;
    await fetch(metaApi(`/api/automations/${automation.id}`),{method:"DELETE",headers:authHeaders(token)});
    setList(list.filter(a=>a.id!==automation.id));
    notify("Automation deleted");
  };

  const commitGraph=async(graph:AutoGraph, message:string)=>{
    if(!selected)return null;
    const saved=await patchAutomation(selected.id,{flow:graph});
    if(saved&&message)notify(message);
    return saved;
  };

  const saveNode=async(node:AutoNode)=>{
    if(!selected)return;
    const saved=await commitGraph(setNode(selected.flow,node),"Block saved");
    if(saved)setEditing(null);
  };

  const removeNode=async(nodeId:string)=>{
    if(!selected)return;
    if(!window.confirm("Delete this block? Anything pointing at it will become unconnected."))return;
    const saved=await commitGraph(deleteNode(selected.flow,nodeId),"Block deleted");
    if(saved)setEditing(null);
  };

  // Adding always goes through an edge slot, so a new block is immediately reachable.
  const addNodeHere=async(edge:EdgeRef, kind:AutoNodeKind)=>{
    if(!selected)return;
    const {graph,node}=addNodeAtEdge(selected.flow,edge,kind);
    const saved=await commitGraph(graph,"Block added");
    setAddingAtEdge(null);
    if(saved)setEditing(node);
  };

  // Pointing an edge at a block that already exists is what makes "Main menu" style loop-backs
  // possible — the same capability v1 had no way to express.
  const linkEdgeTo=async(edge:EdgeRef, targetId:string|null)=>{
    if(!selected)return;
    await commitGraph(setEdge(selected.flow,edge,targetId),targetId?"Connected":"Disconnected");
    setLinkingEdge(null);
  };

  const startRename=()=>{if(selected){setNameDraft(selected.name);setRenaming(true)}};
  const commitRename=async()=>{
    if(!selected)return;
    const name=nameDraft.trim();
    setRenaming(false);
    if(name&&name!==selected.name)await patchAutomation(selected.id,{name});
  };

  const loadAiActions=async()=>{
    if(!token)return;
    try{
      const response=await fetch(metaApi("/api/automations/ai-actions"),{headers:authHeaders(token)});
      const data=await response.json() as {actions?:{name:string;description:string}[]};
      setAiActions(data.actions||[]);
    }catch{}
  };

  const loadCatalogItems=async()=>{
    if(!token)return;
    try{
      const response=await fetch(metaApi("/api/items"),{headers:authHeaders(token)});
      const data=await response.json() as {items?:{id:string;name:string}[]};
      setCatalogItems(data.items||[]);
    }catch{}
  };

  const runTest=async()=>{
    if(!selected||!token)return;
    setTesting(true);setTestResult(null);
    try{
      const response=await fetch(metaApi(`/api/automations/${selected.id}/test`),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({message:testMessage})});
      const data=await response.json() as {path?:{label:string;note?:string;steps:string[]}[]};
      setTestResult({path:data.path||[]});
    }catch{notify("Could not run the test.")}
    finally{setTesting(false)}
  };

  const runCounts=useMemo(()=>{
    const counts:Record<string,number>={};
    activity.forEach(row=>{counts[row.automationId]=(counts[row.automationId]||0)+1});
    return counts;
  },[activity]);

  if(view==="activity"){
    return <>
      <PageHeader title="Automation activity" description="Real executions of your automations, most recent first." action={<button className="secondary-btn" onClick={()=>setView("list")}>← Back to automations</button>}/>
      <div className="data-card">
        {activityLoading?<p className="empty-hint">Loading…</p>:!activity.length?<div className="empty-state"><span>⌁</span><h3>No activity yet</h3><p>Once a customer message matches an active automation&apos;s trigger, it&apos;ll show up here.</p></div>:
        <table><thead><tr><th>Contact</th><th>Channel</th><th>Automation</th><th>Branch</th><th>Outcome</th><th>When</th></tr></thead>
        <tbody>{activity.map(row=><tr key={row.id}><td>{row.contact}</td><td>{row.channel}</td><td><strong>{row.automationName}</strong></td><td>{row.branch}</td><td><b className={row.outcomeType==="warn"?"":"positive"} style={row.outcomeType==="warn"?{color:"#b66b26"}:undefined}>{row.outcome}</b></td><td>{row.createdAt}</td></tr>)}</tbody></table>}
      </div>
    </>;
  }

  if(view==="canvas"&&selected){
    const flow=selected.flow;
    return <>
      <div className="page-header"><div>
        {renaming?<input className="automation-name-input" autoFocus value={nameDraft} onChange={e=>setNameDraft(e.target.value)} onBlur={commitRename} onKeyDown={e=>{if(e.key==="Enter")commitRename();if(e.key==="Escape")setRenaming(false)}}/>:<h1 className="automation-name-title" onClick={startRename} title="Click to rename">{selected.name} <span className="rename-hint">✎</span></h1>}
        <p>{selected.needsConfig?"⚠ Some steps still need configuration — fill in the highlighted blocks before activating.":"Click any block to edit it. Hover a step to remove it."}</p>
      </div><div className="header-buttons">
        <button className="secondary-btn" onClick={()=>setView("list")}>← Back to list</button>
        <button className="secondary-btn" onClick={()=>{setTestOpen(true);setTestResult(null)}}>▷ Test</button>
        <button className={`toggle ${selected.status==="active"?"on":""}`} onClick={()=>toggleStatus(selected)} title={selected.status==="active"?"Active — click to deactivate":"Inactive — click to activate"}><i/></button>
      </div></div>
      <div className="automation-canvas graph-canvas">
        <AutoGraphTree
          graph={flow}
          nodeId={flow.entryId}
          seen={[]}
          onEdit={setEditing}
          onAddAt={setAddingAtEdge}
          onLinkAt={setLinkingEdge}
        />
      </div>
      {editing&&<StepDrawer node={editing} graph={flow} aiActions={aiActions} items={catalogItems} onClose={()=>setEditing(null)} onSave={saveNode} onDelete={editing.id===flow.entryId?undefined:()=>removeNode(editing.id)}/>}
      {addingAtEdge&&<SimpleModal title="Add a block here" onClose={()=>setAddingAtEdge(null)}>
        <p>Choose what this block does — you can configure the details next.</p>
        <div className="template-gallery">{NEW_NODE_KINDS.map(kind=><button key={kind} onClick={()=>addNodeHere(addingAtEdge,kind)}>
          <span className={`auto-node-icon ${AUTO_CHIP_CLASS[AUTO_NODE_META[kind].chip]||"chip-neutral"}`} style={{display:"inline-grid",placeItems:"center",width:28,height:28,borderRadius:8}}>{AUTO_NODE_META[kind].icon}</span>
          <strong>{AUTO_NODE_META[kind].label}</strong>
        </button>)}</div>
      </SimpleModal>}
      {linkingEdge&&<SimpleModal title="Connect to an existing block" onClose={()=>setLinkingEdge(null)}>
        <p>Point this path at a block that already exists — this is how you send someone back to a main menu, or reuse one shared step from several places.</p>
        <div className="template-gallery">{Object.values(flow.nodes).filter(n=>n.id!==linkingEdge.nodeId).map(n=><button key={n.id} onClick={()=>linkEdgeTo(linkingEdge,n.id)}>
          <span className={`auto-node-icon ${AUTO_CHIP_CLASS[n.chip||AUTO_NODE_META[n.kind].chip]||"chip-neutral"}`} style={{display:"inline-grid",placeItems:"center",width:28,height:28,borderRadius:8}}>{n.icon||AUTO_NODE_META[n.kind].icon}</span>
          <strong>{n.title}</strong>
          <small>{AUTO_NODE_META[n.kind].label}</small>
        </button>)}</div>
        <div className="modal-actions"><button className="secondary-btn" onClick={()=>linkEdgeTo(linkingEdge,null)}>Disconnect this path</button></div>
      </SimpleModal>}
      {testOpen&&<SimpleModal title="Test this automation" onClose={()=>setTestOpen(false)}>
        <p>Type a sample customer message. This is a dry run — it shows which branch it would take and what would happen, without sending anything.</p>
        <div className="modal-form"><label>Sample message<input value={testMessage} onChange={e=>setTestMessage(e.target.value)} placeholder="e.g. I need to talk to a human" onKeyDown={e=>{if(e.key==="Enter")runTest()}}/></label></div>
        <div className="modal-actions"><button className="secondary-btn" onClick={()=>setTestOpen(false)}>Close</button><button className="primary" disabled={testing} onClick={runTest}>{testing?"Running…":"Run test"}</button></div>
        {testResult&&<div className="test-result">{testResult.path.map((p,i)=><div key={i} className="test-result-branch">
          <div className="test-result-label">→ {p.label}</div>
          {p.note&&<div className="test-result-note">{p.note}</div>}
          <ul>{p.steps.length?p.steps.map((s,j)=><li key={j}>{s}</li>):<li className="empty-hint">No steps in this branch</li>}</ul>
        </div>)}</div>}
      </SimpleModal>}
    </>;
  }

  return <>
    <PageHeader title="Automations" description="Always-on rules that react to a trigger and run a full branch — AI replies, system actions, tags, escalation — in one shot." action={<div className="header-buttons"><button className="secondary-btn" onClick={()=>{setView("activity");loadActivity()}}>Activity log</button><button className="primary" onClick={openTemplates}>＋ New automation</button></div>}/>
    {loading?<p className="empty-hint">Loading…</p>:!list.length?
      <div className="empty-state"><span>⌁</span><h3>No automations yet</h3><p>Start from one of 8 ready-made industry flows — reservation booking, order tracking, emergency escalation, and more.</p><button className="primary" onClick={openTemplates}>＋ New automation</button></div>:
      <div className="data-card">
        <table><thead><tr><th/><th>Automation</th><th>Trigger</th><th>Status</th><th>Runs</th><th/></tr></thead>
        <tbody>{[...list].sort((a,b)=>a.priority-b.priority).map((automation,idx)=><tr key={automation.id}>
          <td><div className="row-actions"><button title="Move up" disabled={idx===0} onClick={()=>reorder(automation,"up")}>▲</button><button title="Move down" disabled={idx===list.length-1} onClick={()=>reorder(automation,"down")}>▼</button></div></td>
          <td><div className="table-title"><span>⌁</span><div><strong>{automation.name}</strong>{automation.needsConfig&&<small style={{color:"#b66b26",display:"block"}}>⚠ Needs configuration</small>}</div></div></td>
          <td>{(automation.flow.nodes[automation.flow.entryId]?.config?.channels||[]).join(" + ")||"—"} · {Object.keys(automation.flow.nodes).length} blocks</td>
          <td><span className={`flow-status-pill ${automation.status==="active"?"is-active":"is-draft"}`}>{automation.status==="active"?"Active":automation.status==="draft"?"Draft":"Inactive"}</span></td>
          <td>{runCounts[automation.id]||0}</td>
          <td><div className="row-actions" style={{justifyContent:"flex-end"}}>
            <button className="secondary-btn" style={{width:"auto",whiteSpace:"nowrap"}} onClick={()=>{setSelected(automation);setView("canvas")}}>Open →</button>
            <button title="Delete" onClick={()=>remove(automation)}>×</button>
          </div></td>
        </tr>)}</tbody></table>
      </div>}
    {showTemplates&&<SimpleModal title="New automation" onClose={()=>setShowTemplates(false)}>
      <button className="blank-automation-btn" onClick={createBlank}>
        <span>✎</span><div><strong>Start from scratch</strong><small>A minimal trigger + one split + two branches — build it your own way.</small></div>
      </button>
      <p style={{margin:"14px 0 8px"}}>Or pick an industry starter flow — you can edit every step afterward.</p>
      <div className="template-gallery">{sectors.map(s=><button key={s.key} onClick={()=>createFromTemplate(s.key,`${s.name} automation`)}>
        <span>{s.icon}</span><strong>{s.name}</strong><small>{s.desc}</small>
      </button>)}</div>
    </SimpleModal>}
  </>;
}

function AutoNodeCard({node,onClick,onDelete}:{node:AutoNode;onClick:()=>void;onDelete?:()=>void}){
  const incomplete=nodeIsIncomplete(node);
  const meta=AUTO_NODE_META[node.kind];
  const cfg=node.config||{};
  const preview=node.kind==="buttons"||node.kind==="message"||node.kind==="question"
    ? (cfg.messageText||"").slice(0,70)
    : node.kind==="items" ? `${(cfg.itemIds||[]).length} item(s)`
    : node.kind==="tag" ? cfg.tagName||""
    : node.kind==="escalate" ? cfg.escalateQueue||""
    : node.kind==="aiAction" ? cfg.aiActionName||""
    : node.kind==="wait" ? `${cfg.waitAmount??1} ${cfg.waitUnit||"hours"}`
    : node.kind==="trigger" ? (cfg.channels||[]).join(" + ")
    : "";
  return <div className="auto-node-wrap">
    <button className={`auto-node ${incomplete?"is-incomplete":""}`} onClick={onClick}>
      <span className={`auto-node-icon ${AUTO_CHIP_CLASS[node.chip||meta.chip]||"chip-neutral"}`}>{node.icon||meta.icon}</span>
      <span className="auto-node-text">
        <strong>{node.title||meta.label}</strong>
        <small>{preview||meta.label}</small>
      </span>
      {incomplete&&<em className="auto-node-warn" title="This block still needs configuration">⚠</em>}
    </button>
    {onDelete&&<button className="auto-node-remove" title="Remove this block" onClick={e=>{e.stopPropagation();onDelete()}}>×</button>}
  </div>;
}

// Renders the graph as an indented tree rather than a fixed grid: a node's outgoing paths nest
// beneath it, so any number of options and any depth lay out naturally. A path that leads back to a
// node already shown above renders as a reference chip instead of recursing forever — cycles are a
// legitimate design (a "Main menu" option), so they're displayed, not rejected.
function AutoGraphTree({graph,nodeId,seen,onEdit,onAddAt,onLinkAt}:{
  graph:AutoGraph; nodeId:string|null; seen:string[];
  onEdit:(n:AutoNode)=>void; onAddAt:(e:EdgeRef)=>void; onLinkAt:(e:EdgeRef)=>void;
}){
  if(!nodeId)return null;
  const node=graph.nodes[nodeId];
  if(!node)return null;
  const edges=outgoingEdges(node);
  const nextSeen=[...seen,node.id];

  return <div className="graph-node">
    <AutoNodeCard node={node} onClick={()=>onEdit(node)} onDelete={node.id===graph.entryId?undefined:()=>onEdit(node)}/>
    {!!edges.length&&<div className="graph-edges">
      {edges.map(({edge,label,target})=>{
        const loops=target&&seen.includes(target);
        const targetNode=target?graph.nodes[target]:null;
        return <div className="graph-edge" key={`${edge.kind}-${"optionId" in edge?edge.optionId:"caseId" in edge?edge.caseId:edge.kind}`}>
          <span className="graph-edge-label">{label}</span>
          {loops&&targetNode
            ? <button className="graph-loop-chip" onClick={()=>onEdit(targetNode)} title="This path goes back to a block shown above">↩ back to “{targetNode.title}”</button>
            : target
              ? <AutoGraphTree graph={graph} nodeId={target} seen={nextSeen} onEdit={onEdit} onAddAt={onAddAt} onLinkAt={onLinkAt}/>
              : <div className="graph-edge-empty">
                  <button className="auto-add-step" onClick={()=>onAddAt(edge)}>＋ Add block</button>
                  <button className="graph-link-btn" onClick={()=>onLinkAt(edge)}>⇢ Connect to existing</button>
                </div>}
        </div>;
      })}
    </div>}
  </div>;
}

function StepDrawer({node,graph,aiActions,items,onClose,onSave,onDelete}:{node:AutoNode;graph:AutoGraph;aiActions:{name:string;description:string}[];items:{id:string;name:string}[];onClose:()=>void;onSave:(next:AutoNode)=>void;onDelete?:()=>void}){
  const token=useAuthToken();
  const [draft,setDraft]=useState<AutoNode>(node);
  const config=draft.config||{};
  const update=(patch:Partial<AutoStepConfig>)=>setDraft({...draft,config:{...config,...patch}});
  const toggleIn=(key:"channels"|"notifyChannels",value:string)=>{
    const current=(config[key] as string[]|undefined)||[];
    update({[key]:current.includes(value)?current.filter(v=>v!==value):[...current,value]} as Partial<AutoStepConfig>);
  };
  const save=()=>onSave(draft);

  // Options (buttons node) — each is a real routable path, so there is no cap of two.
  const options=config.options||[];
  const addOption=()=>update({options:[...options,{id:crypto.randomUUID(),label:"",description:"",next:null}]});
  const updateOption=(id:string,patch:Partial<AutoNodeOption>)=>update({options:options.map(o=>o.id===id?{...o,...patch}:o)});
  const removeOption=(id:string)=>update({options:options.filter(o=>o.id!==id)});

  // Cases (split node) — N-way keyword/weight branching, was hardcoded binary in v1.
  const cases=config.cases||[];
  const addCase=()=>update({cases:[...cases,{id:crypto.randomUUID(),label:"",match:"",next:null}]});
  const updateCase=(id:string,patch:Partial<AutoNodeCase>)=>update({cases:cases.map(c=>c.id===id?{...c,...patch}:c)});
  const removeCase=(id:string)=>update({cases:cases.filter(c=>c.id!==id)});

  const collectFlows=config.collectFlows||[];
  const updateFlow=(flowId:string,patch:Partial<{name:string;urlTemplate:string;itemIds:string[];fields:{key:string;label:string}[]}>)=>update({collectFlows:collectFlows.map(f=>f.id===flowId?{...f,...patch}:f)});
  const addFlow=()=>update({collectFlows:[...collectFlows,{id:crypto.randomUUID(),name:"",fields:[],urlTemplate:"",itemIds:[]}]});
  const removeFlow=(flowId:string)=>update({collectFlows:collectFlows.filter(f=>f.id!==flowId)});
  const addField=(flowId:string)=>{const f=collectFlows.find(x=>x.id===flowId);if(!f)return;updateFlow(flowId,{fields:[...f.fields,{key:"",label:""}]})};
  const updateField=(flowId:string,idx:number,patch:Partial<{key:string;label:string}>)=>{const f=collectFlows.find(x=>x.id===flowId);if(!f)return;updateFlow(flowId,{fields:f.fields.map((x,i)=>i===idx?{...x,...patch}:x)})};
  const removeField=(flowId:string,idx:number)=>{const f=collectFlows.find(x=>x.id===flowId);if(!f)return;updateFlow(flowId,{fields:f.fields.filter((_,i)=>i!==idx)})};
  const toggleFlowItem=(flowId:string,itemId:string)=>{const f=collectFlows.find(x=>x.id===flowId);if(!f)return;const cur=f.itemIds||[];updateFlow(flowId,{itemIds:cur.includes(itemId)?cur.filter(x=>x!==itemId):[...cur,itemId]})};

  const [testValues,setTestValues]=useState<Record<string,Record<string,string>>>({});
  const [testUrl,setTestUrl]=useState<Record<string,string>>({});
  const [testError,setTestError]=useState<Record<string,string>>({});
  const runTestLink=async(id:string,template:string)=>{
    setTestUrl({...testUrl,[id]:""});setTestError({...testError,[id]:""});
    if(!token||!template)return;
    try{
      const response=await fetch(metaApi("/api/automations/test-link"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({template,values:testValues[id]||{}})});
      const data=await response.json() as {url?:string;error?:string};
      if(!response.ok||!data.url){setTestError({...testError,[id]:data.error||"Could not build a preview link."});return}
      setTestUrl({...testUrl,[id]:data.url});
      window.open(data.url,"_blank","noopener,noreferrer");
    }catch{setTestError({...testError,[id]:"Could not reach the server."})}
  };

  // Lets a path be pointed at an existing block from inside the drawer, mirroring the canvas.
  const targetPicker=(current:string|null,onPick:(id:string|null)=>void)=><select value={current||""} onChange={e=>onPick(e.target.value||null)}>
    <option value="">— not connected —</option>
    {Object.values(graph.nodes).filter(n=>n.id!==draft.id).map(n=><option key={n.id} value={n.id}>{n.title}</option>)}
  </select>;

  const meta=AUTO_NODE_META[draft.kind];

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal drawer-modal" onMouseDown={e=>e.stopPropagation()}>
    <div className="modal-head"><h2>{draft.title||meta.label}</h2><button onClick={onClose}>×</button></div>
    <div className="modal-form">
      <p className="empty-hint" style={{margin:"0 0 8px"}}>{meta.label}</p>
      <label>Block name (shown on the canvas only)<input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>

      {draft.kind==="trigger"&&<label>Channels this automation runs on
        <div className="channel-choice"><label className="channel-opt"><input type="checkbox" checked={(config.channels||[]).includes("webchat")} onChange={()=>toggleIn("channels","webchat")}/> <span>◉ Web chat</span></label><label className="channel-opt"><input type="checkbox" checked={(config.channels||[]).includes("whatsapp")} onChange={()=>toggleIn("channels","whatsapp")}/> <span>✆ WhatsApp</span></label><label className="channel-opt disabled" title="Instagram messaging isn't connected in this workspace yet"><input type="checkbox" disabled/> <span>◎ Instagram — not available yet</span></label></div>
      </label>}

      {draft.kind==="message"&&<label>Message text — {"{{variable}}"} inserts an answer collected earlier
        <textarea rows={4} value={config.messageText||""} onChange={e=>update({messageText:e.target.value})} placeholder={"Thanks {{name}} — here's what you need."}/>
      </label>}

      {draft.kind==="buttons"&&<>
        <label>Prompt shown above the options<textarea rows={2} value={config.messageText||""} onChange={e=>update({messageText:e.target.value})} placeholder="Hello, how may we help you?"/></label>
        <label>Options — each one routes to its own block, and there&apos;s no limit on how many
          <div className="flow-options-list">
            {options.map(o=><div className="flow-option-row" key={o.id} style={{flexWrap:"wrap"}}>
              <input placeholder="Button label" value={o.label} onChange={e=>updateOption(o.id,{label:e.target.value})}/>
              <input placeholder="Subtitle (optional)" value={o.description||""} onChange={e=>updateOption(o.id,{description:e.target.value})}/>
              {targetPicker(o.next,id=>updateOption(o.id,{next:id}))}
              <button type="button" onClick={()=>removeOption(o.id)}>×</button>
            </div>)}
          </div>
          <button type="button" className="secondary-btn" onClick={addOption}>＋ Add option</button>
        </label>
        <label>If the answer matches no option<div>{targetPicker(config.fallbackNext??null,id=>update({fallbackNext:id}))}</div>
          <small style={{fontWeight:400,color:"#8b93a1"}}>Leave unconnected to simply re-ask the question.</small>
        </label>
      </>}

      {draft.kind==="question"&&<>
        <label>Question to ask<textarea rows={2} value={config.messageText||""} onChange={e=>update({messageText:e.target.value})} placeholder="What name should we use?"/></label>
        <label>Store the answer as<input value={config.variableKey||""} onChange={e=>update({variableKey:e.target.value.replace(/[^a-zA-Z0-9_]/g,"")})} placeholder="e.g. arrival"/>
          <small style={{fontWeight:400,color:"#8b93a1"}}>Use it later as {"{{"}{config.variableKey||"key"}{"}}"} in any message, or as {"{"}{config.variableKey||"key"}{"}"} in a link template.</small>
        </label>
        <label>Expected answer<select value={config.inputType||"text"} onChange={e=>update({inputType:e.target.value as AutoStepConfig["inputType"]})}>
          <option value="text">Any text</option><option value="number">A number</option><option value="date">A date</option><option value="email">An email address</option><option value="phone">A phone number</option>
        </select><small style={{fontWeight:400,color:"#8b93a1"}}>Anything that doesn&apos;t fit is rejected and the question is asked again.</small></label>
      </>}

      {draft.kind==="items"&&<>
        <label>Intro text above the cards (optional)<textarea rows={2} value={config.messageText||""} onChange={e=>update({messageText:e.target.value})}/></label>
        <label>Catalog items to show
          <div className="parameter-list">
            {items.map(it=><label key={it.id} style={{display:"flex",gap:"0.4rem",alignItems:"center"}}><input type="checkbox" checked={(config.itemIds||[]).includes(it.id)} onChange={()=>update({itemIds:(config.itemIds||[]).includes(it.id)?(config.itemIds||[]).filter(x=>x!==it.id):[...(config.itemIds||[]),it.id]})}/> {it.name}</label>)}
            {!items.length&&<small className="empty-hint">No items in your catalog yet — add some in the Items tab.</small>}
          </div>
        </label>
        <label>Link for each card&apos;s button — {"{key}"} inserts a collected answer
          <input value={config.urlTemplate||""} onChange={e=>update({urlTemplate:e.target.value})} placeholder="https://example.com/book?arrival={arrival}&rooms={rooms}"/>
        </label>
        {!!config.urlTemplate&&<label>Test this link
          <button type="button" className="secondary-btn" onClick={()=>runTestLink(draft.id,config.urlTemplate||"")}>▷ Test this link</button>
          {testUrl[draft.id]&&<small style={{display:"block",marginTop:"6px",wordBreak:"break-all"}}>Opened: {testUrl[draft.id]}</small>}
          {testError[draft.id]&&<small style={{display:"block",marginTop:"6px",color:"#b3261e"}}>{testError[draft.id]}</small>}
        </label>}
      </>}

      {draft.kind==="split"&&<>
        <label>Rule type<select value={config.ruleType||"conditional"} onChange={e=>update({ruleType:e.target.value as AutoStepConfig["ruleType"]})}>
          <option value="conditional">Conditional (keyword match)</option>
          <option value="ab">A/B split</option>
          <option value="time">Time window</option>
          <option value="freq">Frequency cap</option>
        </select></label>
        <label>Cases — checked in order, first match wins
          <div className="flow-options-list">
            {cases.map(c=><div className="flow-option-row" key={c.id} style={{flexWrap:"wrap"}}>
              <input placeholder="Case name" value={c.label} onChange={e=>updateCase(c.id,{label:e.target.value})}/>
              {(config.ruleType||"conditional")==="conditional"&&<input placeholder="Keywords, comma-separated" value={c.match||""} onChange={e=>updateCase(c.id,{match:e.target.value})}/>}
              {config.ruleType==="ab"&&<input type="number" min={0} max={100} placeholder="%" value={c.weight??50} onChange={e=>updateCase(c.id,{weight:Number(e.target.value)})}/>}
              {targetPicker(c.next,id=>updateCase(c.id,{next:id}))}
              <button type="button" onClick={()=>removeCase(c.id)}>×</button>
            </div>)}
          </div>
          <button type="button" className="secondary-btn" onClick={addCase}>＋ Add case</button>
        </label>
        <label>Otherwise go to<div>{targetPicker(config.fallbackNext??null,id=>update({fallbackNext:id}))}</div></label>
        {config.ruleType==="time"&&<><label>Start time<input type="time" value={config.startTime||"09:00"} onChange={e=>update({startTime:e.target.value})}/></label><label>End time<input type="time" value={config.endTime||"18:00"} onChange={e=>update({endTime:e.target.value})}/></label></>}
        {config.ruleType==="freq"&&<><label>Max sends<input type="number" min={1} value={config.freqMax??3} onChange={e=>update({freqMax:Number(e.target.value)})}/></label><label>Per<select value={config.freqPeriod||"day"} onChange={e=>update({freqPeriod:e.target.value as AutoStepConfig["freqPeriod"]})}><option value="hour">Hour</option><option value="day">Day</option><option value="week">Week</option></select></label></>}
      </>}

      {draft.kind==="wait"&&<><label>Duration<input type="number" min={1} value={config.waitAmount??1} onChange={e=>update({waitAmount:Number(e.target.value)})}/></label><label>Unit<select value={config.waitUnit||"hours"} onChange={e=>update({waitUnit:e.target.value as AutoStepConfig["waitUnit"]})}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label></>}

      {draft.kind==="tag"&&<label>Tag name<input value={config.tagName||""} onChange={e=>update({tagName:e.target.value})}/></label>}

      {draft.kind==="notify"&&<><label>Notify via<div className="checkbox-row"><label><input type="checkbox" checked={(config.notifyChannels||[]).includes("email")} onChange={()=>toggleIn("notifyChannels","email")}/> Email</label><label><input type="checkbox" checked={(config.notifyChannels||[]).includes("slack")} onChange={()=>toggleIn("notifyChannels","slack")}/> Slack</label></div></label><label>Recipient<input value={config.notifyRecipient||""} onChange={e=>update({notifyRecipient:e.target.value})} placeholder="email or leave blank for the workspace Slack webhook"/></label></>}

      {draft.kind==="aiAction"&&(aiActions.length?<label>Which AI Action to run<select value={config.aiActionName||""} onChange={e=>update({aiActionName:e.target.value})}><option value="">— Select an action —</option>{aiActions.map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select>{config.aiActionName&&aiActions.find(a=>a.name===config.aiActionName)?.description&&<small style={{fontWeight:400,color:"#8b93a1"}}>{aiActions.find(a=>a.name===config.aiActionName)!.description}</small>}</label>:<p className="empty-hint">No AI Actions are configured yet. Create one in Assistants → AI Actions, then pick it here.</p>)}

      {draft.kind==="escalate"&&<><label>Assign to queue<input value={config.escalateQueue||""} onChange={e=>update({escalateQueue:e.target.value})}/></label><label>Priority<select value={config.escalatePriority||"Normal"} onChange={e=>update({escalatePriority:e.target.value as AutoStepConfig["escalatePriority"]})}><option value="Normal">Normal</option><option value="Urgent">Urgent</option></select></label></>}

      {draft.kind==="end"&&<p className="empty-hint">This block ends the flow. The next message the customer sends starts the automation again from the top.</p>}

      {(draft.kind==="aiReply"||draft.kind==="aiAction")&&<>
        <p className="empty-hint" style={{margin:"8px 0 4px"}}>This block hands the conversation to your real AI assistant. Optionally add one or more &quot;Collect &amp; Link&quot; flows — each is a distinct kind of request with its own fields, link, and items.</p>
        {collectFlows.map(flow=><div key={flow.id} style={{border:"1px solid var(--line)",borderRadius:"8px",padding:"12px",marginBottom:"12px"}}>
          <label>Flow name<input placeholder="e.g. Room booking" value={flow.name} onChange={e=>updateFlow(flow.id,{name:e.target.value})}/></label>
          <label>Fields to collect, in order
            <div className="flow-options-list">
              {flow.fields.map((f,idx)=><div className="flow-option-row" key={idx}>
                <input placeholder="Field key (e.g. arrival)" value={f.key} onChange={e=>updateField(flow.id,idx,{key:e.target.value})}/>
                <input placeholder="Question to ask" value={f.label} onChange={e=>updateField(flow.id,idx,{label:e.target.value})}/>
                <button type="button" onClick={()=>removeField(flow.id,idx)}>×</button>
              </div>)}
            </div>
            <button type="button" className="secondary-btn" onClick={()=>addField(flow.id)}>＋ Add field</button>
          </label>
          <label>Link template — use {"{key}"} placeholders matching the field keys above
            <input value={flow.urlTemplate} onChange={e=>updateFlow(flow.id,{urlTemplate:e.target.value})} placeholder="https://example.com/book?arrival={arrival}&rooms={rooms}"/>
          </label>
          <label>Catalog items for this flow
            <div className="parameter-list">
              {items.map(it=><label key={it.id} style={{display:"flex",gap:"0.4rem",alignItems:"center"}}><input type="checkbox" checked={(flow.itemIds||[]).includes(it.id)} onChange={()=>toggleFlowItem(flow.id,it.id)}/> {it.name}</label>)}
              {!items.length&&<small className="empty-hint">No items in your catalog yet — add some in the Items tab.</small>}
            </div>
          </label>
          {!!flow.urlTemplate&&<label>Test this link — fill in sample values, then preview the real destination
            <div className="flow-options-list">
              {flow.fields.map(f=>f.key?<div className="flow-option-row" key={f.key}>
                <span style={{minWidth:"90px"}}>{f.key}</span>
                <input placeholder="sample value" value={testValues[flow.id]?.[f.key]||""} onChange={e=>setTestValues({...testValues,[flow.id]:{...(testValues[flow.id]||{}),[f.key]:e.target.value}})}/>
              </div>:null)}
            </div>
            <button type="button" className="secondary-btn" onClick={()=>runTestLink(flow.id,flow.urlTemplate)}>▷ Test this link</button>
            {testUrl[flow.id]&&<small style={{display:"block",marginTop:"6px",wordBreak:"break-all"}}>Opened: {testUrl[flow.id]}</small>}
            {testError[flow.id]&&<small style={{display:"block",marginTop:"6px",color:"#b3261e"}}>{testError[flow.id]}</small>}
          </label>}
          <button type="button" className="danger-btn" style={{marginTop:"8px"}} onClick={()=>removeFlow(flow.id)}>🗑 Remove this flow</button>
        </div>)}
        <button type="button" className="secondary-btn" onClick={addFlow}>＋ Add a request type (flow)</button>
      </>}

      {draft.kind!=="buttons"&&draft.kind!=="split"&&draft.kind!=="end"&&<label style={{marginTop:"10px"}}>After this block, go to<div>{targetPicker(draft.next??null,id=>setDraft({...draft,next:id}))}</div></label>}
    </div>
    <div className="modal-actions">
      {onDelete&&<button className="danger-btn" style={{marginRight:"auto"}} onClick={onDelete}>🗑 Delete block</button>}
      <button className="secondary-btn" onClick={onClose}>Cancel</button>
      <button className="primary" onClick={save}>Save changes</button>
    </div>
  </div></div>;
}

// ── Flows: reusable Items catalog + predefined (non-AI) step-by-step conversation builder ──

type CatalogItem={id:string;name:string;title:string;description:string;price:number;currency:string;imageUrl:string;externalLink:string};
type FlowOption={id:string;label:string;next:string|null};
type FlowStepType="message"|"buttons"|"text_input"|"number_input"|"date_input"|"yesno"|"items"|"summary"|"end";
type FlowStep={id:string;type:FlowStepType;prompt:string;variableName?:string;options?:FlowOption[];itemIds?:string[];next?:string|null};
type FlowDef={id:string;name:string;triggerText:string;status:"draft"|"active";startStepId:string;steps:FlowStep[];createdAt?:string;updatedAt?:string};
type FlowOutMessage={type:"text";text:string}|{type:"buttons";text:string;options:{label:string}[]}|{type:"items";text?:string;items:CatalogItem[]};

const STEP_TYPE_LABELS:Record<FlowStepType,string>={message:"Message",buttons:"Buttons",text_input:"Question",number_input:"Question",date_input:"Question",yesno:"Yes / No",items:"Show items",summary:"Summary",end:"End flow"};
const BRANCHING_TYPES:FlowStepType[]=["buttons","yesno"];
const QUESTION_TYPES:FlowStepType[]=["text_input","number_input","date_input"];
const QUESTION_TYPE_LABELS:Record<string,string>={text_input:"Any text",number_input:"Number",date_input:"Date"};
// The palette shown when inserting a new step — a small, friendly set of building blocks rather
// than a long dropdown of every internal step type.
const STEP_PALETTE:{type:FlowStepType;label:string;icon:string}[]=[
  {type:"message",label:"Message",icon:"💬"},
  {type:"text_input",label:"Question",icon:"❓"},
  {type:"buttons",label:"Buttons",icon:"🔘"},
  {type:"yesno",label:"Yes / No",icon:"✅"},
  {type:"items",label:"Show items",icon:"🗂"},
  {type:"summary",label:"Summary",icon:"📋"},
  {type:"end",label:"End flow",icon:"⏹"},
];

function newStep(type:FlowStepType="message"):FlowStep{
  const id=crypto.randomUUID();
  if(type==="buttons")return {id,type,prompt:"",options:[{id:crypto.randomUUID(),label:"Option 1",next:null},{id:crypto.randomUUID(),label:"Option 2",next:null}]};
  if(type==="yesno")return {id,type,prompt:"",options:[{id:crypto.randomUUID(),label:"Yes",next:null},{id:crypto.randomUUID(),label:"No",next:null}]};
  if(type==="items")return {id,type,prompt:"",itemIds:[]};
  return {id,type,prompt:"",next:null};
}

function Flows({notify}:{notify:(s:string)=>void}){
  const [tab,setTab]=useState<"flows"|"items">("flows");
  const [items,setItems]=useState<CatalogItem[]>([]);
  const [flows,setFlowsList]=useState<FlowDef[]>([]);
  const [loading,setLoading]=useState(true);
  const [editingFlow,setEditingFlow]=useState<FlowDef|null>(null);
  const token=useAuthToken();

  const load=async()=>{
    if(!token){setLoading(false);return}
    setLoading(true);
    try{
      const [ir,fr]=await Promise.all([fetch(metaApi("/api/items"),{headers:authHeaders(token)}),fetch(metaApi("/api/flows"),{headers:authHeaders(token)})]);
      const [id,fd]=await Promise.all([ir.json(),fr.json()]) as [{items?:CatalogItem[]},{flows?:FlowDef[]}];
      setItems(id.items||[]);setFlowsList(fd.flows||[]);
    }catch{}
    finally{setLoading(false)}
  };
  useEffect(()=>{load()},[token]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveItem=async(item:Partial<CatalogItem>&{id?:string})=>{
    if(!token)return;
    const isNew=!item.id;
    const url=isNew?"/api/items":`/api/items/${item.id}`;
    const response=await fetch(metaApi(url),{method:isNew?"POST":"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify(item)});
    const result=await response.json() as {item?:CatalogItem;error?:string};
    if(!response.ok||!result.item){notify(result.error||"Could not save item.");return}
    setItems(isNew?[result.item,...items]:items.map(i=>i.id===result.item!.id?result.item!:i));
    notify(isNew?"Item created":"Item saved");
  };
  const deleteItem=async(item:CatalogItem)=>{
    if(!token)return;
    if(!window.confirm(`Delete "${item.name}"? Flows using it will show it as missing.`))return;
    await fetch(metaApi(`/api/items/${item.id}`),{method:"DELETE",headers:authHeaders(token)});
    setItems(items.filter(i=>i.id!==item.id));
    notify("Item deleted");
  };

  const saveFlow=async(flow:FlowDef)=>{
    if(!token)return;
    const isNew=!flow.id;
    const url=isNew?"/api/flows":`/api/flows/${flow.id}`;
    const response=await fetch(metaApi(url),{method:isNew?"POST":"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify(flow)});
    const result=await response.json() as {flow?:FlowDef;error?:string};
    if(!response.ok||!result.flow){notify(result.error||"Could not save flow.");return}
    setFlowsList(isNew?[result.flow,...flows]:flows.map(f=>f.id===result.flow!.id?result.flow!:f));
    setEditingFlow(null);
    notify(isNew?"Flow created":"Flow saved");
  };
  const deleteFlow=async(flow:FlowDef)=>{
    if(!token)return;
    if(!window.confirm(`Delete the "${flow.name}" flow?`))return;
    await fetch(metaApi(`/api/flows/${flow.id}`),{method:"DELETE",headers:authHeaders(token)});
    setFlowsList(flows.filter(f=>f.id!==flow.id));
    notify("Flow deleted");
  };
  const toggleFlowStatus=async(flow:FlowDef)=>{
    const status=flow.status==="active"?"draft":"active";
    await saveFlow({...flow,status});
  };

  if(editingFlow)return <FlowEditor flow={editingFlow} items={items} onCancel={()=>setEditingFlow(null)} onSave={saveFlow} token={token}/>;

  return <>
    <PageHeader title="Flows" description="Predefined, button-driven conversations — no AI required — plus the AI assistant can suggest from the same item catalog." action={tab==="flows"?<button className="primary" onClick={()=>setEditingFlow({id:"",name:"New flow",triggerText:"",status:"draft",startStepId:"",steps:[]})}>＋ New flow</button>:undefined}/>
    <div className="settings-layout"><aside><button className={tab==="flows"?"active":""} onClick={()=>setTab("flows")}>Flows</button><button className={tab==="items"?"active":""} onClick={()=>setTab("items")}>Items catalog</button></aside><section className="subscription-content">
      {loading?<p className="empty-hint">Loading…</p>:tab==="flows"?<>
        {!flows.length?<div className="empty-state"><span>⑃</span><h3>No flows yet</h3><p>Create a predefined, step-by-step conversation like the recording — dates, choices, an items carousel — no AI needed.</p></div>:
        <div className="flow-card-grid">{flows.map(f=><div key={f.id} className="flow-card">
          <div className="flow-card-top"><div className="flow-card-icon">⑃</div><span className={`flow-status-pill ${f.status==="active"?"is-active":"is-draft"}`}>{f.status==="active"?"Active":"Draft"}</span></div>
          <div><div className="flow-card-name">{f.name}</div><div className="flow-card-category">{f.triggerText?`Starts on "${f.triggerText}"`:"No trigger phrase set yet"}</div></div>
          <div className="flow-card-desc">{f.steps.length} step{f.steps.length===1?"":"s"} · {f.steps.filter(s=>BRANCHING_TYPES.includes(s.type)).length} decision point{f.steps.filter(s=>BRANCHING_TYPES.includes(s.type)).length===1?"":"s"}</div>
          <div className="flow-card-line">{f.status==="active"?"Live for visitors now":"Not shown to visitors yet"}</div>
          <div className="flow-card-actions">
            <button className="flow-card-btn-outline" onClick={()=>toggleFlowStatus(f)}>{f.status==="active"?"Set draft":"Activate"}</button>
            <button className="flow-card-btn-outline" onClick={()=>setEditingFlow(f)}>Edit flow →</button>
          </div>
          <button className="flow-card-delete" onClick={()=>deleteFlow(f)} title="Delete flow">×</button>
        </div>)}</div>}
      </>:<ItemsCatalog items={items} onSave={saveItem} onDelete={deleteItem}/>}
    </section></div>
  </>;
}

type ItemDraft={name:string;title:string;description:string;price:number;currency:string;imageUrl:string;externalLink:string};
const EMPTY_ITEM_DRAFT:ItemDraft={name:"",title:"",description:"",price:0,currency:"AED",imageUrl:"",externalLink:""};

function ItemForm({draft,setDraft,onSave,onCancel,saveLabel}:{draft:ItemDraft;setDraft:(d:ItemDraft)=>void;onSave:()=>void;onCancel:()=>void;saveLabel:string}){
  return <div className="flow-item-form">
    <div className="form-grid">
      <label>Name<input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="e.g. Deluxe Twin Room" autoFocus/></label>
      <label>Display title<input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} placeholder="Shown to visitors"/></label>
    </div>
    <div className="form-grid">
      <label>Price<input type="number" min="0" value={draft.price} onChange={e=>setDraft({...draft,price:Number(e.target.value)})}/></label>
      <label>Currency<input value={draft.currency} onChange={e=>setDraft({...draft,currency:e.target.value.toUpperCase()})} placeholder="AED"/></label>
    </div>
    <label className="full-label">Image URL<input value={draft.imageUrl} onChange={e=>setDraft({...draft,imageUrl:e.target.value})} placeholder="https://…"/></label>
    <label className="full-label">Link (opens when a visitor taps this item)<input value={draft.externalLink} onChange={e=>setDraft({...draft,externalLink:e.target.value})} placeholder="https://…"/></label>
    <div className="wizard-actions"><button className="secondary-btn" onClick={onCancel}>Cancel</button><button className="primary" onClick={onSave}>{saveLabel}</button></div>
  </div>;
}

function ItemsCatalog({items,onSave,onDelete}:{items:CatalogItem[];onSave:(item:Partial<CatalogItem>&{id?:string})=>void;onDelete:(item:CatalogItem)=>void}){
  const [showNew,setShowNew]=useState(false);
  const [draft,setDraft]=useState<ItemDraft>(EMPTY_ITEM_DRAFT);
  const [editingId,setEditingId]=useState<string|null>(null);
  const [editDraft,setEditDraft]=useState<ItemDraft>(EMPTY_ITEM_DRAFT);

  const startEdit=(item:CatalogItem)=>{setEditingId(item.id);setShowNew(false);setEditDraft({name:item.name,title:item.title,description:item.description,price:item.price,currency:item.currency,imageUrl:item.imageUrl,externalLink:item.externalLink})};
  const create=()=>{if(!draft.name.trim())return;onSave(draft);setDraft(EMPTY_ITEM_DRAFT);setShowNew(false)};

  return <div>
    {!items.length&&!showNew&&<div className="empty-state"><span>▤</span><h3>No items yet</h3><p>Add rooms, products, or anything else your flows should offer.</p></div>}
    {items.length>0&&<div className="action-list">{items.map(item=>editingId===item.id?
      <article key={item.id} className="flow-item-editing"><ItemForm draft={editDraft} setDraft={setEditDraft} onSave={()=>{onSave({id:item.id,...editDraft});setEditingId(null)}} onCancel={()=>setEditingId(null)} saveLabel="Save item"/></article>
      :<article key={item.id}>
        {item.imageUrl?<img src={item.imageUrl} alt="" className="flow-item-thumb"/>:<span className="flow-item-thumb placeholder">▤</span>}
        <div><div className="action-name"><strong>{item.name}</strong>{item.price>0&&<b>{item.currency} {item.price}</b>}</div>
          <p>{item.title||"No display title set"}</p>
          {item.externalLink&&<small><a href={item.externalLink} target="_blank" rel="noreferrer">{item.externalLink} ↗</a></small>}</div>
        <div className="action-buttons"><button onClick={()=>startEdit(item)}>Edit</button><button onClick={()=>onDelete(item)}>Delete</button></div>
      </article>)}</div>}

    {showNew&&<div className="data-card" style={{padding:"1.25rem",marginTop:"1rem"}}><h3>New item</h3><ItemForm draft={draft} setDraft={setDraft} onSave={create} onCancel={()=>setShowNew(false)} saveLabel="Create item"/></div>}
    {!showNew&&<button className="primary" style={{marginTop:"1rem"}} onClick={()=>{setShowNew(true);setEditingId(null)}}>＋ Add item</button>}
  </div>;
}

function FlowEditor({flow,items,onCancel,onSave,token}:{flow:FlowDef;items:CatalogItem[];onCancel:()=>void;onSave:(flow:FlowDef)=>void;token:string|null}){
  const [name,setName]=useState(flow.name);
  const [triggerText,setTriggerText]=useState(flow.triggerText);
  const [status,setStatus]=useState<"draft"|"active">(flow.status);
  const [steps,setSteps]=useState<FlowStep[]>(flow.steps.length?flow.steps:[newStep("message")]);

  // The first step in the list is always where the flow starts — reordering IS how you change
  // the start step, so there's no separate "start step" control to keep in sync.
  const startStepId=steps[0]?.id||"";

  const updateStep=(id:string,patch:Partial<FlowStep>)=>setSteps(steps.map(s=>s.id===id?{...s,...patch}:s));
  const changeStepType=(id:string,type:FlowStepType)=>setSteps(steps.map(s=>s.id===id?{...newStep(type),id,prompt:s.prompt,variableName:QUESTION_TYPES.includes(type)&&QUESTION_TYPES.includes(s.type)?s.variableName:undefined}:s));
  const insertStepAt=(index:number,type:FlowStepType)=>{const next=[...steps];next.splice(index,0,newStep(type));setSteps(next);setInsertAt(null)};
  const removeStep=(id:string)=>{if(steps.length<=1)return;setSteps(steps.filter(s=>s.id!==id))};
  const moveStep=(id:string,dir:-1|1)=>{const idx=steps.findIndex(s=>s.id===id);const swapIdx=idx+dir;if(swapIdx<0||swapIdx>=steps.length)return;const next=[...steps];[next[idx],next[swapIdx]]=[next[swapIdx],next[idx]];setSteps(next)};
  const [insertAt,setInsertAt]=useState<number|null>(null);

  const addOption=(stepId:string)=>updateStep(stepId,{options:[...(steps.find(s=>s.id===stepId)?.options||[]),{id:crypto.randomUUID(),label:"New option",next:null}]});
  const updateOption=(stepId:string,optId:string,patch:Partial<FlowOption>)=>{const step=steps.find(s=>s.id===stepId);if(!step)return;updateStep(stepId,{options:(step.options||[]).map(o=>o.id===optId?{...o,...patch}:o)})};
  const removeOption=(stepId:string,optId:string)=>{const step=steps.find(s=>s.id===stepId);if(!step||(step.options||[]).length<=1)return;updateStep(stepId,{options:(step.options||[]).filter(o=>o.id!==optId)})};

  const save=()=>{
    if(!name.trim()){alert("Give this flow a name.");return}
    onSave({...flow,name:name.trim(),triggerText:triggerText.trim(),status,startStepId,steps});
  };

  const InsertSlot=({index}:{index:number})=>insertAt===index?
    <div className="flow-insert-palette">
      {STEP_PALETTE.map(p=><button key={p.type} onClick={()=>insertStepAt(index,p.type)}><span>{p.icon}</span>{p.label}</button>)}
      <button className="flow-insert-cancel" onClick={()=>setInsertAt(null)}>×</button>
    </div>
    :<button className="flow-insert-slot" onClick={()=>setInsertAt(index)}><span>＋</span></button>;

  return <>
    <PageHeader title={flow.id?"Edit flow":"New flow"} description="A step-by-step conversation — no AI needed. Click + anywhere to add a step; steps just run in order unless a button branches them." action={<div style={{display:"flex",gap:"0.5rem"}}><button className="secondary-btn" onClick={onCancel}>Cancel</button><button className="primary" onClick={save}>Save flow</button></div>}/>
    <div className="flow-builder-grid">
      <div>
        <div className="data-card flow-settings-card">
          <div className="form-grid">
            <label>Flow name<input value={name} onChange={e=>setName(e.target.value)}/></label>
            <label>Status<select value={status} onChange={e=>setStatus(e.target.value as "draft"|"active")}><option value="draft">Draft</option><option value="active">Active</option></select></label>
          </div>
          <label className="full-label">Starts when a visitor's message contains<input value={triggerText} onChange={e=>setTriggerText(e.target.value)} placeholder='e.g. "Book a room now"'/></label>
        </div>

        <div className="flow-steps-list">
          <InsertSlot index={0}/>
          {steps.map((step,i)=><div key={step.id}>
          <div className={`flow-step-card${BRANCHING_TYPES.includes(step.type)?" is-branch":step.type==="end"?" is-end":""}`}>
            <div className="flow-step-head">
              <span className="flow-step-badge">{i+1}</span>
              <span className="flow-step-type-label">{STEP_TYPE_LABELS[step.type]}</span>
              <div className="row-actions"><button title="Move up" onClick={()=>moveStep(step.id,-1)} disabled={i===0}>↑</button><button title="Move down" onClick={()=>moveStep(step.id,1)} disabled={i===steps.length-1}>↓</button><button title="Delete step" onClick={()=>removeStep(step.id)} disabled={steps.length<=1}>×</button></div>
            </div>

            {step.type!=="end"&&<label className="flow-field">Message<textarea value={step.prompt} onChange={e=>updateStep(step.id,{prompt:e.target.value})} placeholder={step.type==="summary"?"e.g. Check-in {{date}} for {{nights}} night(s). Is that correct?":"What should the visitor see?"}/>{step.type==="summary"&&<small className="flow-hint">Use <code>{"{{variableName}}"}</code> to insert an earlier answer.</small>}</label>}

            {QUESTION_TYPES.includes(step.type)&&<div className="flow-format-toggle">
              {QUESTION_TYPES.map(t=><button key={t} className={step.type===t?"active":""} onClick={()=>changeStepType(step.id,t)}>{QUESTION_TYPE_LABELS[t]}</button>)}
            </div>}

            {BRANCHING_TYPES.includes(step.type)&&<div className="flow-options-list">
              {(step.options||[]).map(opt=><div key={opt.id} className="flow-option-row">
                <input value={opt.label} onChange={e=>updateOption(step.id,opt.id,{label:e.target.value})} placeholder="Button label" disabled={step.type==="yesno"}/>
                <span className="flow-arrow">→</span>
                <select value={opt.next||""} onChange={e=>updateOption(step.id,opt.id,{next:e.target.value||null})}>
                  <option value="">— End —</option>
                  {steps.filter(s=>s.id!==step.id).map(s=><option key={s.id} value={s.id}>Step {steps.indexOf(s)+1} · {STEP_TYPE_LABELS[s.type]}</option>)}
                </select>
                {step.type==="buttons"&&<button title="Remove option" onClick={()=>removeOption(step.id,opt.id)} disabled={(step.options||[]).length<=1}>×</button>}
              </div>)}
              {step.type==="buttons"&&<button className="secondary-btn" onClick={()=>addOption(step.id)}>＋ Add option</button>}
            </div>}

            {step.type==="items"&&<label className="flow-field">Items to show<div className="parameter-list">{items.map(it=><label key={it.id} style={{display:"flex",gap:"0.4rem",alignItems:"center"}}><input type="checkbox" checked={(step.itemIds||[]).includes(it.id)} onChange={()=>{const cur=step.itemIds||[];updateStep(step.id,{itemIds:cur.includes(it.id)?cur.filter(x=>x!==it.id):[...cur,it.id]})}}/> {it.name}</label>)}{!items.length&&<small className="empty-hint">No items in your catalog yet — add some in the Items tab.</small>}</div></label>}

            {QUESTION_TYPES.includes(step.type)&&<label className="flow-field"><span>Save reply as <small>(optional — needed if you'll reference it in a Summary step)</small></span><input value={step.variableName||""} onChange={e=>updateStep(step.id,{variableName:e.target.value})} placeholder="e.g. checkInDate"/></label>}
          </div>
          <InsertSlot index={i+1}/>
          </div>)}
        </div>
      </div>

      <FlowTestPanel flow={{startStepId,steps}} token={token}/>
    </div>
  </>;
}

function FlowTestPanel({flow,token}:{flow:{startStepId:string;steps:FlowStep[]};token:string|null}){
  const [log,setLog]=useState<{from:"bot"|"me";message:FlowOutMessage}[]>([]);
  const [currentStepId,setCurrentStepId]=useState<string|null>(null);
  const [variables,setVariables]=useState<Record<string,string>>({});
  const [input,setInput]=useState("");
  const [ended,setEnded]=useState(false);
  const [busy,setBusy]=useState(false);

  const call=async(message:string,reset:boolean)=>{
    if(!token)return;
    setBusy(true);
    try{
      const response=await fetch(metaApi("/api/flows/test"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({flow,currentStepId,variables,message,reset})});
      const result=await response.json() as {messages?:FlowOutMessage[];currentStepId?:string|null;variables?:Record<string,string>;ended?:boolean;error?:string};
      if(!response.ok){setLog(l=>[...l,{from:"bot",message:{type:"text",text:result.error||"Test failed."}}]);setBusy(false);return}
      setLog(l=>[...l,...(result.messages||[]).map(m=>({from:"bot" as const,message:m}))]);
      setCurrentStepId(result.currentStepId??null);
      setVariables(result.variables||{});
      setEnded(Boolean(result.ended));
    }catch{}
    finally{setBusy(false)}
  };

  const restart=()=>{setLog([]);setCurrentStepId(null);setVariables({});setEnded(false);call("",true)};
  const send=(text:string)=>{if(!text.trim())return;setLog(l=>[...l,{from:"me",message:{type:"text",text}}]);setInput("");call(text,false)};

  return <div className="data-card flow-test-panel">
    <div className="flow-test-head"><strong>Test this flow</strong><button className="secondary-btn" onClick={restart} disabled={busy}>{log.length?"Restart":"Start test"}</button></div>
    <div className="flow-test-body">
      {!log.length&&<p className="empty-hint">Click "Start test" to try this flow exactly as a visitor would, using your steps above (even unsaved changes).</p>}
      {log.map((entry,i)=><div key={i} className={entry.from==="me"?"flow-test-msg me":"flow-test-msg bot"}>
        {entry.message.type==="text"&&<p>{entry.message.text}</p>}
        {entry.message.type==="buttons"&&<>{entry.message.text&&<p>{entry.message.text}</p>}<div className="flow-test-buttons">{entry.message.options.map((o,oi)=><button key={oi} onClick={()=>send(o.label)} disabled={busy||i!==log.length-1}>{o.label}</button>)}</div></>}
        {entry.message.type==="items"&&<>{entry.message.text&&<p>{entry.message.text}</p>}<div className="flow-test-items">{entry.message.items.map((it,ii)=><div key={ii} className="flow-test-item"><strong>{it.title||it.name}</strong><small>{it.price?`${it.currency} ${it.price}`:""}</small></div>)}</div></>}
      </div>)}
      {ended&&log.length>0&&<p className="empty-hint">— flow ended —</p>}
    </div>
    <div className="flow-test-input"><input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send(input)} placeholder="Type a reply…" disabled={busy||!log.length||ended}/><button className="primary" onClick={()=>send(input)} disabled={busy||!log.length||ended}>Send</button></div>
  </div>;
}

type Submission={id:number;actionName:string;channel:string;data:Record<string,unknown>;createdAt:string;updatedAt:string;source:string;status:string;priority:string;segment:string};
const LEAD_SOURCES=["Website","Referral","Event"];
const LEAD_STATUSES=["New","Contacted","Qualified","Nurture","Closed-Lost"];
const LEAD_PRIORITIES=["Hot","Warm","Cold"];
const LEAD_SEGMENTS=["Enterprise","SMB"];
const channelLabel=(channel:string)=>({test_studio_chat:"Test Studio (chat)",test_studio_voice:"Test Studio (voice)",widget:"Web chat widget"} as Record<string,string>)[channel]||channel;

function Leads({notify}:{notify:(s:string)=>void}){
  const token=useAuthToken();
  const [submissions,setSubmissions]=useState<Submission[]>([]);
  const [loading,setLoading]=useState(true);
  const [sourceFilter,setSourceFilter]=useState("All");
  const [statusFilter,setStatusFilter]=useState("All");
  const [priorityFilter,setPriorityFilter]=useState("All");
  const [segmentFilter,setSegmentFilter]=useState("All");
  const load=async()=>{
    if(!token){setLoading(false);return}
    setLoading(true);
    try{
      const response=await fetch(metaApi("/api/leads"),{headers:authHeaders(token)});
      const result=await response.json() as {submissions?:Submission[];error?:string};
      if(!response.ok)throw new Error(result.error||"Could not load captured leads.");
      setSubmissions(result.submissions||[]);
    }catch(error){notify(error instanceof Error?error.message:"Could not load captured leads.")}
    finally{setLoading(false)}
  };
  useEffect(()=>{load()},[token]);
  const remove=async(id:number)=>{
    if(!window.confirm("Delete this captured entry?"))return;
    try{
      const response=await fetch(metaApi(`/api/leads/${id}`),{method:"DELETE",headers:authHeaders(token)});
      if(!response.ok)throw new Error("Could not delete that entry.");
      setSubmissions(current=>current.filter(s=>s.id!==id));
      notify("Entry deleted");
    }catch(error){notify(error instanceof Error?error.message:"Could not delete that entry.")}
  };
  const updateTag=async(id:number,field:"source"|"status"|"priority"|"segment",value:string)=>{
    const previous=submissions;
    setSubmissions(current=>current.map(s=>s.id===id?{...s,[field]:value}:s));
    try{
      const response=await fetch(metaApi(`/api/leads/${id}`),{method:"PATCH",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({[field]:value})});
      if(!response.ok)throw new Error();
    }catch{setSubmissions(previous);notify(`Could not update ${field}.`)}
  };
  const exportCsv=()=>{
    const fieldNames=[...new Set(submissions.flatMap(s=>Object.keys(s.data)))];
    const header=["Captured at","Action","Channel","Source","Status","Priority","Segment",...fieldNames];
    const rows=submissions.map(s=>[s.createdAt,s.actionName,channelLabel(s.channel),s.source,s.status,s.priority,s.segment,...fieldNames.map(f=>String(s.data[f]??""))]);
    const csv=[header,...rows].map(row=>row.map(cell=>`"${String(cell).replace(/"/g,'""')}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="qpy-engage-leads.csv";a.click();
    notify("Leads exported");
  };
  const visible=submissions.filter(s=>
    (sourceFilter==="All"||s.source===sourceFilter)&&
    (statusFilter==="All"||s.status===statusFilter)&&
    (priorityFilter==="All"||s.priority===priorityFilter)&&
    (segmentFilter==="All"||s.segment===segmentFilter)
  );
  return <><PageHeader title="Captured leads" description="Data your AI actions have collected from real conversations, saved automatically." action={<div className="header-buttons"><button className="secondary-btn" onClick={load}>↻ Refresh</button><button className="primary" disabled={!submissions.length} onClick={exportCsv}>↓ Export CSV</button></div>}/>
  {!loading&&submissions.length>0&&<div className="leads-filters">
    <label>Source<select value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}><option>All</option>{LEAD_SOURCES.map(o=><option key={o}>{o}</option>)}</select></label>
    <label>Status<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option>All</option>{LEAD_STATUSES.map(o=><option key={o}>{o}</option>)}</select></label>
    <label>Priority<select value={priorityFilter} onChange={e=>setPriorityFilter(e.target.value)}><option>All</option>{LEAD_PRIORITIES.map(o=><option key={o}>{o}</option>)}</select></label>
    <label>Segment<select value={segmentFilter} onChange={e=>setSegmentFilter(e.target.value)}><option>All</option>{LEAD_SEGMENTS.map(o=><option key={o}>{o}</option>)}</select></label>
    {(sourceFilter!=="All"||statusFilter!=="All"||priorityFilter!=="All"||segmentFilter!=="All")&&<button className="text-action" onClick={()=>{setSourceFilter("All");setStatusFilter("All");setPriorityFilter("All");setSegmentFilter("All")}}>Clear filters</button>}
  </div>}
  {loading?<p className="empty-hint">Loading…</p>:!submissions.length?<div className="empty-state"><span>⚑</span><h3>No captured leads yet</h3><p>When a customer gives details to an AI action (like a callback request), it's saved here automatically — from Test Studio and your public web chat widget. This is a local copy kept even if the action's own webhook fails.</p></div>:!visible.length?<div className="empty-state"><span>⚑</span><h3>No leads match these filters</h3><p>Try clearing a filter to see more captured leads.</p></div>:
  <div className="data-card"><div className="table-scroll"><table><thead><tr><th>Captured</th><th>Action</th><th>Source</th><th>Status</th><th>Priority</th><th>Segment</th><th>Channel</th><th>Details</th><th/></tr></thead><tbody>{visible.map(s=><tr key={s.id}><td>{new Date(s.createdAt).toLocaleString()}{s.updatedAt&&s.updatedAt!==s.createdAt&&<small><br/>Updated {new Date(s.updatedAt).toLocaleString()}</small>}</td><td><strong>{s.actionName}</strong>{s.status==="New"&&<span className="new-badge">New</span>}</td><td><select value={s.source} onChange={e=>updateTag(s.id,"source",e.target.value)}><option value="">—</option>{LEAD_SOURCES.map(o=><option key={o}>{o}</option>)}</select></td><td><select className={`status-select status-${s.status.toLowerCase().replace(/[^a-z]/g,"-")}`} value={s.status} onChange={e=>updateTag(s.id,"status",e.target.value)}>{LEAD_STATUSES.map(o=><option key={o}>{o}</option>)}</select></td><td><select className={`priority-select priority-${s.priority.toLowerCase()}`} value={s.priority} onChange={e=>updateTag(s.id,"priority",e.target.value)}><option value="">—</option>{LEAD_PRIORITIES.map(o=><option key={o}>{o}</option>)}</select></td><td><select value={s.segment} onChange={e=>updateTag(s.id,"segment",e.target.value)}><option value="">—</option>{LEAD_SEGMENTS.map(o=><option key={o}>{o}</option>)}</select></td><td>{channelLabel(s.channel)}</td><td className="lead-details">{Object.entries(s.data).map(([k,v])=><div key={k}><small>{k}:</small> {String(v)}</div>)}</td><td><button className="dots" onClick={()=>remove(s.id)}>Delete</button></td></tr>)}</tbody></table></div></div>}
  </>;
}

function Knowledge({sources,setSources,onAdd,notify}:{sources:Source[];setSources:(v:Source[]|((current:Source[])=>Source[]))=>void;onAdd:()=>void;notify:(s:string)=>void}){const total=sources.reduce((n,s)=>n+s.pages,0);const [question,setQuestion]=useState("");const [answer,setAnswer]=useState("");const [syncing,setSyncing]=useState(false);const token=useAuthToken();const sync=async()=>{
    const websiteSources=sources.filter(s=>s.type==="Website");
    if(!websiteSources.length){notify("No website sources to re-sync — only websites can be re-fetched.");return}
    setSyncing(true);
    setSources(current=>current.map(s=>s.type==="Website"?{...s,status:"Syncing"}:s));
    notify("Re-fetching website sources…");
    await Promise.all(websiteSources.map(async source=>{
      try{
        const response=await fetch(metaApi("/api/knowledge/fetch-website"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({url:source.name,sourceId:source.id})});
        const result=await response.json() as {fetched?:boolean;charCount?:number};
        const pages=result.fetched?Math.max(1,Math.round((result.charCount||0)/2000)):0;
        setSources(current=>current.map(s=>s.id===source.id?{...s,pages,status:result.fetched?"Ready":"Failed"}:s));
      }catch{
        setSources(current=>current.map(s=>s.id===source.id?{...s,pages:0,status:"Failed"}:s));
      }
    }));
    setSyncing(false);
    notify("Website sources re-synced");
  };const ask=()=>{if(!question.trim())return;setAnswer(`Based on ${sources.length} connected sources: UAE delivery normally takes 1–3 business days, with free standard delivery on qualifying orders. I would hand off if the customer asks about an exception not covered in your policies.`);notify("Knowledge answer generated")};return <><PageHeader title="Knowledge" description="Train your AI using your website, documents, and FAQs." action={<button className="primary" onClick={onAdd}>＋ Add source</button>}/><div className="knowledge-stats"><article><span>◇</span><div><strong>{sources.length}</strong><small>Connected sources</small></div></article><article><span>▤</span><div><strong>{total.toLocaleString()}</strong><small>Pages indexed</small></div></article><article><span>✓</span><div><strong>{sources.length?"98.7%":"0%"}</strong><small>Answer coverage</small></div></article></div><div className="data-card"><div className="card-head"><div><h2>Training sources</h2><p>Content is automatically chunked, indexed, and kept up to date.</p></div><button onClick={sync} disabled={syncing}>{syncing?"Syncing…":"↻ Sync all"}</button></div><table><thead><tr><th>Source</th><th>Type</th><th>Content</th><th>Status</th><th>Last synced</th><th/></tr></thead><tbody>{sources.map(source=><tr key={source.id}><td><div className="table-title"><span>{source.type==="Website"?"⌁":"▤"}</span><strong>{source.name}</strong></div></td><td>{source.type}</td><td>{source.pages.toLocaleString()} pages</td><td><span className={`status-pill ${source.status==="Ready"?"ready":"syncing"}`}>{source.status}</span></td><td>Just now</td><td><button className="dots" onClick={()=>{if(window.confirm(`Remove ${source.name}?`)){setSources(sources.filter(s=>s.id!==source.id));notify("Source removed")}}}>Remove</button></td></tr>)}</tbody></table>{!sources.length&&<div className="empty-row">No training sources yet. Add a website, document, or FAQ.</div>}</div><div className="training-lab"><div><span>✦</span><h3>Test your AI knowledge</h3><p>Ask a question exactly as a customer would.</p><div className="test-input"><input value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>e.key==="Enter"&&ask()} placeholder="e.g. How long does delivery to Dubai take?"/><button onClick={ask}>Ask Qpy Engage</button></div>{answer&&<div className="knowledge-answer"><strong>✦ Qpy Engage answer</strong><p>{answer}</p><small>Sources: {sources.slice(0,3).map(s=>s.name).join(", ")||"No sources selected"}</small></div>}</div><aside><strong>Coverage tip</strong><p>Add policies, sizing guides, and product manuals to improve answer confidence.</p></aside></div></>}

const analyticsCompletionById:Record<number,number>={1:81,2:94,3:63,4:88};
const analyticsResponseById:Record<number,string>={1:"7s",2:"4s",3:"12s",4:"38s"};
function Analytics({automations,conversationCount,notify}:{automations:Automation[];conversationCount:number;notify:(s:string)=>void}){const [range,setRange]=useState("Last 30 days");const exportCsv=()=>{const blob=new Blob([`metric,value\nConversations,${conversationCount}`],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="qpy-engage-analytics.csv";a.click();notify("Analytics exported")};return <><PageHeader title="Analytics" description="Measure AI performance, team efficiency, and assisted revenue." action={<div className="header-buttons"><select value={range} onChange={e=>setRange(e.target.value)}><option>Last 7 days</option><option>Last 30 days</option><option>Last 90 days</option></select><button className="primary" onClick={exportCsv}>↓ Export CSV</button></div>}/><MetricCards conversationCount={conversationCount}/><div className="analytics-grid"><div className="data-card chart-card"><div className="card-head"><div><h2>Conversation volume</h2><p>{range} • AI and human responses</p></div><span className="legend"><i/>AI handled <i/>Team handled</span></div><div className="big-chart">{[42,55,49,72,64,83,78,95,88,108,92,118,111,132].map((h,i)=><div key={i}><i style={{height:`${h}px`}}/><b style={{height:`${Math.max(18,h*.32)}px`}}/></div>)}</div><div className="chart-axis"><span>Jun 18</span><span>Jun 24</span><span>Jun 30</span><span>Jul 6</span><span>Jul 17</span></div></div><div className="data-card channel-card"><div className="card-head"><div><h2>Resolution mix</h2><p>How conversations were completed</p></div></div><div className="large-donut"><div><strong>1,284</strong><small>Total</small></div></div><ul><li><i className="indigo"/>AI resolved <b>74%</b></li><li><i className="black"/>Team resolved <b>21%</b></li><li><i className="gray"/>Unresolved <b>5%</b></li></ul></div></div><div className="data-card"><div className="card-head"><div><h2>Automation performance</h2><p>Results attributed to active workflows.</p></div></div><table><thead><tr><th>Automation</th><th>Runs</th><th>Completion</th><th>Avg. response</th><th>Impact</th></tr></thead><tbody>{automations.map(a=><tr key={a.id}><td><strong>{a.title}</strong></td><td>{a.runs}</td><td>{analyticsCompletionById[a.id]??76}%</td><td>{analyticsResponseById[a.id]??"9s"}</td><td><b className="positive">{a.rate}</b></td></tr>)}</tbody></table></div></>}

function Team({members,role,onInvite,onUpdateRole,onRemove,notify}:{members:Member[];role:Member["role"];onInvite:()=>void;onUpdateRole:(email:string,role:Member["role"])=>void;onRemove:(email:string)=>void;notify:(s:string)=>void}){
  const canManage = role==="Owner"||role==="Admin";
  return <><PageHeader title="Team" description="Invite teammates and control access to customer conversations." action={<button className="primary" disabled={!canManage} onClick={onInvite}>＋ Invite teammate</button>}/><div className="team-summary"><article><strong>{members.length}</strong><span>Team members</span></article><article><strong>{members.filter(m=>m.status==="Active").length}</strong><span>Active now</span></article><article><strong>{role}</strong><span>Your role</span></article></div><div className="data-card"><table><thead><tr><th>Member</th><th>Role</th><th>Status</th><th/></tr></thead><tbody>{members.map(m=><tr key={m.id}><td><div className="member-cell"><span>{m.name.split(" ").map(x=>x[0]).join("").slice(0,2)}</span><div><strong>{m.name}</strong><small>{m.email}</small></div></div></td><td><select value={m.role} disabled={m.role==="Owner"||!canManage} onChange={e=>onUpdateRole(m.email,e.target.value as Member["role"])}>{m.role==="Owner"&&<option>Owner</option>}<option>Admin</option><option>Agent</option><option>Analyst</option></select></td><td><span className={`status-pill ${m.status==="Active"?"ready":"syncing"}`}>{m.status}</span></td><td><button className="dots" disabled={!canManage} onClick={()=>m.role==="Owner"?notify("The workspace owner cannot be removed"):onRemove(m.email)}>•••</button></td></tr>)}</tbody></table>{!members.length&&<div className="empty-row">No team members yet.</div>}</div></>}

function Settings(props:{activeTab:string;setActiveTab:(s:string)=>void;connected:boolean;onChannels:()=>void;workspaceName:string;notify:(s:string)=>void}){
  if(props.activeTab==="Credits")return <CreditsSettings activeTab={props.activeTab} setActiveTab={props.setActiveTab} notify={props.notify}/>;
  if(props.activeTab==="API & OTP")return <ApiKeysSettings activeTab={props.activeTab} setActiveTab={props.setActiveTab} connected={props.connected} onChannels={props.onChannels} notify={props.notify}/>;
  if(props.activeTab!=="Billing")return <LegacySettings {...props}/>;
  return <SubscriptionSettings activeTab={props.activeTab} setActiveTab={props.setActiveTab} notify={props.notify}/>;
}

type ApiKeyRow={id:string;name:string;keyPrefix:string;createdAt:string;lastUsedAt:string|null};
const SETTINGS_TABS=["General","AI assistant","Notifications","Billing","Credits","API & OTP"];

function ApiKeysSettings({activeTab,setActiveTab,connected,onChannels,notify}:{activeTab:string;setActiveTab:(s:string)=>void;connected:boolean;onChannels:()=>void;notify:(s:string)=>void}){
  const token=useAuthToken();
  const [keys,setKeys]=useState<ApiKeyRow[]>([]);
  const [loading,setLoading]=useState(true);
  const [authBalance,setAuthBalance]=useState<number|null>(null);
  const [newKeyName,setNewKeyName]=useState("");
  const [creating,setCreating]=useState(false);
  const [freshKey,setFreshKey]=useState<string|null>(null);

  const load=async()=>{
    if(!token){setLoading(false);return}
    setLoading(true);
    try{
      const [keysRes,creditsRes]=await Promise.all([
        fetch(metaApi("/api/api-keys"),{headers:authHeaders(token)}),
        fetch(metaApi("/api/credits"),{headers:authHeaders(token)}),
      ]);
      const keysData=await keysRes.json() as {keys?:ApiKeyRow[]};
      const creditsData=await creditsRes.json() as {balances?:Record<string,number>};
      setKeys(keysData.keys||[]);
      if(creditsData.balances)setAuthBalance(creditsData.balances.Authentication??0);
    }catch{}
    finally{setLoading(false)}
  };
  useEffect(()=>{load()},[token]);

  const createKey=async()=>{
    if(!token)return;
    setCreating(true);setFreshKey(null);
    try{
      const response=await fetch(metaApi("/api/api-keys"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({name:newKeyName.trim()||"API key"})});
      const result=await response.json() as {key?:string;error?:string};
      if(!response.ok||!result.key)throw new Error(result.error||"Could not create API key.");
      setFreshKey(result.key);setNewKeyName("");
      await load();
      notify("API key created — copy it now, it won't be shown again");
    }catch(err){notify(err instanceof Error?err.message:"Could not create API key.")}
    finally{setCreating(false)}
  };

  const revokeKey=async(key:ApiKeyRow)=>{
    if(!token)return;
    if(!window.confirm(`Revoke "${key.name}" (${key.keyPrefix}…)? Any system using it will immediately stop working.`))return;
    try{
      await fetch(metaApi(`/api/api-keys/${key.id}`),{method:"DELETE",headers:authHeaders(token)});
      await load();
      notify("API key revoked");
    }catch{notify("Could not revoke key.")}
  };

  const curlExample=`curl -X POST ${META_BACKEND_ORIGIN}/api/whatsapp/send-otp \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"to":"9715XXXXXXXX","code":"384726","templateName":"your_auth_template"}'`;

  return <><PageHeader title="Settings" description="Manage your workspace, assistant behavior, and subscription."/><div className="settings-layout"><aside>{SETTINGS_TABS.map(t=><button className={activeTab===t?"active":""} onClick={()=>setActiveTab(t)} key={t}>{t}</button>)}</aside><section className="subscription-content">
    <h2>API keys & OTP sending</h2>
    <p>Send WhatsApp verification codes (OTPs) from your own backend. Your system generates and validates the code; Qpy Engage just delivers it via your Meta-approved authentication template. Each OTP uses one Authentication message credit.</p>
    {!connected&&<div className="meta-error">⚠ No WhatsApp Business account is connected — OTP sends will fail until you connect one. <button className="text-action" onClick={onChannels}>Connect in Channels →</button></div>}
    <div className="credits-balance-card"><div><span>AUTHENTICATION CREDITS</span><strong>{loading?"—":(authBalance??0).toLocaleString()} messages</strong></div><div style={{textAlign:"right"}}><span style={{fontSize:"8px",color:"#8b929f",display:"block",marginBottom:"6px"}}>BUY MORE</span><button className="secondary-btn" onClick={()=>setActiveTab("Credits")}>Credits tab →</button></div></div>

    <div className="data-card" style={{padding:"1rem",marginBottom:"1rem"}}>
      <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Your API keys</strong>
      {loading?<p className="empty-hint">Loading…</p>:<div className="table-scroll"><table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th/></tr></thead><tbody>
        {keys.map(k=><tr key={k.id}><td>{k.name}</td><td><code>{k.keyPrefix}…</code></td><td>{new Date(k.createdAt).toLocaleDateString()}</td><td>{k.lastUsedAt?new Date(k.lastUsedAt).toLocaleDateString():"—"}</td><td><div className="row-actions"><button title="Revoke" onClick={()=>revokeKey(k)}>×</button></div></td></tr>)}
      </tbody></table>{!keys.length&&<div className="empty-row">No API keys yet. Create one below.</div>}</div>}
      <div className="inline-create-row" style={{marginTop:"0.75rem",marginBottom:0}}><input value={newKeyName} onChange={e=>setNewKeyName(e.target.value)} placeholder="Key name (e.g. Production server)"/><button className="primary" disabled={creating} onClick={createKey}>{creating?"Creating…":"Create key"}</button></div>
      {freshKey&&<div className="fresh-key-note"><strong>Copy your new key now — it won't be shown again:</strong><code>{freshKey}</code></div>}
    </div>

    <div className="data-card" style={{padding:"1rem"}}>
      <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Send an OTP from your backend</strong>
      <p className="empty-hint" style={{marginBottom:"0.5rem"}}>Your <code>templateName</code> must be an approved WhatsApp <em>authentication</em> template in Meta Business Manager. Add <code>"copyCodeButton": false</code> if your template has no copy-code button.</p>
      <pre className="code-block">{curlExample}</pre>
    </div>
  </section></div></>;
}

const MESSAGE_PACK_SIZES=[100,500,1000,5000];
const PURCHASABLE_CATEGORIES=["Marketing","Utility","Authentication","Service"];

function CreditsSettings({activeTab,setActiveTab,notify}:{activeTab:string;setActiveTab:(s:string)=>void;notify:(s:string)=>void}){
  const token=useAuthToken();
  const [balances,setBalances]=useState<Record<string,number>>({Marketing:0,Utility:0,Authentication:0,Service:0});
  const [loading,setLoading]=useState(true);
  const [pricing,setPricing]=useState<{category:string;priceUsd:number}[]>([]);
  const [plan,setPlan]=useState("Free");
  const [planLimits,setPlanLimits]=useState<Record<string,number>>({Marketing:0,Utility:0,Authentication:0,Service:0});
  const [sent,setSent]=useState<Record<string,number>>({Marketing:0,Utility:0,Authentication:0,Service:0});
  const [category,setCategory]=useState("Marketing");
  const [quantity,setQuantity]=useState(500);
  const [buying,setBuying]=useState(false);
  const tabs=["General","AI assistant","Notifications","Billing","Credits","API & OTP"];

  const load=async()=>{
    if(!token){setLoading(false);return}
    setLoading(true);
    try{
      const [creditsRes,pricingRes,planRes]=await Promise.all([
        fetch(metaApi("/api/credits"),{headers:authHeaders(token)}),
        fetch(metaApi("/api/pricing"),{headers:authHeaders(token)}),
        fetch(metaApi("/api/plan-limits"),{headers:authHeaders(token)}),
      ]);
      const creditsData=await creditsRes.json() as {balances?:Record<string,number>;sent?:Record<string,number>};
      const pricingData=await pricingRes.json() as {pricing?:{category:string;priceUsd:number}[]};
      const planData=await planRes.json() as {plan?:string;limits?:Record<string,number>};
      if(creditsData.balances)setBalances(creditsData.balances);
      if(creditsData.sent)setSent(creditsData.sent);
      setPricing(pricingData.pricing||[]);
      if(planData.plan)setPlan(planData.plan);
      if(planData.limits)setPlanLimits(planData.limits);
    }catch{}
    finally{setLoading(false)}
  };
  useEffect(()=>{load()},[token]);

  const rate=pricing.find(p=>p.category===category)?.priceUsd||0;
  const previewCost=Math.round(quantity*rate*100)/100;

  const buy=async()=>{
    if(!token)return;
    setBuying(true);
    try{
      const response=await fetch(metaApi("/api/credits/topup"),{method:"POST",headers:{"content-type":"application/json",...authHeaders(token)},body:JSON.stringify({category,messages:quantity})});
      const result=await response.json() as {balances?:Record<string,number>;error?:string};
      if(!response.ok||!result.balances)throw new Error(result.error||"Could not add message credits.");
      setBalances(result.balances);
      notify(`${quantity.toLocaleString()} ${category} messages added (demo purchase, est. value $${previewCost.toFixed(2)})`);
    }catch(err){notify(err instanceof Error?err.message:"Could not add message credits.")}
    finally{setBuying(false)}
  };


  return <><PageHeader title="Settings" description="Manage your workspace, assistant behavior, and subscription."/><div className="settings-layout"><aside>{tabs.map(t=><button className={activeTab===t?"active":""} onClick={()=>setActiveTab(t)} key={t}>{t}</button>)}</aside><section className="subscription-content">
    <h2>WhatsApp message credits</h2>
    <p>Your plan includes a set number of free messages per category each month, topped up automatically. Buy more on top if you need extra — sending a campaign deducts from that category's balance, and you can't send more than you have. Purchases here are a demo — no real payment is processed yet.</p>
    <div className="table-scroll"><div className="data-card" style={{padding:"1rem",marginBottom:"1rem"}}>
      <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Message balances <span style={{fontWeight:400,color:"#8b929f"}}>— {plan} plan</span></strong>
      <table><thead><tr><th>Category</th><th>Plan includes</th><th>Balance</th><th>Sent this workspace</th><th>Current rate</th></tr></thead><tbody>
        {PURCHASABLE_CATEGORIES.map(cat=><tr key={cat}><td><span className={`category-badge ${cat.toLowerCase()}`}>{cat}</span></td><td>{loading?"—":(planLimits[cat]||0).toLocaleString()}/mo</td><td>{loading?"—":(balances[cat]||0).toLocaleString()} messages</td><td>{(sent[cat]||0).toLocaleString()}</td><td>${(pricing.find(p=>p.category===cat)?.priceUsd||0).toFixed(3)}/message</td></tr>)}
      </tbody></table>
    </div></div>
    <div className="data-card" style={{padding:"1rem"}}>
      <strong style={{fontSize:"10px",display:"block",marginBottom:"0.5rem"}}>Buy messages</strong>
      <div className="form-grid"><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}>{PURCHASABLE_CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}</select></label><label>Quantity<select value={quantity} onChange={e=>setQuantity(Number(e.target.value))}>{MESSAGE_PACK_SIZES.map(q=><option key={q} value={q}>{q.toLocaleString()} messages</option>)}</select></label></div>
      <div className="credits-topup-row"><button className="primary" disabled={buying} onClick={buy}>{buying?"Adding…":`Buy ${quantity.toLocaleString()} ${category} messages — est. $${previewCost.toFixed(2)} (demo)`}</button></div>
      <div className="demo-note">⚠ Demo purchase — this does not charge a real payment method. Real billing (via Stripe and/or Meta Client Billing) isn't connected yet. Estimated cost shown uses the platform's currently configured per-message rate.</div>
    </div>
  </section></div></>;
}

function SubscriptionSettings({activeTab,setActiveTab,notify}:{activeTab:string;setActiveTab:(s:string)=>void;notify:(s:string)=>void}){
  const tabs=["General","AI assistant","Notifications","Billing","Credits","API & OTP"];
  const [billing,setBilling]=useStoredState("qpy-engage-billing-v2",{plan:"Basic" as "Free"|"Basic"|"Premium",cycle:"monthly" as "monthly"|"annual",renewal:"August 17, 2026",payment:"Visa •••• 4242"});
  const [pending,setPending]=useState<null|"Free"|"Basic"|"Premium">(null);
  const plans=[
    {name:"Free" as const,eyebrow:"START EXPLORING",monthly:0,annual:0,description:"For trying Qpy Engage with a small customer volume.",limits:["1 AI assistant","500 AI conversations / month","1 customer channel","3 knowledge sources • 1,000 pages","Unified inbox","Basic analytics","Community support"],excluded:["Campaigns and automations","AI actions and webhooks","Voice assistant"],overage:"Upgrade when you reach the monthly limit."},
    {name:"Basic" as const,eyebrow:"MOST POPULAR",monthly:49,annual:39,description:"For growing teams automating everyday sales and support.",limits:["3 AI assistants","3,000 AI conversations / month","WhatsApp, Instagram and web chat","25 knowledge sources • 25,000 pages","Campaigns and automations","2 AI actions / webhooks","5 team members","Email support"],excluded:["Voice assistant minutes","Advanced governance and rollout"],overage:"Additional conversations: $0.03 each."},
    {name:"Premium" as const,eyebrow:"FULL PLATFORM",monthly:149,annual:119,description:"For businesses running AI across chat and voice at scale.",limits:["Unlimited AI assistants","15,000 AI conversations / month","All messaging and voice channels","100 knowledge sources • 100,000 pages","Unlimited campaigns and automations","Unlimited AI actions / webhooks","1,000 voice minutes / month","20 team members","Advanced analytics, audit logs and rollback","Priority support"],excluded:[],overage:"Extra conversations: $0.02 each • voice: $0.08/minute."}
  ];
  const current=plans.find(p=>p.name===billing.plan)??plans[1];
  const selected=pending?plans.find(p=>p.name===pending):null;
  const price=(p:typeof plans[number])=>billing.cycle==="annual"?p.annual:p.monthly;
  const confirm=()=>{if(!pending)return;setBilling({...billing,plan:pending,renewal:pending==="Free"?"No renewal — free plan":"August 17, 2026"});notify(pending==="Free"?"Downgrade scheduled to Free":"Subscription updated to "+pending);setPending(null)};
  const updatePayment=()=>{const last4=window.prompt("Enter the last 4 digits of the card to use",billing.payment.slice(-4));if(!last4||!/^[0-9]{4}$/.test(last4)){if(last4)notify("Enter exactly 4 card digits");return}setBilling({...billing,payment:`Visa •••• ${last4}`});notify("Payment method updated")};
  const downloadInvoice=()=>{const amount=price(current);const text=`Qpy Engage invoice\nPlan: ${billing.plan}\nBilling: ${billing.cycle}\nAmount: $${amount}${billing.cycle==="annual"?" x 12 billed annually":" per month"}\nPayment: ${billing.payment}\nStatus: Paid`;const blob=new Blob([text],{type:"text/plain"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="qpy-engage-invoice.txt";a.click();URL.revokeObjectURL(a.href);notify("Invoice downloaded")};
  return <><PageHeader title="Subscription & billing" description="Three straightforward plans with clear limits, pricing, and no hidden platform fees."/><div className="settings-layout subscription-layout"><aside>{tabs.map(t=><button className={activeTab===t?"active":""} onClick={()=>setActiveTab(t)} key={t}>{t}</button>)}</aside><section className="subscription-content"><div className="billing-overview"><div><span>CURRENT PLAN</span><strong>{billing.plan}</strong><small>{billing.plan==="Free"?"No payment required":`Renews ${billing.renewal} • ${billing.cycle} billing`}</small></div><div><span>THIS MONTH</span><strong>1,284 <small>/ {billing.plan==="Premium"?"15,000":billing.plan==="Basic"?"3,000":"500"}</small></strong><small>AI conversations used</small></div><div><span>PAYMENT METHOD</span><strong>{billing.plan==="Free"?"Not required":billing.payment}</strong><button onClick={updatePayment}>{billing.plan==="Free"?"Add card":"Update"}</button></div></div><div className="billing-cycle"><div><strong>Choose the plan that fits today</strong><small>Change or cancel at any time. Meta messaging fees are billed separately by Meta.</small></div><div><button className={billing.cycle==="monthly"?"active":""} onClick={()=>setBilling({...billing,cycle:"monthly"})}>Monthly</button><button className={billing.cycle==="annual"?"active":""} onClick={()=>setBilling({...billing,cycle:"annual"})}>Annual <b>Save 20%</b></button></div></div><div className="pricing-grid">{plans.map(plan=><article className={`${plan.name.toLowerCase()} ${billing.plan===plan.name?"current":""}`} key={plan.name}>{plan.name==="Basic"&&<em>Recommended</em>}<div className="price-head"><span>{plan.eyebrow}</span><h2>{plan.name}</h2><p>{plan.description}</p><div className="price"><strong>${price(plan)}</strong><small>{plan.name==="Free"?"forever":"per month"}</small></div>{billing.cycle==="annual"&&plan.annual>0&&<label>${plan.annual*12} billed once per year</label>}</div><button className={plan.name==="Basic"?"primary":"secondary-btn"} disabled={billing.plan===plan.name} onClick={()=>setPending(plan.name)}>{billing.plan===plan.name?"✓ Current plan":plan.name==="Free"?"Move to Free":billing.plan==="Free"?`Start ${plan.name}`:`Switch to ${plan.name}`}</button><div className="plan-includes"><strong>What’s included</strong>{plan.limits.map(x=><span key={x}>✓ {x}</span>)}{plan.excluded.map(x=><span className="muted" key={x}>— {x}</span>)}</div><p className="overage">{plan.overage}</p></article>)}</div><div className="pricing-clarity"><div><span>◎</span><strong>What counts as a conversation?</strong><p>A conversation is counted once when the AI sends at least one response to a customer within a 24-hour window. Human-only conversations do not count.</p></div><div><span>☎</span><strong>How are voice minutes counted?</strong><p>Premium includes 1,000 connected call minutes. Ringing time and failed calls are not charged.</p></div><div><span>◈</span><strong>What is billed separately?</strong><p>Meta WhatsApp template and conversation fees, phone numbers, and third-party provider charges are paid directly to those providers.</p></div></div><div className="feature-compare"><h2>Compare plans</h2><table><thead><tr><th>Capability</th><th>Free</th><th>Basic</th><th>Premium</th></tr></thead><tbody>{[["AI conversations / month","500","3,000","15,000"],["AI assistants","1","3","Unlimited"],["Channels","1","3","All + voice"],["Knowledge pages","1,000","25,000","100,000"],["Campaigns & automations","—","Included","Unlimited"],["AI actions / webhooks","—","2","Unlimited"],["Voice minutes","—","—","1,000"],["Team seats","1","5","20"],["Support","Community","Email","Priority"]].map(row=><tr key={row[0]}>{row.map((cell,i)=><td key={cell}>{i===0?<strong>{cell}</strong>:cell}</td>)}</tr>)}</tbody></table></div><div className="billing-footer"><div><strong>Invoices and account</strong><small>Next billing date: {billing.renewal} • Prices shown in USD before applicable tax.</small></div><button className="secondary-btn" onClick={downloadInvoice}>Download latest invoice</button>{billing.plan!=="Free"&&<button className="danger-link" onClick={()=>setPending("Free")}>Cancel subscription</button>}</div></section></div>{selected&&<SimpleModal title={selected.name==="Free"?"Confirm downgrade":"Confirm subscription"} onClose={()=>setPending(null)}><div className="checkout-summary"><div><strong>{selected.name} plan</strong><span>${price(selected)}<small>/month</small></span></div><p>{selected.name==="Free"?"Your paid features remain available until the end of the current billing period.":billing.cycle==="annual"?`You’ll be billed $${selected.annual*12} yearly. The effective monthly price is $${selected.annual}.`:`You’ll be billed $${selected.monthly} monthly. You can change or cancel at any time.`}</p><label><input type="checkbox" defaultChecked/> I understand the included limits and overage pricing.</label></div><div className="modal-actions"><button className="secondary-btn" onClick={()=>setPending(null)}>Back</button><button className="primary" onClick={confirm}>{selected.name==="Free"?"Schedule downgrade":`Confirm ${selected.name}`}</button></div></SimpleModal>}</>;
}

function LegacySettings({activeTab,setActiveTab,connected,onChannels,workspaceName,notify}:{activeTab:string;setActiveTab:(s:string)=>void;connected:boolean;onChannels:()=>void;workspaceName:string;notify:(s:string)=>void}){const tabs=["General","AI assistant","Notifications","Billing","Credits","API & OTP"];const [prefs,setPrefs]=useStoredState("qpy-engage-settings",{workspace:workspaceName,website:"",timeZone:"Asia/Dubai",language:"English",assistantName:"Assistant",voice:"Friendly, polished and concise. Make practical recommendations without being pushy.",tone:"Warm & helpful",confidence:72,checkout:true,legal:true,notifications:[true,true,true,true,false]});const save=(message:string)=>notify(message);return <><PageHeader title="Settings" description="Manage your workspace, assistant behavior, and subscription."/><div className="settings-layout"><aside>{tabs.map(t=><button className={activeTab===t?"active":""} onClick={()=>setActiveTab(t)} key={t}>{t}</button>)}</aside><section className="settings-card">{activeTab==="General"&&<><h2>Workspace details</h2><p>Information used across your Qpy Engage account.</p><div className="form-grid"><label>Workspace name<input value={prefs.workspace} onChange={e=>setPrefs({...prefs,workspace:e.target.value})}/></label><label>Business website<input value={prefs.website} onChange={e=>setPrefs({...prefs,website:e.target.value})}/></label><label>Time zone<select value={prefs.timeZone} onChange={e=>setPrefs({...prefs,timeZone:e.target.value})}><option>Asia/Dubai</option><option>Europe/London</option><option>America/New_York</option></select></label><label>Default language<select value={prefs.language} onChange={e=>setPrefs({...prefs,language:e.target.value})}><option>English</option><option>Arabic</option><option>French</option></select></label></div><div className="connection-card"><span className="wa-logo">◉</span><div><strong>WhatsApp Business</strong><small>{connected?"A phone number is connected":"No phone number connected"}</small></div><b className={`status-pill ${connected?"ready":"syncing"}`}>{connected?"Connected":"Setup required"}</b><button className="secondary-btn" onClick={onChannels}>{connected?"Manage":"Connect"}</button></div><div className="settings-actions"><button className="primary" onClick={()=>save("Workspace settings saved")}>Save changes</button></div></>}
    {activeTab==="AI assistant"&&<><h2>AI assistant behavior</h2><p>Define how Qpy Engage speaks and when it should hand off.</p><label className="full-label">Assistant name<input value={prefs.assistantName} onChange={e=>setPrefs({...prefs,assistantName:e.target.value})}/></label><label className="full-label">Brand voice<textarea value={prefs.voice} onChange={e=>setPrefs({...prefs,voice:e.target.value})}/></label><div className="choice-grid">{["Warm & helpful","Concise & direct","Premium concierge","Playful & casual"].map(x=><button className={prefs.tone===x?"selected":""} onClick={()=>setPrefs({...prefs,tone:x})} key={x}><span>✦</span><strong>{x}</strong></button>)}</div><div className="range-setting"><div><strong>Human handoff confidence</strong><small>Hand off when AI confidence is below this level.</small></div><input type="range" min="40" max="95" value={prefs.confidence} onChange={e=>setPrefs({...prefs,confidence:Number(e.target.value)})}/><b>{prefs.confidence}%</b></div><label className="check-setting"><input type="checkbox" checked={prefs.checkout} onChange={e=>setPrefs({...prefs,checkout:e.target.checked})}/><span><strong>Ask before sharing checkout links</strong><small>Prevents accidental product or pricing mismatches.</small></span></label><label className="check-setting"><input type="checkbox" checked={prefs.legal} onChange={e=>setPrefs({...prefs,legal:e.target.checked})}/><span><strong>Never answer legal or payment disputes</strong><small>Immediately assign sensitive conversations to a human.</small></span></label><div className="settings-actions"><button className="primary" onClick={()=>save("AI behavior saved")}>Save assistant</button></div></>}
    {activeTab==="Notifications"&&<><h2>Notification preferences</h2><p>Choose when Qpy Engage should alert you and your team.</p>{["New conversation assigned","AI requests human help","Negative customer sentiment","Daily performance summary","Weekly revenue report"].map((x,i)=><label className="notification-row" key={x}><span><strong>{x}</strong><small>{i<3?"Instant push and email alert":"Delivered to workspace admins"}</small></span><button className={`toggle ${prefs.notifications[i]?"on":""}`} onClick={()=>setPrefs({...prefs,notifications:prefs.notifications.map((v,j)=>i===j?!v:v)})}><i/></button></label>)}<div className="settings-actions"><button className="primary" onClick={()=>save("Notification preferences saved")}>Save preferences</button></div></>}
  </section></div></>}

function SimpleModal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e=>e.stopPropagation()}><div className="modal-head"><h2>{title}</h2><button onClick={onClose}>×</button></div>{children}</div></div>}
function AutomationModal({template,onClose,onSave}:{template?:{name:string;trigger:string;action:string}|null;onClose:()=>void;onSave:(a:Automation)=>void}){const [name,setName]=useState(template?.name??"");const [trigger,setTrigger]=useState(template?.trigger??"New WhatsApp conversation");const [action,setAction]=useState(template?.action??"Send AI welcome message");return <SimpleModal title="Create automation" onClose={onClose}><p>Choose a trigger and what Qpy Engage should do next.</p><div className="modal-form"><label>Automation name<input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Welcome new leads"/></label><label>When this happens<select value={trigger} onChange={e=>setTrigger(e.target.value)}><option>New WhatsApp conversation</option><option>Customer asks about an order</option><option>Cart idle for 2 hours</option><option>AI confidence is low</option><option>Conversation marked resolved</option></select></label><label>Do this<select value={action} onChange={e=>setAction(e.target.value)}><option>Send AI welcome message</option><option>Fetch order status</option><option>Send recovery template</option><option>Assign to support team</option><option>Request feedback survey</option></select></label></div><div className="flow-preview"><span>Trigger</span><i>→</i><span>AI action</span><i>→</i><span>Track result</span></div><div className="modal-actions"><button className="secondary-btn" onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={()=>onSave({id:Date.now(),title:name,trigger,action,runs:0,rate:"New",active:true})}>Create automation</button></div></SimpleModal>}
function SourceModal({onClose,onSave}:{onClose:()=>void;onSave:(s:Source,content?:string)=>void}){
  const [type,setType]=useState<Source["type"]>("Website");
  const [name,setName]=useState("");
  const [content,setContent]=useState("");
  const canSave=name.trim()&&(type==="Website"||content.trim());
  return <SimpleModal title="Add knowledge source" onClose={onClose}>
    <div className="source-types">{(["Website","Document","FAQ"] as const).map(t=><button className={type===t?"active":""} onClick={()=>{setType(t);setName("");setContent("")}} key={t}><span>{t==="Website"?"⌁":t==="Document"?"▤":"?"}</span>{t}</button>)}</div>
    <div className="modal-form">
      {type==="Website"?<label>Website URL<input value={name} onChange={e=>setName(e.target.value)} placeholder="https://example.com"/></label>:<>
        <label>{type==="Document"?"Document name":"FAQ collection name"}<input value={name} onChange={e=>setName(e.target.value)} placeholder={type==="Document"?"e.g. Product catalog 2026":"e.g. Customer support FAQs"}/></label>
        <label className="full-label">Paste the real content<textarea className="large-prompt" value={content} onChange={e=>setContent(e.target.value)} placeholder={type==="Document"?"Paste the document's text here…":"Paste your questions and answers here…"}/><small>{content.length.toLocaleString()} characters — this is exactly what the assistant will use to answer questions, no guessing.</small></label>
      </>}
    </div>
    <div className="modal-actions"><button className="secondary-btn" onClick={onClose}>Cancel</button><button className="primary" disabled={!canSave} onClick={()=>onSave({id:Date.now(),name,type,pages:type==="Website"?120:Math.max(1,Math.round(content.length/2000)),status:"Syncing"},content)}>Add & train</button></div>
  </SimpleModal>;
}
function InviteModal({onClose,onSave}:{onClose:()=>void;onSave:(email:string,role:Member["role"])=>void}){const [email,setEmail]=useState("");const [role,setRole]=useState<Member["role"]>("Agent");return <SimpleModal title="Invite teammate" onClose={onClose}><div className="modal-form"><label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="teammate@company.com"/></label><label>Role<select value={role} onChange={e=>setRole(e.target.value as Member["role"])}><option>Admin</option><option>Agent</option><option>Analyst</option></select></label></div><div className="role-note">Agents can manage conversations. Analysts can view reports. Admins can manage the workspace.</div><div className="modal-actions"><button className="secondary-btn" onClick={onClose}>Cancel</button><button className="primary" disabled={!email.includes("@")} onClick={()=>onSave(email.trim().toLowerCase(),role)}>Send invitation</button></div></SimpleModal>}
function SearchModal({onClose,onNavigate}:{onClose:()=>void;onNavigate:(s:Section)=>void}){const [q,setQ]=useState("");const pages:Section[]=["Overview","Assistants","Channels","Inbox","Campaigns","Automations","Knowledge","Analytics","Team","Settings"];return <SimpleModal title="Search Qpy Engage" onClose={onClose}><input autoFocus className="global-search" placeholder="Search pages and features…" value={q} onChange={e=>setQ(e.target.value)}/><div className="search-results">{pages.filter(p=>p.toLowerCase().includes(q.toLowerCase())).map(p=><button key={p} onClick={()=>onNavigate(p)}><span>⌕</span><div><strong>{p}</strong><small>Open {p.toLowerCase()}</small></div><b>→</b></button>)}</div></SimpleModal>}
