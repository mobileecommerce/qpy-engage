import type { Metadata } from "next";
import LegalShell from "../legal-shell";

export const metadata: Metadata = { title: "Data Deletion — Qpy Engage" };

export default function DataDeletionPage() {
  return <LegalShell>
    <p className="legal-eyebrow">Privacy request</p>
    <h1>Delete your data</h1>
    <p className="legal-updated">Instructions for Qpy Engage users</p>
    <section><h2>Request deletion</h2><p>Email <a href="mailto:praveen.madipoju3@gmail.com?subject=Qpy%20Engage%20data%20deletion%20request">praveen.madipoju3@gmail.com</a> with the subject “Qpy Engage data deletion request.” Include the email address used for your workspace and the workspace name. Do not include passwords, access tokens, or message contents.</p></section>
    <section><h2>What happens next</h2><ul><li>We will acknowledge the request and may ask you to verify that you control the affected workspace.</li><li>After verification, we will delete or de-identify eligible account, channel, contact, conversation, campaign, automation, assistant, and training data.</li><li>We aim to complete verified requests within 30 days. We will explain if applicable law requires a longer period.</li></ul></section>
    <section><h2>Disconnect Meta immediately</h2><p>You can stop future Meta data access before deletion is completed by removing Qpy Engage from your Facebook Business Integrations or Business Settings and disconnecting the channel inside Qpy Engage.</p></section>
    <section><h2>Limited exceptions</h2><p>Some records may be retained where required for legal compliance, security, fraud prevention, billing, dispute resolution, or backup integrity. Any retained information remains protected and is deleted when the applicable requirement ends.</p></section>
    <section className="legal-callout"><h2>Need help?</h2><p>Contact <a href="mailto:praveen.madipoju3@gmail.com">praveen.madipoju3@gmail.com</a> and mention “data deletion” in the subject line.</p></section>
  </LegalShell>;
}
