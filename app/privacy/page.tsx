import type { Metadata } from "next";
import LegalShell from "../legal-shell";

export const metadata: Metadata = { title: "Privacy Policy — Qpy Engage" };

export default function PrivacyPage() {
  return <LegalShell>
    <p className="legal-eyebrow">Legal</p>
    <h1>Privacy Policy</h1>
    <p className="legal-updated">Effective July 17, 2026</p>

    <section><h2>1. About this policy</h2><p>Qpy Engage provides tools for businesses to manage customer conversations, messaging channels, campaigns, automations, and AI assistants. This policy explains how Qpy Engage processes information when you use the service or connect a Meta, WhatsApp Business, Instagram, or web-chat account.</p></section>
    <section><h2>2. Information we process</h2><ul><li>Account and workspace information, including names, contact details, roles, and preferences.</li><li>Channel connection details supplied through authorized platform sign-in flows, such as business account, phone-number, page, and channel identifiers.</li><li>Customer conversations, message status events, contact records, campaign audiences, templates, uploaded training sources, and automation settings that you choose to manage through Qpy Engage.</li><li>Technical and usage information needed to operate, secure, diagnose, and improve the service.</li></ul></section>
    <section><h2>3. How information is used</h2><p>We use information to provide requested messaging and automation features, deliver and organize conversations, train and operate assistants according to workspace instructions, provide analytics, secure accounts, troubleshoot problems, comply with law, and communicate about the service.</p></section>
    <section><h2>4. Meta and messaging platforms</h2><p>When you connect a supported channel, Qpy Engage processes information under the permissions you approve. Platform data is used only to provide the connected features and is also subject to the applicable platform’s terms and policies. Qpy Engage does not sell platform data.</p></section>
    <section><h2>5. Sharing</h2><p>Information may be shared with service providers that help host, secure, monitor, or deliver Qpy Engage; with connected messaging platforms as required to perform your instructions; during a business reorganization; or when required by law. Providers are permitted to process information only for the services they supply.</p></section>
    <section><h2>6. Retention and security</h2><p>Information is retained for as long as needed to provide the service, meet contractual or legal requirements, resolve disputes, and maintain security. We use reasonable administrative and technical safeguards, but no internet service can guarantee absolute security.</p></section>
    <section><h2>7. Your choices</h2><p>Workspace administrators can disconnect channels, update connected data, and request access, correction, export, or deletion. You may also remove Qpy Engage from the integrations or business settings of the connected platform.</p></section>
    <section><h2>8. International processing and children</h2><p>Information may be processed in countries where Qpy Engage or its service providers operate, subject to applicable safeguards. Qpy Engage is a business service and is not directed to children.</p></section>
    <section><h2>9. Updates</h2><p>We may update this policy as the service or legal requirements change. The effective date above identifies the latest version.</p></section>
    <section className="legal-callout"><h2>Contact</h2><p>For privacy questions or requests, email <a href="mailto:praveen.madipoju3@gmail.com">praveen.madipoju3@gmail.com</a>.</p></section>
  </LegalShell>;
}
