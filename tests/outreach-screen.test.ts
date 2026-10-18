import { describe, expect, it } from "vitest";
import { findLinkedInCompanyUrl } from "../lib/outreach-screen";

describe("LinkedIn company page from site text", () => {
  it("finds a company page in Jina markdown", () => {
    const text = "Follow us [LinkedIn](https://www.linkedin.com/company/tronia-systems/) and [Twitter](https://x.com/tronia)";
    expect(findLinkedInCompanyUrl(text)).toBe("https://www.linkedin.com/company/tronia-systems");
  });
  it("accepts regional hosts and upgrades http", () => {
    expect(findLinkedInCompanyUrl("http://ca.linkedin.com/company/acme")).toBe("https://ca.linkedin.com/company/acme");
  });
  it("ignores personal profiles", () => {
    expect(findLinkedInCompanyUrl("https://www.linkedin.com/in/dave-owner")).toBeNull();
  });
});
