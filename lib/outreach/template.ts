import type { Lead, Sector } from "../../db/schema";

export interface TemplateContext {
  business_name: string;
  city: string;
  sector: string;
  unsubscribe_url: string;
  [key: string]: string;
}

export function buildContext(lead: Pick<Lead, "name" | "city">, sector: Pick<Sector, "name" | "city">, unsubscribeUrl = ""): TemplateContext {
  return {
    business_name: lead.name,
    city: lead.city ?? sector.city ?? "",
    sector: sector.name,
    unsubscribe_url: unsubscribeUrl,
  };
}

/** Replace `{{key}}` placeholders. Unknown keys are left blank, never leaked. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => ctx[key.toLowerCase()] ?? "");
}

/** Resolve the ordered list of WhatsApp body parameters from a spec like "business_name,city". */
export function templateParams(spec: string | undefined, ctx: TemplateContext): string[] {
  const keys = (spec ?? "business_name")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  // WhatsApp rejects empty parameters and newlines/tabs inside them.
  return keys.map((k) => (ctx[k] ?? "-").replace(/[\r\n\t]+/g, " ").trim() || "-");
}

/** Words that mean "stop messaging me" in a WhatsApp reply. */
const OPT_OUT_RE = /^\s*(stop|unsubscribe|remove|no thanks|not interested|don'?t message|leave me alone|opt ?out|block)\b/i;

export function isOptOutText(text: string | null | undefined): boolean {
  return !!text && OPT_OUT_RE.test(text);
}
