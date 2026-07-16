import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://mobileecommerce.github.io/qpy-engage/"),
  title: "Qpy Engage — AI that turns chats into customers",
  description: "A unified customer engagement workspace for AI conversations, campaigns, automation, support, and measurable growth.",
  icons: { icon: "https://mobileecommerce.github.io/qpy-engage/favicon.svg", shortcut: "https://mobileecommerce.github.io/qpy-engage/favicon.svg" },
  openGraph: { title: "Qpy Engage — AI conversations that drive growth", description: "Connect, train, automate, campaign, and grow from one intelligent engagement workspace.", images: ["/qpy-engage/og.png"] },
  twitter: { card: "summary_large_image", title: "Qpy Engage — AI conversations that drive growth", description: "Connect, train, automate, campaign, and grow from one intelligent engagement workspace.", images: ["/qpy-engage/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
