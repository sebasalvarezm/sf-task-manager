import { createClient } from "@supabase/supabase-js";

// Server-side Supabase client — uses the service_role key
// which bypasses all restrictions. Only used in API routes (server side).
// NEVER expose this in browser-side code.
export function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables. Check your .env.local file."
    );
  }
  return createClient(url, key);
}

export type SfCredentials = {
  id: string;
  access_token: string;
  refresh_token: string;
  instance_url: string;
  salesforce_user_id: string | null;
  token_issued_at: string;
  updated_at: string;
};

export type TaskActionLog = {
  id: string;
  task_id: string;
  account_name: string | null;
  action_type: "hard_delete" | "complete_reschedule" | "delay";
  days_used: number | null;
  old_date: string | null;
  new_date: string | null;
  executed_at: string;
  success: boolean;
  error_message: string | null;
};
