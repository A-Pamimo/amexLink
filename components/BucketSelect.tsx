"use client";
import * as Select from "@radix-ui/react-select";
import { ALL_BUCKETS, BUCKET_COLORS, BUCKET_LABELS, type BucketKey } from "@/lib/types";

export function BucketSelect({
  value,
  onChange,
  className,
}: {
  value: BucketKey;
  onChange: (b: BucketKey) => void;
  className?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as BucketKey)}>
      <Select.Trigger
        className={
          "inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs hover:bg-white/10 " +
          (className ?? "")
        }
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: BUCKET_COLORS[value] }}
        />
        <Select.Value>{BUCKET_LABELS[value]}</Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 overflow-hidden rounded-md border border-white/10 bg-card text-sm shadow-xl"
        >
          <Select.Viewport className="p-1">
            {ALL_BUCKETS.map((b) => (
              <Select.Item
                key={b}
                value={b}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-white/10"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: BUCKET_COLORS[b] }}
                />
                <Select.ItemText>{BUCKET_LABELS[b]}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
