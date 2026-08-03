import type { Metadata } from "next";
import "./globals.css";

// Absolute URLs were hardcoded to the GitHub Pages address, so moving the site to its own domain
// left the icon and social preview pointing at the old host. Deriving both from the deploy target
// means the next move needs no edit here — and the basePath is applied by Next, so these paths must
// not repeat it.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL
  || (process.env.NEXT_PUBLIC_BASE_PATH ? "https://mobileecommerce.github.io/qpy-engage/" : "https://engage.qpy.ai/");

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Qpy Engage — AI that turns chats into customers",
  description: "A unified customer engagement workspace for AI conversations, campaigns, automation, support, and measurable growth.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: { title: "Qpy Engage — AI conversations that drive growth", description: "Connect, train, automate, campaign, and grow from one intelligent engagement workspace.", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Qpy Engage — AI conversations that drive growth", description: "Connect, train, automate, campaign, and grow from one intelligent engagement workspace.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
