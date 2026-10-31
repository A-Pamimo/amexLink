import { describe, expect, it } from "vitest";
import {
  compareCards,
  daysBetween,
  dueUrgency,
  torontoToday,
  urgencyRank,
  type Sortable,
  type Urgency,
} from "@/lib/cards/urgency";
import type { FieldKey, FieldObservation } from "@/lib/providers/types";
import { ob, present } from "../helpers/cards";

const TODAY = "2026-03-07";

function card(due: string | null, overdue?: boolean | null) {
  const fields: Partial<Record<FieldKey, FieldObservation>> = {
    next_payment_due_date: due === null ? ob("not_supplied") : present(due),
  };
  if (overdue === true || overdue === false) fields.is_overdue = present(overdue);
  else if (overdue === null) fields.is_overdue = ob("not_supplied");
  return { fields };
}

describe("torontoToday", () => {
  it("is still the 7th at 04:30Z on the 2026 DST-start day", () => {
    expect(torontoToday(new Date("2026-03-08T04:30:00Z"))).toBe("2026-03-07");
  });

  it("rolls over at Toronto midnight, in both EST and EDT", () => {
    expect(torontoToday(new Date("2026-03-08T05:00:00Z"))).toBe("2026-03-08"); // 00:00 EST
    expect(torontoToday(new Date("2026-03-08T06:59:00Z"))).toBe("2026-03-08"); // 01:59 EST
    expect(torontoToday(new Date("2026-07-01T03:59:00Z"))).toBe("2026-06-30"); // 23:59 EDT
    expect(torontoToday(new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01"); // 00:00 EDT
    expect(torontoToday(new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-01"); // 00:30 EDT, fall-back day
  });

  it("defaults to the current time and returns YYYY-MM-DD", () => {
    expect(torontoToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("daysBetween", () => {
  it("counts civil days across the DST change", () => {
    expect(daysBetween("2026-03-07", "2026-03-14")).toBe(7);
    expect(daysBetween("2026-03-14", "2026-03-07")).toBe(-7);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });
  it("is NaN for malformed input", () => {
    expect(daysBetween("2026-03-07", "tomorrow")).toBeNaN();
  });
});

describe("dueUrgency", () => {
  it("due today is due_soon", () => {
    expect(dueUrgency(card(TODAY, false), TODAY)).toBe("due_soon");
  });
  it("today + 7 is due_soon and today + 8 is scheduled", () => {
    expect(dueUrgency(card("2026-03-14"), TODAY)).toBe("due_soon");
    expect(dueUrgency(card("2026-03-15"), TODAY)).toBe("scheduled");
  });
  it("yesterday with is_overdue:false is past_not_overdue", () => {
    expect(dueUrgency(card("2026-03-06", false), TODAY)).toBe("past_not_overdue");
  });
  it("yesterday with is_overdue null or absent is overdue", () => {
    expect(dueUrgency(card("2026-03-06", null), TODAY)).toBe("overdue");
    expect(dueUrgency(card("2026-03-06"), TODAY)).toBe("overdue");
  });
  it("is_overdue true is overdue even with a future or missing due date", () => {
    expect(dueUrgency(card("2026-04-01", true), TODAY)).toBe("overdue");
    expect(dueUrgency(card(null, true), TODAY)).toBe("overdue");
  });
  it("no usable due date is unknown", () => {
    expect(dueUrgency(card(null), TODAY)).toBe("unknown");
    expect(dueUrgency(card(null, false), TODAY)).toBe("unknown");
    expect(dueUrgency({ fields: { next_payment_due_date: present("soon") } }, TODAY)).toBe("unknown");
  });
  it("only a present due date counts (an error observation is not a date)", () => {
    expect(dueUrgency({ fields: { next_payment_due_date: ob("error", null, { error_code: "X" }) } }, TODAY)).toBe(
      "unknown"
    );
  });
});

describe("compareCards", () => {
  const mk = (id: string, urgency: Urgency, due: string | null): Sortable => ({
    id,
    urgency,
    ...card(due),
  });

  it("orders overdue, due_soon, scheduled by date asc, past_not_overdue, unknown", () => {
    const sorted = [
      mk("unknown", "unknown", null),
      mk("sched-late", "scheduled", "2026-05-01"),
      mk("past", "past_not_overdue", "2026-03-01"),
      mk("soon", "due_soon", "2026-03-10"),
      mk("sched-early", "scheduled", "2026-04-01"),
      mk("overdue-old", "overdue", "2026-02-01"),
      mk("overdue-new", "overdue", "2026-03-05"),
    ].sort(compareCards);
    expect(sorted.map((c) => c.id)).toEqual([
      "overdue-old",
      "overdue-new",
      "soon",
      "sched-early",
      "sched-late",
      "past",
      "unknown",
    ]);
  });

  it("urgencyRank is strictly increasing in that order", () => {
    const order: Urgency[] = ["overdue", "due_soon", "scheduled", "past_not_overdue", "unknown"];
    expect(order.map(urgencyRank)).toEqual([0, 1, 2, 3, 4]);
  });
});
