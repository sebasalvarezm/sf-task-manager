import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Supabase cache table: in memory.
const cacheRows = new Map<string, Record<string, unknown>>();
vi.mock("../lib/supabase", () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      let key = "";
      const api = {
        select: () => api,
        eq: (_c: string, v: string) => ((key = v), api),
        maybeSingle: async () => ({ data: cacheRows.get(key) ?? null, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          cacheRows.set(row.query_key as string, row);
          return { error: null };
        },
      };
      return api;
    },
  }),
}));

const { geocodeLocation, parseQuery, cacheKey, clearGeocodeMemoryCache, nominatimClock } = await import("../lib/geocoder");

// Real OpenStreetMap answers for the test places (fetched Oct 1, 2026).
const OSM: Record<string, [number, number, string]> = {
  "q=Toronto": [43.6534817, -79.3839347, "Toronto, Ontario, Canada"],
  "q=Montreal, QC": [45.5031824, -73.5698065, "Montreal, Quebec, Canada"],
  "q=225 Front St W, Toronto, ON M5V 2X3": [43.6441813, -79.3853033, "225, Front Street West, Toronto, Ontario, Canada"],
  "q=Chicago, IL": [41.8755616, -87.6244212, "Chicago, Cook County, Illinois, United States"],
  "q=Des Moines, Iowa": [41.5868654, -93.6249494, "Des Moines, Polk County, Iowa, United States"],
  "postalcode=M5V 2X3&countrycodes=ca": [43.6442863, -79.3853434, "M5V 2X3, Toronto, Ontario, Canada"],
  "postalcode=50309&countrycodes=us": [41.5866988, -93.6217964, "50309, Des Moines, Polk County, Iowa, United States"],
};

function osmKey(url: URL): string {
  const p = url.searchParams;
  return p.get("q") ? `q=${p.get("q")}` : `postalcode=${p.get("postalcode")}&countrycodes=${p.get("countrycodes")}`;
}

type GoogleMode = "denied" | "ok" | "zero" | "http500";
let googleMode: GoogleMode = "denied";
let osmMode: "ok" | "429" | "down" | "empty" = "ok";
const calls: Array<{ host: string; url: URL; headers: Record<string, string> }> = [];

function fakeFetch(input: string | URL, init?: RequestInit) {
  const url = new URL(String(input));
  calls.push({ host: url.host, url, headers: (init?.headers ?? {}) as Record<string, string> });
  if (url.host === "maps.googleapis.com") {
    if (googleMode === "http500") return Promise.resolve(new Response("oops", { status: 500 }));
    if (googleMode === "denied")
      return Promise.resolve(
        Response.json({ status: "REQUEST_DENIED", error_message: "This API project is not authorized to use this API.", results: [] }),
      );
    if (googleMode === "zero") return Promise.resolve(Response.json({ status: "ZERO_RESULTS", results: [] }));
    return Promise.resolve(
      Response.json({
        status: "OK",
        results: [{ geometry: { location: { lat: 1, lng: 2 } }, formatted_address: "Google place" }],
      }),
    );
  }
  if (url.host === "nominatim.openstreetmap.org") {
    if (osmMode === "429") return Promise.resolve(new Response("", { status: 429 }));
    if (osmMode === "down") return Promise.reject(new TypeError("fetch failed"));
    const hit = OSM[osmKey(url)];
    if (osmMode === "empty" || !hit) return Promise.resolve(Response.json([]));
    return Promise.resolve(Response.json([{ lat: String(hit[0]), lon: String(hit[1]), display_name: hit[2] }]));
  }
  return Promise.reject(new Error(`unexpected ${url}`));
}

// No real 1.1s waits: a fake clock that records the waits instead.
const waits: number[] = [];
let fakeNow = 1_000_000;

