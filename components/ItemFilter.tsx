"use client";
import * as Select from "@radix-ui/react-select";
import useSWR from "swr";
import type { PlaidItem } from "@/lib/types";

const ALL = "__all__";

export function ItemFilter({
  value,
  onChange,
}: {
  value?: string;
  onChange: (item_id: string | undefined) => void;
}) {
  const { data } = useSWR<{ items: Omit<PlaidItem, "access_token">[] }>("/api/items");
  const items = data?.items ?? [];
  if (items.length <= 1) return null;

  return (
    <Select.Root
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? undefined : v)}
    >
      <Select.Trigger className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10">
        <Select.Value placeholder="All cards">
          {value
            ? items.find((i) => i.item_id === value)?.institution_name ?? "Card"
            : "All cards"}
        </Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 overflow-hidden rounded-md border border-white/10 bg-card text-sm shadow-xl"
        >
          <Select.Viewport className="p-1">
            <Select.Item
              value={ALL}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-white/10"
            >
              <Select.ItemText>All cards</Select.ItemText>
            </Select.Item>
            {items.map((item) => (
              <Select.Item
                key={item.item_id}
                value={item.item_id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-white/10"
              >
                <Select.ItemText>
                  {item.institution_name ?? item.item_id}
                </Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
