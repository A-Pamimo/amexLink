"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { toast } from "sonner";
import { safeFrom } from "@/lib/auth/from";
import { ApiError, apiFetch, errorMessage } from "@/lib/client/api";

interface AuthStatus {
  mode: "none" | "required";
  setup_required: boolean;
  factors: { totp: boolean; passkeys: number; recovery_codes_remaining: number };
}

const inputClass =
  "w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm focus:border-accent/60 focus:outline-none";
const primaryClass =
  "w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-slate-950 hover:bg-accent/90 disabled:opacity-50";
const secondaryClass =
  "w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50";

/** The only navigation after sign-in: an allowlisted relative path, else "/". */
function leave(from: string) {
  window.location.assign(safeFrom(from));
}

function failureText(prefix: string, err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return `${prefix}: too many attempts, try again in 15 minutes`;
  }
  if (err instanceof ApiError && err.code === "invalid_code") return `${prefix}: code not accepted`;
  if (err instanceof ApiError && err.code === "invalid_setup_token") {
    return `${prefix}: setup token not accepted`;
  }
  return errorMessage(prefix, err);
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-white/10 bg-black/30 p-3 font-mono text-sm text-slate-100">
      {codes.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}

/** Registers a passkey for the signed-in owner (components/AuthSettings.tsx has the settings copy). */
async function addPasskey(label: string | null): Promise<void> {
  const start = await apiFetch<{ challenge_id: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
    "/api/auth/setup/passkey/options",
    { method: "POST", body: "{}" }
  );
  const response = await startRegistration({ optionsJSON: start.options });
  await apiFetch("/api/auth/setup/passkey/verify", {
    method: "POST",
    body: JSON.stringify({ challenge_id: start.challenge_id, response, label }),
  });
}

type SetupStep = "token" | "totp" | "confirm" | "recovery" | "passkey";

