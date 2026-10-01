import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cookieValueForRole, roleFromCookieValue } from "../lib/roles";

describe("signed session cookie", () => {
  const original = process.env.APP_PASSWORD;
  beforeEach(() => {
    process.env.APP_PASSWORD = "test-password";
  });
  afterEach(() => {
    process.env.APP_PASSWORD = original;
  });

  it("round-trips both roles", async () => {
    expect(await roleFromCookieValue(await cookieValueForRole("admin"))).toBe("admin");
    expect(await roleFromCookieValue(await cookieValueForRole("intern"))).toBe("intern");
  });

  it("rejects the old fixed cookie values", async () => {
    expect(await roleFromCookieValue("authenticated")).toBeNull();
    expect(await roleFromCookieValue("intern")).toBeNull();
    expect(await roleFromCookieValue(undefined)).toBeNull();
  });

  it("rejects a tampered role or signature", async () => {
    const intern = await cookieValueForRole("intern");
    const [, exp, sig] = intern.split(".");
    expect(await roleFromCookieValue(`admin.${exp}.${sig}`)).toBeNull();
    expect(await roleFromCookieValue(`intern.${exp}.${"0".repeat(sig.length)}`)).toBeNull();
  });

  it("rejects an expired cookie", async () => {
    const old = await cookieValueForRole("admin", Date.now() - 8 * 24 * 3600 * 1000);
    expect(await roleFromCookieValue(old)).toBeNull();
  });

  it("is invalidated by a password change", async () => {
    const cookie = await cookieValueForRole("admin");
    process.env.APP_PASSWORD = "new-password";
    expect(await roleFromCookieValue(cookie)).toBeNull();
  });
});
