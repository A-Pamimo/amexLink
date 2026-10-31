"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, errorMessage } from "@/lib/client/api";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const from = sp.get("from") ?? "/";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      router.replace(from);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage("Login failed", err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="neo-card space-y-3 p-6">
      <h1 className="text-lg font-semibold">AmexLens</h1>
      <p className="text-xs text-slate-400">Enter password to continue.</p>
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm focus:border-accent/60 focus:outline-none"
        placeholder="Password"
      />
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-slate-950 hover:bg-accent/90 disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <Suspense fallback={<div className="neo-card p-6 text-sm">Loading…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
