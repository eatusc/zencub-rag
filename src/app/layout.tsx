import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { getAppMode } from "@/lib/appMode";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

const isPublic = getAppMode() === "public";

const PUBLIC_DESCRIPTION =
  "Search thousands of BJJ instructionals by word or by meaning, and get answers cited back to the exact second they were said. Film Study by ZenCub.";

export const metadata: Metadata = isPublic
  ? {
    metadataBase: new URL("https://search.zencub.com"),
    title: "Film Study - Search BJJ instructionals by what was said | ZenCub",
    description: PUBLIC_DESCRIPTION,
    alternates: { canonical: "/" },
    icons: {
      icon: [
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    openGraph: {
      title: "Film Study - Search BJJ instructionals by what was said",
      description: PUBLIC_DESCRIPTION,
      siteName: "ZenCub",
      locale: "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "Film Study - Search BJJ instructionals by what was said",
      description: PUBLIC_DESCRIPTION,
    },
  }
  : {
    title: "ZenCub RAG - Transcript Search",
    description: "A RAG app for searching BJJ video transcripts and generating cited answers.",
  };

// Matches the marketing site's dark chrome so the browser UI does not flash
// white on mobile.
export const viewport: Viewport = isPublic
  ? { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#1a1917" }
  : {};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${inter.variable}`}>
      {/* zc-theme carries the ZenCub brand palette and system font stack; the
          internal demo surface keeps the default light theme. */}
      <body className={isPublic ? "zc-theme antialiased" : "font-sans antialiased"}>
        {children}
      </body>
    </html>
  );
}
