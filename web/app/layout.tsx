import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  Geist,
  Geist_Mono,
  JetBrains_Mono,
  Jost,
  Libre_Caslon_Text,
  Source_Serif_4,
} from "next/font/google";
import { TourProvider } from "@/components/tour";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const jost = Jost({ variable: "--font-jost", subsets: ["latin"] });

/**
 * The landing page's editorial face.
 *
 * Scoped to `/` by the `.editorial` class rather than swapped in globally:
 * the application is a trading interface where a serif at 13px in a dense
 * order book would cost legibility for nothing. Two type systems in one
 * codebase is a real cost, but it is the smaller one.
 */
const caslon = Libre_Caslon_Text({
  variable: "--font-caslon",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

const icon =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f2f0e9"/><path d="M8 21V11h7M8 16h6" stroke="#d65d32" stroke-width="2.4" fill="none" stroke-linecap="round"/><circle cx="22" cy="19" r="3" fill="#d65d32"/></svg>`,
  );

export const metadata: Metadata = {
  title: "erodoro · sell tokenized-equity upside",
  description:
    "Lock eligible tokenized equity, choose a strike and expiry, and sell the upside for USDC on Solana.",
  openGraph: {
    title: "erodoro",
    description:
      "Set your strike and sell the upside on eligible tokenized equity, on Solana.",
    type: "website",
  },
  icons: { icon: [{ url: icon }] },
};

/**
 * Applies the stored theme before the first paint.
 *
 * The site is a static export, so the server has no idea which theme this
 * visitor chose. Reading it in an effect instead would render the whole page
 * in light and repaint it dark a frame later, which is the flash this exists
 * to prevent. It must stay synchronous and it must stay in <head>.
 */
const themeScript = `try{var t=localStorage.getItem("erodoro.theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      // `themeScript` rewrites this attribute before React hydrates, which is
      // the entire point of it. Without this, that deliberate difference is
      // reported as a hydration mismatch on every dark-theme page load.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${jost.variable} ${caslon.variable} ${sourceSerif.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      {/* The tour lives in the root layout so its state survives the route
          changes it performs itself. */}
      <body className="bg-bg text-text flex min-h-full flex-col">
        <TourProvider>{children}</TourProvider>
      </body>
    </html>
  );
}
