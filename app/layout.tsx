import "./globals.css";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { Providers } from "@/components/Providers";

export const metadata = {
  title: "AmexLens",
  description: "Personal Amex spending tracker",
};

export default function RootLayout({ children }: { children: ReactNode }) {
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
