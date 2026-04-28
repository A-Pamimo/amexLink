"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Dashboard" },
  { href: "/transactions", label: "Transactions" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold tracking-tight">
          <span className="text-accent">Amex</span>Lens
        </span>
      </div>
      <ul className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1 text-sm">
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
      </ul>
    </nav>
  );
}
