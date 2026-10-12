import { getSupabaseAdmin } from "./supabase";

/**
 * Seb's Outlook signature, for emails the tool sends through Microsoft Graph.
 *
 * Graph never adds the signature Outlook shows in its compose window (that is
 * a client feature), so sends from the tool used to go out without it. The
 * signature is stored once in `app_settings` (imported from a sent email or
 * pasted) and appended to every draft body the tool writes.
 */

const KEY = "outlook_signature";
const CACHE_MS = 60_000;

export type StoredSignature = { html: string; text: string; source: "imported" | "pasted"; updatedAt: string };

let cache: { at: number; value: StoredSignature | null } | null = null;

export async function getStoredSignature(): Promise<StoredSignature | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const { data } = await getSupabaseAdmin().from("app_settings").select("value").eq("key", KEY).maybeSingle();
    const v = data?.value as Partial<StoredSignature> | null | undefined;
    const value = v && typeof v.html === "string" && v.html.trim() ? { html: v.html, text: typeof v.text === "string" ? v.text : htmlToText(v.html), source: v.source === "pasted" ? "pasted" as const : "imported" as const, updatedAt: v.updatedAt ?? "" } : null;
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? null;
  }
}

export async function saveStoredSignature(sig: Omit<StoredSignature, "updatedAt"> | null): Promise<StoredSignature | null> {
  const supabase = getSupabaseAdmin();
  if (!sig) {
    await supabase.from("app_settings").delete().eq("key", KEY);
    cache = { at: Date.now(), value: null };
    return null;
  }
  const value: StoredSignature = { ...sig, updatedAt: new Date().toISOString() };
  const { error } = await supabase.from("app_settings").upsert({ key: KEY, value, updated_at: value.updatedAt }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  cache = { at: Date.now(), value };
  return value;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text (what the model writes) → simple HTML paragraphs, keeping line breaks. */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r/g, "").trim().split(/\n{2,}/);
  return paragraphs
    .map((p) => `<p style="margin:0 0 1em 0">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/(div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The HTML of the element that starts at `start` (an opening <div ...>), with nesting balanced. */
function balancedDiv(html: string, start: number): string | null {
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") {
      depth--;
      if (depth === 0) return html.slice(start, m.index + m[0].length);
    } else if (!/\/>$/.test(m[0])) {
      depth++;
    }
  }
  return null;
}

/**
 * Outlook wraps the signature in <div id="Signature"> (web, new Outlook, mobile).
 * Returns that block from a sent email's HTML, or null when there is none.
 * Inline images referenced as cid: attachments are dropped because they do
 * not travel with a new message.
 */
export function extractSignatureHtml(html: string): string | null {
  const m = /<div\b[^>]*\bid\s*=\s*["']?signature["']?[^>]*>/i.exec(html);
  if (!m) return null;
  const block = balancedDiv(html, m.index);
  if (!block) return null;
  const cleaned = block.replace(/<img\b[^>]*src\s*=\s*["']?cid:[^>]*>/gi, "");
  return htmlToText(cleaned).trim().length > 0 ? cleaned : null;
}

/**
 * Fallback for emails with no Signature div: the lines after Seb's sign-off
 * name in the plain-text body, up to a quoted-history marker.
 */
export function extractSignatureText(text: string): string | null {
  const lines = text.replace(/\r/g, "").split("\n");
  const idx = lines.findIndex((l) => /^(sebastian|seb)(\s+alvarez)?\s*$/i.test(l.trim()));
  if (idx < 0) return null;
  const rest: string[] = [];
  for (const l of lines.slice(idx + 1)) {
    const t = l.trim();
    if (/^(from|de)\s*:/i.test(t) || /^on .+ wrote:$/i.test(t) || /^_{5,}$/.test(t)) break;
    rest.push(l);
  }
  const sig = rest.join("\n").trim();
  return sig.length >= 10 ? sig : null;
}

/** Body the tool should send: the text as HTML plus the signature when one is stored. */
export function composeHtmlBody(text: string, signatureHtml: string | null): string {
  const body = textToHtml(text);
  if (!signatureHtml) return body;
  return `${body}<div>${signatureHtml}</div>`;
}
