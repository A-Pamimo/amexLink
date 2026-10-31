// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldValue, type FieldObs } from "@/components/FieldValue";

afterEach(() => cleanup());

const OBSERVED = "2026-10-31T12:00:00.000Z";

function obs(over: Partial<FieldObs>): FieldObs {
  return { status: "not_supplied", value: null, observed_at: OBSERVED, error_code: null, provider: "plaid", ...over };
}

describe("FieldValue gap text (a missing field says why)", () => {
  const cases: Array<[Partial<FieldObs>, string]> = [
    [{ status: "not_supplied" }, "Not supplied by Plaid"],
    [{ status: "not_supported" }, "Plaid does not support this field at this institution"],
    [{ status: "consent_required" }, "Reconnect Plaid to grant liabilities access"],
    [{ status: "error", error_code: "PRODUCT_NOT_READY" }, "Unavailable (Plaid error PRODUCT_NOT_READY)"],
  ];

  it.each(cases)("%j", (over, text) => {
    const { container } = render(<FieldValue obs={obs(over)} kind="money" currency="CAD" />);
    const el = screen.getByText(text);
    expect(el.textContent).toBe(text);
    // The tooltip carries provenance and when it was observed.
    expect(el.getAttribute("title")).toContain(OBSERVED);
    expect(el.getAttribute("title")).toContain("Plaid");
    // Display only: no way to type a value in.
    expect(container.querySelector("input, button, textarea, select, [contenteditable]")).toBeNull();
  });

  it("an error without a code still says it is a provider error", () => {
    render(<FieldValue obs={obs({ status: "error" })} kind="money" currency="CAD" />);
    expect(screen.getByText("Unavailable (Plaid error unknown)")).toBeTruthy();
  });

  it("a status other than error never shows an error code", () => {
    render(<FieldValue obs={obs({ status: "not_supplied", error_code: "NO_OBSERVATION" })} kind="money" />);
    expect(screen.queryByText(/NO_OBSERVATION/)).toBeNull();
  });
});

describe("FieldValue present values", () => {
  it("money is formatted in the card currency", () => {
    const { container, rerender } = render(
      <FieldValue obs={obs({ status: "present", value: 1234.5 })} kind="money" currency="CAD" />
    );
    expect(container.textContent).toMatch(/1,234\.50/);
    const cad = container.textContent;
    rerender(<FieldValue obs={obs({ status: "present", value: 1234.5 })} kind="money" currency="EUR" />);
    expect(container.textContent).not.toBe(cad);
    expect(container.textContent).toContain("€");
  });

  it("a date shows YYYY-MM-DD plus relative wording from the injected Toronto today", () => {
    const { container } = render(
      <FieldValue obs={obs({ status: "present", value: "2026-11-03" })} kind="date" today="2026-10-31" />
    );
    expect(container.textContent).toBe("2026-11-03 (in 3 days)");
  });

  it("booleans are Yes / No (false is a real value, not a gap)", () => {
    const { container, rerender } = render(<FieldValue obs={obs({ status: "present", value: false })} kind="boolean" />);
    expect(container.textContent).toBe("No");
    rerender(<FieldValue obs={obs({ status: "present", value: true })} kind="boolean" />);
    expect(container.textContent).toBe("Yes");
  });

  it("APRs show each type with its percentage and label the penalty APR", () => {
    const value = [
      { apr_type: "purchase_apr", apr_percentage: 20.99, balance_subject_to_apr: null, interest_charge_amount: null },
      { apr_type: "penalty_apr", apr_percentage: 29.99, balance_subject_to_apr: null, interest_charge_amount: null },
    ];
    const { container } = render(<FieldValue obs={obs({ status: "present", value })} kind="apr" />);
    expect(container.textContent).toContain("Purchase 20.99%");
    expect(container.textContent).toContain("Penalty 29.99%");
    expect(container.querySelector("input, button")).toBeNull();
  });

  it("a present value of the wrong shape is reported, not rendered", () => {
    render(<FieldValue obs={obs({ status: "present", value: "12" })} kind="money" currency="CAD" />);
    expect(screen.getByText("Unexpected value from Plaid")).toBeTruthy();
  });
});
