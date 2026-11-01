import { describe, expect, it } from "vitest";
import { categorizeTx } from "@/lib/categorize";

describe("categorizeTx", () => {
  it("maps a known Plaid detailed category directly", () => {
    expect(categorizeTx("FOOD_AND_DRINK_COFFEE", "Whatever")).toBe("food");
    expect(categorizeTx("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", null)).toBe("transfers");
  });

  it("falls back to merchant keywords when the category is unknown or missing", () => {
    expect(categorizeTx(null, "Netflix.com")).toBe("subscriptions");
    expect(categorizeTx("SOMETHING_NEW", "Loblaws #123")).toBe("groceries");
  });

  it("falls back to category prefixes, then to other", () => {
    expect(categorizeTx("INCOME_BONUS", null)).toBe("income");
    expect(categorizeTx(null, "Totally Unknown Merchant")).toBe("other");
  });
});
