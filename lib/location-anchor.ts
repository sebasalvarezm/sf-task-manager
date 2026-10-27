import { getAnthropicClient } from "./anthropic";
import { guardTown } from "./location-guard";
import { findBusinessDinnerRestaurants } from "./geocoding";
import { findRestaurants } from "./scout";
import { refreshPrepackagedEmail, type SourcingResult } from "./jobs/sourcing-runner";

/**
 * The town in "I will be near ___" and the restaurant in the subject must be
 * where the account is in Salesforce. Sourcing reads the address off the
 * website, and a company with several offices lists them all: MCS Rental
 * Software (White Waltham, UK in Salesforce, UK contact) got its Fribourg,
 * Switzerland office, so the email offered dinner in Fribourg (Oct 2026).
 *
 * Rule: when Salesforce has a usable city, it wins. The website address is
 * kept only when it is in that same city (it is then the better, street-level
 * input for the restaurant search).
 */

export type SfLocation = { city: string | null; state: string | null; country: string | null };

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "White Waltham, United Kingdom" / "Atlanta, GA, United States", or null when the city is unusable. */
export function salesforceAddress(sf: SfLocation | null | undefined): string | null {
  const city = guardTown(sf?.city ?? null);
  if (!city) return null;
  // Only a short state code goes in: the email's town parser reads the last
  // non-country part, so "White Waltham, Berkshire, UK" would come out as Berkshire.
  const state = sf?.state?.trim() && /^[A-Z]{2,3}$/.test(sf.state.trim()) ? sf.state.trim() : null;
  return [city, state, sf?.country?.trim() || null].filter(Boolean).join(", ");
}

/** True when the sourced address is in the Salesforce city (accents, case and "Saint"/"St" ignored). */
export function addressInCity(address: string | null | undefined, city: string): boolean {
  if (!address) return false;
  const a = ` ${norm(address)} `;
  const c = norm(city);
  return c.length > 0 && a.includes(` ${c} `);
}

/** Does this result need re-anchoring to Salesforce? Pure, so it is tested. */
export function needsAnchor(result: Pick<SourcingResult, "address">, sf: SfLocation | null | undefined): string | null {
  const target = salesforceAddress(sf);
  if (!target) return null;
  if (addressInCity(result.address, guardTown(sf!.city)!)) return null;
  return target;
}

/**
 * Re-point a sourcing result at the Salesforce city: address, a fresh
 * restaurant list for that city, and the draft rebuilt from both. Returns the
 * result unchanged when it already matches or Salesforce has no city.
 */
export async function anchorToSalesforce(result: SourcingResult, sf: SfLocation | null | undefined): Promise<SourcingResult> {
  const target = needsAnchor(result, sf);
  if (!target) return result;
  let restaurants = await findBusinessDinnerRestaurants(target).catch(() => [] as Array<{ name: string; description: string }>);
  if (restaurants.length === 0) {
    const client = getAnthropicClient();
    if (client) restaurants = (await findRestaurants(client, target, result.companyName ?? undefined).catch(() => null))?.restaurants ?? [];
  }
  const logs = [
    ...(result.logs ?? []),
    `Location set to Salesforce (${target})${result.address ? ` instead of the website's ${result.address}` : ""}.`,
  ];
  return refreshPrepackagedEmail({
    ...result,
    address: target,
    addressSource: "Salesforce",
    addressSourceUrl: null,
    locationConfidence: "city",
    restaurants,
    logs,
  });
}