function SetupFlow({ from }: { from: string }) {
  const [step, setStep] = useState<SetupStep>("token");
  const [setupToken, setSetupToken] = useState("");
  const [qr, setQr] = useState<{ otpauth_uri: string; qr_data_url: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function startTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = await apiFetch<{ otpauth_uri: string; qr_data_url: string }>(
        "/api/auth/setup/totp/start",
        { method: "POST", body: JSON.stringify({ setup_token: setupToken }) }
      );
      setQr(body);
      setStep("totp");
    } catch (err) {
      toast.error(failureText("Could not start setup", err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = await apiFetch<{ recovery_codes: string[] }>("/api/auth/setup/totp/confirm", {
        method: "POST",
        body: JSON.stringify({ setup_token: setupToken, code }),
      });
      setCodes(body.recovery_codes);
      setSetupToken("");
      setStep("recovery");
    } catch (err) {
      toast.error(failureText("Could not confirm the code", err));
    } finally {
      setBusy(false);
    }
  }

  async function registerPasskey() {
    setBusy(true);
    try {
      await addPasskey(null);
      toast.success("Passkey added");
      leave(from);
    } catch (err) {
      toast.error(failureText("Could not add a passkey", err));
    } finally {
      setBusy(false);
    }
  }

  const secret = qr ? new URL(qr.otpauth_uri).searchParams.get("secret") : null;

  return (
    <div className="neo-card space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Set up AmexLens</h1>
        <p className="text-xs text-slate-400">
          No sign-in factor is enrolled yet. This flow runs once.
        </p>
      </div>

      {step === "token" && (
        <form onSubmit={startTotp} className="space-y-3">
          <label className="block text-xs text-slate-300">
            Setup token (<code>AUTH_SETUP_TOKEN</code> from the server environment)
          </label>
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            className={inputClass}
            placeholder="Setup token"
          />
          <button type="submit" disabled={busy || setupToken.length < 32} className={primaryClass}>
            {busy ? "Starting…" : "Continue"}
          </button>
        </form>
      )}

      {step === "totp" && qr && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Scan this with an authenticator app (1Password, Aegis, Google Authenticator…).
          </p>
          {/* data: image is allowed by the CSP img-src; nothing is fetched from a third party. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr.qr_data_url} alt="TOTP enrolment QR code" className="mx-auto rounded bg-white p-2" />
          <button type="button" onClick={() => setShowSecret((s) => !s)} className="text-xs text-accent">
            {showSecret ? "Hide manual key" : "Can't scan? Show the key"}
          </button>
          {showSecret && secret ? (
            <p className="break-all rounded-md bg-black/30 p-2 font-mono text-xs">{secret}</p>
          ) : null}
          <button type="button" onClick={() => setStep("confirm")} className={primaryClass}>
            I have added it
          </button>
        </div>
      )}

      {step === "confirm" && (
        <form onSubmit={confirmTotp} className="space-y-3">
          <label className="block text-xs text-slate-300">Enter the 6-digit code from the app</label>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={inputClass}
            placeholder="123456"
          />
          <button type="submit" disabled={busy || code.trim().length !== 6} className={primaryClass}>
            {busy ? "Checking…" : "Confirm"}
          </button>
          <button type="button" onClick={() => setStep("totp")} className="text-xs text-slate-400">
            Back to the QR code
          </button>
        </form>
      )}

      {step === "recovery" && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Recovery codes. Each works once. They are shown <strong>only now</strong>; store them in a
            password manager.
          </p>
          <RecoveryCodes codes={codes} />
          <button type="button" onClick={() => setStep("passkey")} className={primaryClass}>
            I saved these
          </button>
        </div>
      )}

      {step === "passkey" && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Optional: add a passkey (Touch ID, Windows Hello, a security key) for one-tap sign-in.
          </p>
          <button type="button" onClick={registerPasskey} disabled={busy} className={primaryClass}>
            {busy ? "Waiting for the authenticator…" : "Add a passkey"}
          </button>
          <button type="button" onClick={() => leave(from)} disabled={busy} className={secondaryClass}>
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}

function LoginForm({ status, from }: { status: AuthStatus; from: string }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);

  async function passkey() {
    setBusy(true);
    try {
      const start = await apiFetch<{
        challenge_id: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/api/auth/login/passkey/options", { method: "POST", body: "{}" });
      const response = await startAuthentication({ optionsJSON: start.options });
      await apiFetch("/api/auth/login/passkey/verify", {
        method: "POST",
        body: JSON.stringify({ challenge_id: start.challenge_id, response }),
      });
      leave(from);
    } catch (err) {
      toast.error(failureText("Passkey sign-in failed", err));
    } finally {
      setBusy(false);
    }
  }

  async function totp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiFetch("/api/auth/login/totp", { method: "POST", body: JSON.stringify({ code }) });
      leave(from);
    } catch (err) {
      toast.error(failureText("Sign-in failed", err));
    } finally {
      setBusy(false);
    }
  }

  async function recoveryLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = await apiFetch<{ recovery_codes_remaining: number }>("/api/auth/login/recovery", {
        method: "POST",
        body: JSON.stringify({ code: recovery }),
      });
      toast.success(`Signed in with a recovery code (${body.recovery_codes_remaining} left)`);
      leave(from);
    } catch (err) {
      toast.error(failureText("Sign-in failed", err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="neo-card space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">AmexLens</h1>
        <p className="text-xs text-slate-400">Sign in to continue.</p>
      </div>

      {status.factors.passkeys > 0 && (
        <button type="button" onClick={passkey} disabled={busy} className={primaryClass}>
          {busy ? "Waiting…" : "Sign in with a passkey"}
        </button>
      )}

      {status.factors.totp && !useRecovery && (
        <form onSubmit={totp} className="space-y-2">
          <label className="block text-xs text-slate-300">Authenticator code</label>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus={status.factors.passkeys === 0}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={inputClass}
            placeholder="123456"
          />
          <button
            type="submit"
            disabled={busy || code.trim().length !== 6}
            className={status.factors.passkeys > 0 ? secondaryClass : primaryClass}
          >
            Sign in with code
          </button>
        </form>
      )}

      {useRecovery && (
        <form onSubmit={recoveryLogin} className="space-y-2">
          <label className="block text-xs text-slate-300">Recovery code</label>
          <input
            autoFocus
            autoComplete="off"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
            className={inputClass}
            placeholder="xxxxx-xxxxx"
          />
          <button type="submit" disabled={busy || recovery.trim().length < 10} className={primaryClass}>
            Sign in with recovery code
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={() => setUseRecovery((v) => !v)}
        className="text-xs text-slate-400 hover:text-accent"
      >
        {useRecovery ? "Back" : "Use a recovery code"}
      </button>
    </div>
  );
}

function LoginScreen() {
  const sp = useSearchParams();
  const from = safeFrom(sp.get("from"));
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AuthStatus>("/api/auth/status")
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <div className="neo-card p-6 text-sm text-rose-300">Could not reach the server.</div>;
  }
  if (!status) return <div className="neo-card p-6 text-sm">Loading…</div>;
  if (status.mode === "none") {
    return (
      <div className="neo-card space-y-2 p-6 text-sm">
        <p>Authentication is disabled (<code>AUTH_MODE=none</code>). This is a local-sandbox setting.</p>
        <Link href="/" className="text-accent">
          Go to the dashboard
        </Link>
      </div>
    );
  }
  if (status.setup_required) return <SetupFlow from={from} />;
  return <LoginForm status={status} from={from} />;
}

export default function LoginPage() {
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <Suspense fallback={<div className="neo-card p-6 text-sm">Loading…</div>}>
        <LoginScreen />
      </Suspense>
    </div>
  );
}
