import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "株式会社Luma Sales Agent — 営業AIエージェント",
  description: "録画から次の一手まで。受注を取りにいく営業エージェント（株式会社Luma 社内ツール）。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
