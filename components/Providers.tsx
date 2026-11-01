"use client";
import { SWRConfig } from "swr";
import { Toaster } from "sonner";
import { swrFetcher } from "@/lib/client/api";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher: swrFetcher,
        revalidateOnFocus: false,
        dedupingInterval: 4000,
      }}
    >
      {children}
      <Toaster theme="dark" position="bottom-right" />
    </SWRConfig>
  );
}
