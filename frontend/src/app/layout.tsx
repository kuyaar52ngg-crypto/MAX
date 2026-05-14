import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "MAX Messenger",
  description: "WhatsApp Business Dashboard — Рассылки, Мессенджер, Аналитика",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className={`${inter.variable} font-sans bg-bg text-text antialiased`}>
        {children}
      </body>
    </html>
  );
}
