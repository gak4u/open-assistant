import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "open-assistant",
  description: "Self-hostable, privacy-first AI assistant with persistent memory",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
