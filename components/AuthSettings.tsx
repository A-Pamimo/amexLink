"use client";
import { useState } from "react";
import useSWR from "swr";
import { startRegistration } from "@simplewebauthn/browser";
import { toast } from "sonner";
import { apiFetch, errorMessage } from "@/lib/client/api";

interface AuthStatus {
  mode: "none" | "required";
  setup_required: boolean;
  /** `recovery_codes_remaining` is null until the server sees a valid session. */
  factors: { totp: boolean; passkeys: number; recovery_codes_remaining: number | null };
}

const buttonClass =
  "rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50";
const dangerClass =
  "rounded-md border border-rose-400/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50";

export function AuthSettings() {
  const { data: status, mutate } = useSWR<AuthStatus>("/api/auth/status");
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  async function addPasskey() {
    setBusy("passkey");
    try {
      const start = await apiFetch<{
        challenge_id: string;
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      }>("/api/auth/setup/passkey/options", { method: "POST", body: "{}" });
      const response = await startRegistration({ optionsJSON: start.options });
      await apiFetch("/api/auth/setup/passkey/verify", {
        method: "POST",
        body: JSON.stringify({
          challenge_id: start.challenge_id,
          response,
          label: label.trim() || null,
        }),
      });
      setLabel("");
      toast.success("Passkey added");
      mutate();
    } catch (err) {
      toast.error(errorMessage("Could not add a passkey", err));
    } finally {
      setBusy(null);
    }
  }

  async function regenerateCodes() {
    if (!confirm("Generate 10 new recovery codes? The old ones stop working immediately.")) return;
    setBusy("recovery");
    try {
      const body = await apiFetch<{ recovery_codes: string[] }>("/api/auth/setup/recovery", {
        method: "POST",
        body: "{}",
      });
      setFreshCodes(body.recovery_codes);
      mutate();
    } catch (err) {
      toast.error(errorMessage("Could not regenerate recovery codes", err));
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("logout");
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      toast.error(errorMessage("Sign-out failed", err));
      setBusy(null);
      return;
    }
    window.location.assign("/login");
  }

  async function signOutEverywhere() {
    if (!confirm("Sign out every browser, including this one?")) return;
    setBusy("logout-all");
    try {
      await apiFetch("/api/auth/sessions", { method: "DELETE" });
    } catch (err) {
      toast.error(errorMessage("Could not sign out everywhere", err));
      setBusy(null);
      return;
    }
    window.location.assign("/login");
  }

  if (!status) {
    return <div className="neo-card p-4 text-sm text-slate-400">Loading…</div>;
  }

  if (status.mode === "none") {
    return (
      <div className="neo-card p-4 text-sm text-amber-300">
        Authentication is disabled (<code>AUTH_MODE=none</code>). This is for local sandbox use only and
        is refused in production.
      </div>
    );
  }

  const f = status.factors;

  return (
    <div className="neo-card space-y-4 p-4 text-sm">
      <dl className="grid grid-cols-2 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Authenticator app</dt>
          <dd className={f.totp ? "text-emerald-400" : "text-slate-100"}>
            {f.totp ? "enrolled" : "not enrolled"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Passkeys</dt>
          <dd className="text-slate-100">{f.passkeys}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Recovery codes left</dt>
          <dd
            className={
              f.recovery_codes_remaining !== null && f.recovery_codes_remaining <= 2
                ? "text-amber-300"
                : "text-slate-100"
            }
          >
            {f.recovery_codes_remaining ?? "—"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Passkey label (optional)"
          maxLength={64}
          className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-xs focus:border-accent/60 focus:outline-none"
        />
        <button onClick={addPasskey} disabled={busy !== null} className={buttonClass}>
          {busy === "passkey" ? "Waiting for the authenticator…" : "Add passkey"}
        </button>
        <button onClick={regenerateCodes} disabled={busy !== null} className={buttonClass}>
          {busy === "recovery" ? "Generating…" : "Regenerate recovery codes"}
        </button>
        <button onClick={signOutEverywhere} disabled={busy !== null} className={dangerClass}>
          Sign out everywhere
        </button>
        <button onClick={signOut} disabled={busy !== null} className={buttonClass}>
          Sign out
        </button>
      </div>

      {freshCodes ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">
            New recovery codes. Shown once; save them now.
          </p>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-white/10 bg-black/30 p-3 font-mono text-sm">
            {freshCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button onClick={() => setFreshCodes(null)} className={buttonClass}>
            I saved these
          </button>
        </div>
      ) : null}

      <p className="text-xs text-slate-500">
        Sessions last 12 hours and expire after 2 hours idle. Sign-in locks for 15 minutes after 5
        failed attempts.
      </p>
    </div>
  );
}
