import { describe, expect, it } from "vitest";
import {
  accountWhereClause,
  normalizeDomain,
  parseAccountQuery,
  pickAccount,
  rankAccounts,
  scoreNameMatch,
} from "../lib/account-match";

const acct = (accountName: string, website: string | null = null, accountId = accountName) => ({
  accountId,
  accountName,
  website,
});

describe("parseAccountQuery", () => {
  it("treats plain names as names", () => {
    expect(parseAccountQuery("  ITS ")).toEqual({ kind: "name", name: "ITS" });
    expect(parseAccountQuery("Deliver Plus")).toEqual({ kind: "name", name: "Deliver Plus" });
    expect(parseAccountQuery("Track'em")).toEqual({ kind: "name", name: "Track'em" });
  });
  it("detects URLs and bare domains", () => {
    expect(parseAccountQuery("https://www.its-software.com/products")).toMatchObject({
      kind: "domain",
      domain: "its-software.com",
    });
    expect(parseAccountQuery("bargeops.com")).toMatchObject({ kind: "domain", domain: "bargeops.com" });
    expect(parseAccountQuery("www.inyxa.com")).toMatchObject({ kind: "domain", domain: "inyxa.com" });
  });
  it("does not mistake names with dots for domains", () => {
    expect(parseAccountQuery("Acme Inc.")).toEqual({ kind: "name", name: "Acme Inc." });
  });
});

describe("normalizeDomain", () => {
  it("strips scheme, www, path, port", () => {
    expect(normalizeDomain("HTTPS://WWW.Acme.com:443/about?x=1")).toBe("acme.com");
    expect(normalizeDomain("http://app.acme.co.uk/")).toBe("app.acme.co.uk");
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("not a site")).toBeNull();
  });
});

describe("scoreNameMatch / rankAccounts", () => {
  it("ranks exact above starts-with above whole word above contains", () => {
    const ranked = rankAccounts({ kind: "name", name: "ITS" }, [
      acct("BrigitSolutions"),
      acct("Business Exits"),
      acct("ITS Global"),
      acct("ITS"),
      acct("Amtech ITS Division"),
      acct("Its"),
    ]);
    expect(ranked.map((a) => a.accountName)).toEqual([
      "ITS",
      "Its",
      "ITS Global",
      "Amtech ITS Division",
      "Business Exits",
      "BrigitSolutions",
    ]);
  });
  it("treats punctuation-only differences as near-exact", () => {
    expect(scoreNameMatch("Trackem", "Track'em")).toBe(1);
    expect(scoreNameMatch("its ltd", "ITS Ltd.")).toBe(1);
  });
});

describe("pickAccount", () => {
  it("returns the exact match even when many others contain the letters", () => {
    const { account } = pickAccount({ kind: "name", name: "ITS" }, [
      acct("BrigitSolutions"),
      acct("Business Exits"),
      acct("ITS", null, "001A"),
      acct("ITS Global"),
    ]);
    expect(account?.accountId).toBe("001A");
  });
  it("is ambiguous when two accounts share the exact name", () => {
    const { account, candidates } = pickAccount({ kind: "name", name: "ITS" }, [
      acct("ITS", null, "001A"),
      acct("ITS", null, "001B"),
    ]);
    expect(account).toBeNull();
    expect(candidates).toHaveLength(2);
  });
  it("accepts a single contains-match when nothing better exists", () => {
    const { account } = pickAccount({ kind: "name", name: "Deliver" }, [acct("Deliver Plus")]);
    expect(account?.accountName).toBe("Deliver Plus");
  });
  it("stays ambiguous for several non-exact matches", () => {
    const { account, candidates } = pickAccount({ kind: "name", name: "Track" }, [
      acct("Track'em"),
      acct("TrackVia"),
    ]);
    expect(account).toBeNull();
    expect(candidates.map((c) => c.accountName)).toEqual(["Track'em", "TrackVia"]);
  });
  it("matches a pasted URL on the Website domain, ignoring www and paths", () => {
    const query = parseAccountQuery("https://www.bargeops.com/pricing");
    const { account } = pickAccount(query, [
      acct("BargeOps", "http://bargeops.com", "001C"),
      acct("Barge Operators Inc", "https://bargeoperators.com"),
      acct("No Site", null),
    ]);
    expect(account?.accountId).toBe("001C");
  });
  it("prefers the exact domain over a sub-domain", () => {
    const query = parseAccountQuery("acme.com");
    const { account, candidates } = pickAccount(query, [
      acct("Acme Portal", "https://portal.acme.com", "sub"),
      acct("Acme", "https://www.acme.com", "root"),
    ]);
    expect(account?.accountId).toBe("root");
    expect(candidates).toHaveLength(2);
  });
});

describe("accountWhereClause", () => {
  it("escapes quotes and queries both exact and contains", () => {
    expect(accountWhereClause({ kind: "name", name: "Track'em" })).toBe(
      "(Name = 'Track\\'em' OR Name LIKE '%Track\\'em%')",
    );
    expect(accountWhereClause({ kind: "domain", domain: "acme.com", raw: "acme.com" })).toBe(
      "Website LIKE '%acme.com%'",
    );
  });
});
