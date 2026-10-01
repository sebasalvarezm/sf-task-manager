import { describe, expect, it } from "vitest";
import { isDeadRefreshToken } from "../lib/oauth-refresh";

const res = (status: number, body: string) => new Response(body, { status });

describe("isDeadRefreshToken", () => {
  it("treats invalid_grant as a dead token", async () => {
    expect(await isDeadRefreshToken(res(400, '{"error":"invalid_grant"}'))).toBe(true);
    expect(await isDeadRefreshToken(res(400, '{"error":"invalid_grant","suberror":"consent_required"}'))).toBe(true);
  });
  it("keeps the connection on outages and rate limits", async () => {
    expect(await isDeadRefreshToken(res(503, "Service Unavailable"))).toBe(false);
    expect(await isDeadRefreshToken(res(429, '{"error":"invalid_grant"}'))).toBe(false);
    expect(await isDeadRefreshToken(res(400, '{"error":"temporarily_unavailable"}'))).toBe(false);
  });
});
