"use client";
import useSWR from "swr";

interface SystemResponse {
  db_ok: boolean;
  storage: string;
  auth_mode: string;
  plaid_env: string;
  country_codes: string[];
  items_count: number;
  tx_count: number;
}

/**
 * Privacy notice (SECURITY.md 3.11: purpose, processor, country, retention). Static text plus
 * the operator detail from /api/system (same SWR key as the System section, so one request).
 * It states what the app does; it never claims Plaid deleted anything.
 */
export function PrivacyPanel() {
  const { data: system } = useSWR<SystemResponse>("/api/system");
  return (
    <section className="space-y-2" aria-labelledby="privacy-heading">
      <h2 id="privacy-heading" className="text-sm font-medium text-slate-300">
        Privacy and data
      </h2>
      <div className="neo-card space-y-3 p-4 text-sm text-slate-300">
        <p>
          AmexLens pulls credit-card balances, limits, minimum payments, due dates, APRs and transactions
          through Plaid Inc., which processes the data in the United States. Linking happens in
          Plaid&apos;s widget; your bank password never reaches this app. Disconnecting a card revokes the
          Plaid connection; Plaid retains data under its own policy.
        </p>
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">Stored on this machine</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-300">
            <li>
              Per card: institution, card name, last four digits, currency, and each field Plaid supplied
              (balances, limit, minimum payment, due date, last payment, APRs) with when it was observed.
              Full account and routing numbers are never stored.
            </li>
            <li>Transactions (merchant, amount, date, category) and an audit log of connect, disconnect and delete events.</li>
            <li>
              Plaid access tokens, encrypted at rest (AES-256-GCM). The encryption key lives outside the
              data folder. The host disk must also be encrypted: transaction and balance text in the
              database is not encrypted by the app.
            </li>
          </ul>
        </div>
        <dl className="grid grid-cols-2 gap-y-2 border-t border-white/5 pt-3 sm:grid-cols-4">
          <Detail label="Plaid environment" value={system?.plaid_env} />
          <Detail label="Country codes" value={system?.country_codes?.join(", ")} />
          <Detail label="Cards connected" value={system ? String(system.items_count) : undefined} />
          <Detail label="Transactions stored" value={system ? String(system.tx_count) : undefined} />
          <Detail label="Storage" value={system?.storage} />
          <Detail label="Sign-in mode" value={system?.auth_mode} />
        </dl>
      </div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-100">{value ?? "—"}</dd>
    </div>
  );
}
