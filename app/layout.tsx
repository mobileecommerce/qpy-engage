import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://wavely-whatsapp-automation.praveenmadipoju.chatgpt.site"),
  title: "Wavely — AI that turns chats into customers",
  description: "A unified WhatsApp automation workspace for smarter conversations, faster support, and measurable growth.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: { title: "Wavely — Your AI teammate for WhatsApp", description: "Connect, train, automate, and grow from one calm workspace.", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Wavely — Your AI teammate for WhatsApp", description: "Connect, train, automate, and grow from one calm workspace.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
