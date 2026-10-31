"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { apiFetch, errorMessage } from "@/lib/client/api";

const tabs = [
  { href: "/", label: "Cards" },
  { href: "/spending", label: "Spending" },
  { href: "/transactions", label: "Transactions" },
  { href: "/settings", label: "Settings" },
];

function SignOutButton() {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      toast.error(errorMessage("Sign-out failed", err));
      setBusy(false);
      return;
    }
    window.location.assign("/login");
  }
  return (
    <button
      onClick={signOut}
      disabled={busy}
      className="rounded-full px-3 py-1.5 text-sm text-slate-300 transition hover:text-white disabled:opacity-50"
    >
      Sign out
    </button>
  );
}

export function Nav() {
  const pathname = usePathname();
  if (pathname.startsWith("/login")) return null;
  return (
    <nav className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold tracking-tight">
          <span className="text-accent">Amex</span>Lens
        </span>
      </div>
      <ul className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 text-sm">
        {tabs.map((t) => {
          const active =
            t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                className={
                  "rounded-full px-3 py-1.5 transition " +
                  (active
                    ? "bg-accent/20 text-accent"
                    : "text-slate-300 hover:text-white")
                }
              >
                {t.label}
              </Link>
            </li>
          );
        })}
        <li>
          <SignOutButton />
        </li>
      </ul>
    </nav>
  );
}
