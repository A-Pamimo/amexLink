export function formatCurrency(
  amount: number,
  currency: string | null = "USD"
): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${(currency || "$")} ${amount.toFixed(2)}`;
  }
}

// Plaid sign convention: positive = outflow. For UI we want to show
// outflows as positive and inflows as negative red numbers.
export function displayAmount(amount: number, currency: string | null): string {
  return formatCurrency(amount, currency);
}

export function formatDate(d: string): string {
  // YYYY-MM-DD -> short locale-independent rendering
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? m} ${parseInt(day, 10)}, ${y}`;
}
