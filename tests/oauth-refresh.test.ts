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

import { isSelfAddress } from "../lib/microsoft";

describe("isSelfAddress", () => {
  const ids = new Set(["sebastian@valstonecorp.com", "sebastian@valstonecorporation.onmicrosoft.com"]);
  it("matches primary, alias, and tenant-alias by local part", () => {
    expect(isSelfAddress("Sebastian@ValstoneCorp.com", ids)).toBe(true);
    expect(isSelfAddress("sebastian@valstonecorporation.onmicrosoft.com", ids)).toBe(true);
    expect(isSelfAddress("sebastian@other-tenant.onmicrosoft.com", ids)).toBe(true);
    expect(isSelfAddress("johnhardwick@intouchmonitoring.com", ids)).toBe(false);
    expect(isSelfAddress("", ids)).toBe(false);
  });
});
