"use client";
import useSWR, { useSWRConfig } from "swr";
import { useState } from "react";
import { toast } from "sonner";
import { AuthSettings } from "@/components/AuthSettings";
import { DangerZone } from "@/components/DangerZone";
import { ItemActions } from "@/components/ItemActions";
import { PlaidLinkButton } from "@/components/PlaidLinkButton";
import { PrivacyPanel } from "@/components/PrivacyPanel";
import { SyncButton } from "@/components/SyncButton";
import { apiFetch, errorMessage } from "@/lib/client/api";
import type { ItemStatus, PlaidItem } from "@/lib/types";

// What GET /api/items returns (an allowlist: no cursor, no token).
type ItemView = Omit<PlaidItem, "cursor">;

const STATUS_LABEL: Record<ItemStatus, { text: string; cls: string }> = {
  active: { text: "Active", cls: "bg-emerald-500/10 text-emerald-300" },
  needs_relink: { text: "Needs re-link", cls: "bg-amber-500/10 text-amber-300" },
  consent_required: { text: "Consent required", cls: "bg-amber-500/10 text-amber-300" },
  revoke_failed: { text: "Revoke failed", cls: "bg-rose-500/10 text-rose-300" },
};

function StatusBadge({ status, code }: { status: ItemStatus; code: string | null }) {
  const s = STATUS_LABEL[status] ?? STATUS_LABEL.active;
  return (
    <span
      className={`ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide ${s.cls}`}
      title={code ?? undefined}
    >
      {s.text}
      {status !== "active" && code ? ` (${code})` : ""}
    </span>
  );
}

interface SystemResponse {
  db_ok: boolean;
  storage: string;
  auth_mode: string;
  plaid_env: string;
  country_codes: string[];
  items_count: number;
  tx_count: number;
}

export default function SettingsPage() {
  const { data: itemsData } = useSWR<{ items: ItemView[] }>(
    "/api/items"
  );
  // Detail moved off the public /api/health probe (which now only says ok / not ok).
  const { data: health } = useSWR<SystemResponse>("/api/system");
  const { mutate } = useSWRConfig();
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function disconnect(id: string, name: string | null, retry = false) {
    if (
      !retry &&
      !confirm(`Disconnect ${name ?? "this card"}? Its transactions will be removed.`)
    ) {
      return;
    }
    setRemovingId(id);
    try {
      await apiFetch(`/api/items/${id}`, { method: "DELETE" });
      toast.success(`Disconnected ${name ?? "card"}`);
      mutate("/api/items");
      mutate((k) => typeof k === "string" && k.startsWith("/api/stats/"));
      mutate((k) => typeof k === "string" && k.startsWith("/api/transactions"));
      mutate("/api/system");
    } catch (err) {
      toast.error(
        errorMessage(retry ? "Revoke failed again" : "Could not disconnect", err)
      );
      mutate("/api/items");
    } finally {
      setRemovingId(null);
    }
  }

  const items = itemsData?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div className="flex items-center gap-2">
          <SyncButton />
          <PlaidLinkButton />
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Connected cards</h2>
        {items.length === 0 ? (
          <div className="neo-card p-6 text-sm text-slate-400">
            No cards connected. Click <em>Connect a card</em> to start.
          </div>
        ) : (
          <div className="neo-card divide-y divide-white/5">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="font-medium text-slate-100">
                    {item.institution_name ?? "Unknown institution"}
                    <StatusBadge status={item.status} code={item.last_error} />
                  </div>
                  <div className="text-xs text-slate-400">
                    Linked {new Date(item.created_at).toLocaleDateString()} ·{" "}
                    {item.last_synced_at
                      ? `synced ${new Date(item.last_synced_at).toLocaleString()}`
                      : "never synced"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ItemActions item={item} />
                  <button
                    onClick={() =>
                      disconnect(item.id, item.institution_name, item.status === "revoke_failed")
                    }
                    disabled={removingId === item.id}
                    className="rounded-md border border-rose-400/20 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                  >
                    {removingId === item.id
                      ? "Removing…"
                      : item.status === "revoke_failed"
                        ? "Retry revoke"
                        : "Disconnect"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Sign-in and sessions</h2>
        <AuthSettings />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">System</h2>
        <div className="neo-card p-4 text-sm">
          <dl className="grid grid-cols-2 gap-y-2 sm:grid-cols-4">
            <Stat label="Storage" value={health?.storage ?? "—"} />
            <Stat label="Plaid env" value={health?.plaid_env ?? "—"} />
            <Stat label="Auth mode" value={health?.auth_mode ?? "—"} />
            <Stat
              label="DB"
              value={health?.db_ok ? "ok" : "error"}
              tone={health?.db_ok ? "good" : "bad"}
            />
            <Stat label="Cards" value={String(health?.items_count ?? 0)} />
            <Stat label="Transactions" value={String(health?.tx_count ?? 0)} />
            <Stat
              label="Countries"
              value={health?.country_codes?.join(", ") ?? "—"}
            />
          </dl>
        </div>
      </section>

      <PrivacyPanel />
      <DangerZone />
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-rose-400"
        : "text-slate-100";
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`text-sm ${toneClass}`}>{value}</dd>
    </div>
  );
}
