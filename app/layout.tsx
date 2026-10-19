import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CaféGestor — Da sua lavoura às melhores decisões",
  description: "Fazendas, custos, safras e rentabilidade em um só lugar. Uma gestão à altura do seu café.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