describe("geocoder", () => {
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    googleMode = "denied";
    osmMode = "ok";
    calls.length = 0;
    waits.length = 0;
    cacheRows.clear();
    clearGeocodeMemoryCache();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    nominatimClock.now = () => fakeNow;
    nominatimClock.sleep = async (ms: number) => {
      waits.push(ms);
      fakeNow += ms;
    };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("recognises postal codes and ZIP codes on their own", () => {
    expect(parseQuery("M5V 2X3")).toEqual({ kind: "ca_postal", text: "M5V 2X3", postal: "M5V 2X3" });
    expect(parseQuery("m5v2x3").kind).toBe("ca_postal");
    expect(parseQuery("50309")).toEqual({ kind: "us_zip", text: "50309", postal: "50309" });
    expect(parseQuery("50309-1234").kind).toBe("us_zip");
    expect(parseQuery("225 Front St W, Toronto, ON M5V 2X3").kind).toBe("text");
    expect(cacheKey("  Toronto ")).toBe(cacheKey("toronto"));
  });

  it("with Google refusing the key, all seven test places still resolve (Canada and US) via OpenStreetMap", async () => {
    const expectations: Array<[string, number, number]> = [
      ["Toronto", 43.65, -79.38],
      ["Montreal, QC", 45.5, -73.57],
      ["225 Front St W, Toronto, ON M5V 2X3", 43.64, -79.39],
      ["Chicago, IL", 41.88, -87.62],
      ["Des Moines, Iowa", 41.59, -93.62],
      ["M5V 2X3", 43.64, -79.39],
      ["50309", 41.59, -93.62],
    ];
    for (const [place, lat, lng] of expectations) {
      const out = await geocodeLocation(place);
      expect(out.ok, place).toBe(true);
      if (out.ok) {
        expect(out.provider).toBe("openstreetmap");
        expect(out.point.lat).toBeCloseTo(lat, 1);
        expect(out.point.lng).toBeCloseTo(lng, 1);
      }
    }
  });

  it("uses Google first when it works, pinning postal codes to their country", async () => {
    googleMode = "ok";
    const out = await geocodeLocation("50309");
    expect(out.ok && out.provider).toBe("google");
    const google = calls.find((c) => c.host === "maps.googleapis.com")!;
    expect(google.url.searchParams.get("components")).toBe("postal_code:50309|country:US");
    expect(calls.some((c) => c.host === "nominatim.openstreetmap.org")).toBe(false);
  });

  it("sends OpenStreetMap a User-Agent with a contact email, and spaces calls 1.1s apart", async () => {
    await geocodeLocation("Toronto");
    await geocodeLocation("Chicago, IL");
    const osm = calls.filter((c) => c.host === "nominatim.openstreetmap.org");
    expect(osm[0].headers["User-Agent"]).toMatch(/Valstone-Trip-Planner\/1\.0 \(sebastian@valstonecorp\.com\)/);
    expect(osm[0].url.searchParams.get("email")).toBe("sebastian@valstonecorp.com");
    expect(waits.some((w) => w >= 1000)).toBe(true);
  });

  it("shortens OpenStreetMap's long place names", async () => {
    const { shortOsmAddress } = await import("../lib/geocoder");
    expect(
      shortOsmAddress({
        display_name: "Montreal, Urban agglomeration of Montreal, Montreal (administrative region), Quebec, Canada",
        address: { city: "Montreal", state: "Quebec", country: "Canada" },
      }),
    ).toBe("Montreal, Quebec, Canada");
    expect(
      shortOsmAddress({
        display_name: "x",
        address: { house_number: "225", road: "Front Street West", city: "Toronto", state: "Ontario", postcode: "M5V 2X3", country: "Canada" },
      }),
    ).toBe("225 Front Street West, Toronto, Ontario, M5V 2X3, Canada");
  });

  it("caches: the same place isn't looked up twice", async () => {
    await geocodeLocation("Toronto");
    calls.length = 0;
    const again = await geocodeLocation("  toronto ");
    expect(again.ok && again.provider).toBe("cache");
    expect(calls).toHaveLength(0);
    // ...and survives a cold start via the geocode_cache table.
    clearGeocodeMemoryCache();
    const cold = await geocodeLocation("Toronto");
    expect(cold.ok && cold.provider).toBe("cache");
    expect(calls).toHaveLength(0);
  });

  it("says 'not found' when a service answered with no match", async () => {
    googleMode = "zero";
    osmMode = "empty";
    const out = await geocodeLocation("Nowhereville, ZZ");
    expect(out).toMatchObject({ ok: false, reason: "not_found" });
    if (!out.ok) expect(out.message).toMatch(/Couldn't find "Nowhereville, ZZ"/);
  });

  it("says 'unavailable' (with Google's real reason) when no service could answer", async () => {
    googleMode = "denied";
    osmMode = "429";
    const out = await geocodeLocation("Toronto");
    expect(out).toMatchObject({ ok: false, reason: "unavailable" });
    if (!out.ok) {
      expect(out.message).toMatch(/geocoding service is unavailable/);
      expect(out.message).toMatch(/REQUEST_DENIED/);
      expect(out.message).toMatch(/not authorized to use this API/);
      expect(out.message).toMatch(/rate-limited/);
    }
  });

  it("falls back when Google errors or the key is missing", async () => {
    googleMode = "http500";
    expect((await geocodeLocation("Chicago, IL")).ok).toBe(true);
    delete process.env.GOOGLE_MAPS_API_KEY;
    clearGeocodeMemoryCache();
    cacheRows.clear();
    const out = await geocodeLocation("Des Moines, Iowa");
    expect(out.ok && out.provider).toBe("openstreetmap");
  });
});

describe("Scan Accounts", () => {
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    googleMode = "denied";
    osmMode = "ok";
    cacheRows.clear();
    clearGeocodeMemoryCache();
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("places Canadian and US accounts from their billing city, and explains the ones it can't", async () => {
    const { batchGeocodeAccounts } = await import("../lib/geocoding");
    const { results, failed } = await batchGeocodeAccounts([
      { id: "1", name: "Toronto Co", billingCity: "Toronto", billingState: null, billingCountry: null },
      { id: "2", name: "Iowa Co", billingCity: "Des Moines", billingState: "Iowa", billingCountry: null },
      { id: "3", name: "No City Co", billingCity: null },
    ]);
    expect(results.map((r) => r.accountId)).toEqual(["1", "2"]);
    expect(failed).toEqual([
      expect.objectContaining({ id: "3", kind: "unavailable", reason: expect.stringMatching(/no billing city.*Google Places said REQUEST_DENIED/) }),
    ]);
  });

  it("stops the scan with the real reason when no service can answer", async () => {
    osmMode = "down";
    const { geocodeAccountBatch, GeocodeServiceDownError } = await import("../lib/jobs/trip-geocode-runner");
    await expect(
      geocodeAccountBatch([
        { id: "1", name: "A", billingCity: "Toronto", billingState: null, billingCountry: null, website: null },
      ]),
    ).rejects.toBeInstanceOf(GeocodeServiceDownError);
  });
});
