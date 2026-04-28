"use client";
import { SWRConfig } from "swr";
import { Toaster } from "sonner";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
};

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: false,
        dedupingInterval: 4000,
      }}
    >
      {children}
      <Toaster theme="dark" position="bottom-right" />
    </SWRConfig>
  );
}
