import type { FieldKey, FieldObservation } from "../providers/types";

/**
 * Due-date urgency (docs/ARCHITECTURE.md section 5). Dates are America/Toronto civil dates
 * (YYYY-MM-DD); no timestamps are compared, so DST never shifts a due date.
 */

export type Urgency = "overdue" | "due_soon" | "scheduled" | "past_not_overdue" | "unknown";

/** The slice of a merged card the urgency functions read. */
export interface UrgencyInput {
  fields: Partial<Record<FieldKey, Pick<FieldObservation, "status" | "value">>>;
}

const TORONTO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's civil date in Toronto as YYYY-MM-DD. `now` is injectable for tests. */
export function torontoToday(now: Date = new Date()): string {
  return TORONTO.format(now);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(d: string): number | null {
  const m = DATE.exec(d);
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** Whole days from `a` to `b` (both YYYY-MM-DD); positive when `b` is later. NaN if either is invalid. */
export function daysBetween(a: string, b: string): number {
  const x = dayNumber(a);
  const y = dayNumber(b);
  if (x === null || y === null) return Number.NaN;
  return y - x;
}

/** The provider's next payment due date, or null when it is not present / not a valid date. */
export function dueDateOf(card: UrgencyInput): string | null {
  const o = card.fields.next_payment_due_date;
  return o && o.status === "present" && typeof o.value === "string" && DATE.test(o.value)
    ? o.value
    : null;
}

export function dueUrgency(card: UrgencyInput, today: string): Urgency {
  const overdueObs = card.fields.is_overdue;
  const present = overdueObs?.status === "present";
  const flaggedOverdue = present && overdueObs.value === true;
  const explicitlyNotOverdue = present && overdueObs.value === false;

  if (flaggedOverdue) return "overdue";

  const due = dueDateOf(card);
  if (!due) return "unknown";

  const days = daysBetween(today, due);
  if (Number.isNaN(days)) return "unknown";
  if (days < 0) return explicitlyNotOverdue ? "past_not_overdue" : "overdue";
  if (days <= 7) return "due_soon";
  return "scheduled";
}

const RANK: Record<Urgency, number> = {
  overdue: 0,
  due_soon: 1,
  scheduled: 2,
  past_not_overdue: 3,
  unknown: 4,
};

export function urgencyRank(u: Urgency): number {
  return RANK[u];
}

/** Days from `today` to the due date; null when there is no usable due date. */
export function daysUntilDue(card: UrgencyInput, today: string): number | null {
  const due = dueDateOf(card);
  if (!due) return null;
  const d = daysBetween(today, due);
  return Number.isNaN(d) ? null : d;
}

export interface Sortable extends UrgencyInput {
  id: string;
  urgency: Urgency;
  institution_name?: string | null;
  name?: string | null;
}

/** overdue, due_soon, scheduled (date asc), past_not_overdue, unknown. Stable for equal keys. */
export function compareCards(a: Sortable, b: Sortable): number {
  const r = urgencyRank(a.urgency) - urgencyRank(b.urgency);
  if (r !== 0) return r;
  const da = dueDateOf(a);
  const db = dueDateOf(b);
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (da && !db) return -1;
  if (!da && db) return 1;
  const label = (c: Sortable) => `${c.institution_name ?? ""}|${c.name ?? ""}|${c.id}`;
  const la = label(a);
  const lb = label(b);
  return la < lb ? -1 : la > lb ? 1 : 0;
}
