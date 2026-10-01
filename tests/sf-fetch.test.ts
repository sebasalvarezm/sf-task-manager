import { beforeEach, describe, expect, it, vi } from "vitest";

const creds = (token: string) => ({
  id: "default",
  access_token: token,
  refresh_token: "r",
  instance_url: "https://example.my.salesforce.com",
  salesforce_user_id: "005000000000001",
  token_issued_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

const getValidCredentials = vi.fn();
const forceRefreshCredentials = vi.fn();
vi.mock("../lib/token-manager", () => ({ getValidCredentials, forceRefreshCredentials }));

const { sfFetch, sfErrorText, isSalesforceId } = await import("../lib/sf-query");

describe("sfFetch", () => {
  beforeEach(() => {
    getValidCredentials.mockReset();
    forceRefreshCredentials.mockReset();
    vi.unstubAllGlobals();
  });

  it("refreshes once and retries when Salesforce says the session expired", async () => {
    getValidCredentials.mockResolvedValue(creds("old"));
    forceRefreshCredentials.mockResolvedValue(creds("new"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('[{"errorCode":"INVALID_SESSION_ID"}]', { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await sfFetch("/services/data/v62.0/query/?q=x");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new");
  });

  it("reports NOT_CONNECTED when the refresh token is gone", async () => {
    getValidCredentials.mockResolvedValue(creds("old"));
    forceRefreshCredentials.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(sfFetch("/x")).rejects.toThrow("NOT_CONNECTED");
  });
});

describe("sfErrorText", () => {
  it("turns Salesforce error JSON into a sentence", async () => {
    const text = await sfErrorText(
      new Response('[{"message":"entity is deleted","errorCode":"ENTITY_IS_DELETED","fields":[]}]', {
        status: 404,
      }),
    );
    expect(text).toBe("Salesforce said: entity is deleted (ENTITY_IS_DELETED)");
  });
  it("strips HTML error pages", async () => {
    const text = await sfErrorText(new Response("<html><body>Bad Gateway</body></html>", { status: 502 }));
    expect(text).toBe("Salesforce returned HTTP 502: Bad Gateway");
  });
});

describe("isSalesforceId", () => {
  it("accepts 15 and 18 character ids only", () => {
    expect(isSalesforceId("001000000000001")).toBe(true);
    expect(isSalesforceId("001000000000001AAA")).toBe(true);
    expect(isSalesforceId("../Account/001000000000001")).toBe(false);
    expect(isSalesforceId("0010000000000010")).toBe(false);
  });
});
