import type { Metadata } from "next";
import { Figtree, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { AccentColorScript } from "@/components/accent-color-script";
import { ThemeProvider } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Aeralyth",
    template: "Aeralyth - %s",
  },
  description: "A simple, performant, self-hosted cloud.",
  icons: {
    icon: [{ url: "/aeralyth_logo.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/aeralyth_logo.svg", type: "image/svg+xml" }],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "h-full antialiased",
        geistSans.variable,
        figtree.variable,
        geistMono.variable,
      )}
    >
      <body className="min-h-full flex flex-col">
        <AccentColorScript nonce={nonce} />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          nonce={nonce}
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
