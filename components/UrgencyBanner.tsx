import { formatTimestampToronto } from "@/lib/format";

/** Counts only: no amounts, no card names. Red when anything is overdue, amber when due soon. */
export function UrgencyBanner({
  counts,
  today,
  generatedAt,
}: {
  counts: { overdue: number; due_soon: number };
  /** America/Toronto civil date used for urgency. */
  today: string;
  generatedAt: string;
}) {
  const { overdue, due_soon } = counts;
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} ${overdue === 1 ? "card" : "cards"} overdue`);
  if (due_soon > 0) {
    parts.push(
      overdue > 0
        ? `${due_soon} due within 7 days`
        : `${due_soon} ${due_soon === 1 ? "card" : "cards"} due within 7 days`
    );
  }
  const tone =
    overdue > 0
      ? "border-rose-500/50 bg-rose-500/15 text-rose-100"
      : due_soon > 0
        ? "border-amber-400/50 bg-amber-500/15 text-amber-100"
        : "border-white/10 bg-white/5 text-slate-300";
  const stamp = formatTimestampToronto(generatedAt);
  return (
    <div
      role="status"
      data-tone={overdue > 0 ? "overdue" : due_soon > 0 ? "due_soon" : "quiet"}
      className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 ${tone}`}
    >
      <p className="text-sm font-medium">
        {parts.length > 0 ? parts.join(" · ") : "Nothing due in the next 7 days"}
      </p>
      <p className="text-xs opacity-80">
        Today (Toronto) {today}
        {stamp ? ` · updated ${stamp}` : ""}
      </p>
    </div>
  );
}
