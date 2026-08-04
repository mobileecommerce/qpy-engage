import type { Metadata, Viewport } from "next";
import "./globals.css";
import RegisterServiceWorker from "./register-sw";

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
  manifest: "/manifest.webmanifest",
  applicationName: "Qpy Engage",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    // iOS ignores the manifest's icons for the home screen and reads this instead.
    apple: "/icons/icon-180.png",
  },
  appleWebApp: { capable: true, title: "Qpy", statusBarStyle: "default" },
  openGraph: { title: "Qpy Engage — AI conversations that drive growth", description: "Connect, train, automate, campaign, and grow from one intelligent engagement workspace.", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "Qpy Engage — AI conversations that drive growth", description: "Connect, train, automate, campaign, and grow from one intelligent engagement workspace.", images: ["/og.png"] },
};

export const viewport: Viewport = {
  themeColor: "#4c50ee",
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover is what lets the layout reach under the notch and home indicator; the safe
  // area insets in the stylesheet do nothing without it.
  viewportFit: "cover",
  // Zoom stays available. Disabling it makes the app feel more native and takes an accessibility
  // control away from people who need it, which is not a trade worth making.
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<RegisterServiceWorker /></body></html>;
}
