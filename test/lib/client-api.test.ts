import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, errorMessage } from "@/lib/client/api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function sentHeaders(): Headers {
  return fetchMock.mock.calls[0][1].headers as Headers;
}

describe("apiFetch", () => {
  it("adds X-AmexLens-Request on POST but not on GET", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch("/api/x", { method: "POST", body: "{}" });
    expect(sentHeaders().get("x-amexlens-request")).toBe("1");
    expect(sentHeaders().get("content-type")).toBe("application/json");

    fetchMock.mockClear();
    await apiFetch("/api/x");
    expect(sentHeaders().has("x-amexlens-request")).toBe(false);
  });

  it("returns parsed JSON on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [1] }));
    await expect(apiFetch("/api/x")).resolves.toEqual({ items: [1] });
  });

  it("maps { error: { code } } to ApiError", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "rate_limited" } }, 429));
    const err = (await apiFetch("/api/x", { method: "POST" }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
    expect(errorMessage("Sync failed", err)).toBe("Sync failed (rate_limited)");
  });

  it("maps { error: string } and falls back to http_<status>", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid json" }, 400));
    expect(await apiFetch("/a").catch((e) => e)).toMatchObject({ status: 400, code: "invalid json" });

    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 502 }));
    expect(await apiFetch("/a").catch((e) => e)).toMatchObject({ status: 502, code: "http_502" });

    // Provider-style object bodies without a code never leak through.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { error_message: "access-sandbox-abc leaked" } }, 500)
    );
    const err = (await apiFetch("/a").catch((e) => e)) as ApiError;
    expect(err.code).toBe("http_500");
    expect(err.message).not.toContain("access-sandbox");
  });

  it("redirects to /login on 401 before throwing", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/", assign } });
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "unauthorized" } }, 401));
    await expect(apiFetch("/api/items")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("does not reload /login itself on a failed sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/login", assign } });
    fetchMock.mockResolvedValue(jsonResponse({ error: "wrong password" }, 401));
    await expect(apiFetch("/api/auth/login", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(assign).not.toHaveBeenCalled();
  });
});
