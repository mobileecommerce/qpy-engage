import Link from "next/link";
import "./legal.css";

export default function LegalShell({ children }: { children: React.ReactNode }) {
  return <main className="legal-page">
    <header className="legal-header">
      <Link className="legal-brand" href="/"><span className="legal-mark">Q</span>Qpy Engage</Link>
      <nav aria-label="Legal pages">
        <Link href="/privacy/">Privacy</Link>
        <Link href="/terms/">Terms</Link>
        <Link href="/data-deletion/">Data deletion</Link>
      </nav>
    </header>
    <article className="legal-content">{children}</article>
  </main>;
}
