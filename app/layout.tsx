import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContextClues",
  description: "Local forensic dashboard for a running Claude CLI session's context window.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
