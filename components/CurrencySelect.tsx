"use client";
import * as Select from "@radix-ui/react-select";
import { useEffect } from "react";
import useSWR from "swr";
import { defaultCurrency, UNKNOWN_CURRENCY } from "@/lib/currency";

const STORAGE_KEY = "amexlens.currency";
const NONE: string[] = [];

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(v: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* storage unavailable (private mode, blocked): the choice just is not remembered */
  }
}

/**
 * Picks which currency the dashboard shows. Totals are per currency and never combined, so
 * this is a selector, not a filter on a combined figure. Hidden when only one currency exists,
 * but it still reports that currency to the parent so the charts load.
 */
export function CurrencySelect({
  value,
  onChange,
}: {
  value?: string;
  onChange: (currency: string | undefined) => void;
}) {
  const { data } = useSWR<{ currencies: string[] }>("/api/stats/currencies");
  const currencies = data?.currencies ?? NONE;

  useEffect(() => {
    if (currencies.length === 0) return;
    if (value && currencies.includes(value)) return;
    const stored = readStored();
    onChange(stored && currencies.includes(stored) ? stored : defaultCurrency(currencies));
  }, [currencies, value, onChange]);

  if (currencies.length <= 1) return null;

  return (
    <Select.Root
      value={value}
      onValueChange={(v) => {
        writeStored(v);
        onChange(v);
      }}
    >
      <Select.Trigger
        aria-label="Currency"
        className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
      >
        <Select.Value placeholder="Currency">{value}</Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 overflow-hidden rounded-md border border-white/10 bg-card text-sm shadow-xl"
        >
          <Select.Viewport className="p-1">
            {currencies.map((c) => (
              <Select.Item
                key={c}
                value={c}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-white/10"
              >
                <Select.ItemText>
                  {c === UNKNOWN_CURRENCY ? "UNKNOWN (currency unknown)" : c}
                </Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
