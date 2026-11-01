import "./globals.css";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { Nav } from "@/components/Nav";
import { Providers } from "@/components/Providers";

export const metadata = {
  title: "AmexLens",
  description: "Personal Amex spending tracker",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Opt every page into dynamic rendering. Next.js only applies the per-request
  // CSP nonce (middleware.ts) to its inline scripts when it renders per
  // request; statically prerendered HTML would carry no nonce and be blocked.
  await connection();
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50">
        <Providers>
          <div className="mx-auto max-w-6xl px-4 py-6">
            <Nav />
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
