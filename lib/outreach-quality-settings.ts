import { getSupabaseAdmin } from "./supabase";
import {
  coerceQualityThresholds,
  DEFAULT_QUALITY_THRESHOLDS,
  type QualityThresholds,
} from "./outreach-quality";

// Admin-editable scoring rules for the outreach quality ("BS") indicator,
// stored as one JSONB row in `app_settings` so the business rules can change
// without a deploy. See supabase/setup.sql.

const SETTINGS_KEY = "outreach_quality_thresholds";

/**
 * The active thresholds, or the defaults.
 *
 * Never throws and never returns a partial object: a missing row, an unreachable
 * Supabase, or a malformed blob all resolve to defaults, because the Stats page
 * must render even when settings are broken.
 */
export async function getQualityThresholds(): Promise<QualityThresholds> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();

    if (error || !data) return { ...DEFAULT_QUALITY_THRESHOLDS };
    return coerceQualityThresholds(data.value);
  } catch {
    return { ...DEFAULT_QUALITY_THRESHOLDS };
  }
}

/**
 * Validates and persists the thresholds, returning what was actually stored
 * (which may differ from the input where a field failed validation and fell
 * back to its default). Throws on a Supabase write failure so the route can
 * surface it.
 */
export async function saveQualityThresholds(
  raw: unknown
): Promise<QualityThresholds> {
  const thresholds = coerceQualityThresholds(raw);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase.from("app_settings").upsert(
    {
      key: SETTINGS_KEY,
      value: thresholds,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (error) throw new Error(error.message);
  return thresholds;
}
