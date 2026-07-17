import type { Metadata } from "next";
import LegalShell from "../legal-shell";

export const metadata: Metadata = { title: "Terms of Service — Qpy Engage" };

export default function TermsPage() {
  return <LegalShell>
    <p className="legal-eyebrow">Legal</p>
    <h1>Terms of Service</h1>
    <p className="legal-updated">Effective July 17, 2026</p>
    <section><h2>1. Using Qpy Engage</h2><p>Qpy Engage is a business messaging, automation, campaign, analytics, and AI-assistant service. You must provide accurate information, safeguard workspace access, and use the service only for lawful business purposes.</p></section>
    <section><h2>2. Connected services</h2><p>You are responsible for maintaining authority over every Meta, WhatsApp Business, Instagram, website, and other account you connect. Your use must comply with the terms, messaging policies, consent requirements, and rate limits of each connected service.</p></section>
    <section><h2>3. Customer communications</h2><p>You are responsible for obtaining required consent, honoring opt-outs, using approved message templates where required, maintaining lawful audience records, and ensuring that campaigns and assistant responses comply with applicable laws and platform rules.</p></section>
    <section><h2>4. Your content</h2><p>You retain ownership of content and data you provide. You authorize Qpy Engage and its service providers to process that content only as needed to operate, secure, and improve the service and carry out your instructions.</p></section>
    <section><h2>5. AI features</h2><p>AI-generated responses can be incomplete or inaccurate. You are responsible for configuring instructions, reviewing sensitive use cases, providing human oversight, and avoiding reliance on AI for decisions that require licensed professional judgment.</p></section>
    <section><h2>6. Availability and changes</h2><p>We work to keep Qpy Engage available, but uninterrupted operation is not guaranteed. Features may change to improve the service, address security issues, or comply with connected-platform requirements.</p></section>
    <section><h2>7. Suspension and termination</h2><p>Access may be limited or terminated for misuse, security risk, nonpayment, legal requirements, or material violation of these terms. You may stop using the service and request deletion as described on the Data Deletion page.</p></section>
    <section><h2>8. Disclaimers and liability</h2><p>To the extent permitted by law, the service is provided without implied warranties and Qpy Engage is not liable for indirect, incidental, special, consequential, or lost-profit damages. Applicable mandatory rights remain unaffected.</p></section>
    <section className="legal-callout"><h2>Contact</h2><p>Questions about these terms may be sent to <a href="mailto:praveen.madipoju3@gmail.com">praveen.madipoju3@gmail.com</a>.</p></section>
  </LegalShell>;
}
