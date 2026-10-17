# DESIGN.md — Design System Guide

This file governs every UI decision in this repo. Read it before writing any component, page, or style. The target aesthetic is modern fintech back-office software of the kind Ramp ships: quiet, dense, precise, trustworthy. If a choice is not covered here, pick the more restrained option.

**Accent is set:** Valstone orange `#E84C0E` (chosen Oct 2026). Tokens live in `tailwind.config.ts` and `app/globals.css`; class names `navy`, `brand`, `surface`, `line`, `ink`, `ok`, `warn`, `danger`, `info` map onto the values below.

---

## 1. The one-paragraph brief

Build software that looks like it was designed by a finance team that cares about typography. The interface is a calm, warm, near-monochrome workspace where the data is the visual interest. Nothing decorates. Every pixel is either information, structure, or breathing room. One accent colour marks the single most important action on screen and nothing else. Hierarchy comes from type size, spacing, and grey value, not from weight, colour, or boxes. It should feel like a well-set financial statement that happens to be interactive.

How a PM would describe it: "Editorial, not playful. Dense, not cluttered. Warm, not cold. Confident, not loud. It respects the user's time and intelligence. It never tries to delight; it tries to be correct and fast, and the delight comes from that."

---

## 2. Anti-patterns (hard bans)

These are the tells of generic generated UI. Never do any of them.

- Purple-to-blue or any gradient backgrounds, gradient text, gradient buttons
- Glassmorphism, frosted blur cards, glow effects, neon borders
- Large border radii (anything over 8px on containers, over 6px on controls). No pill-shaped buttons.
- Drop shadows deeper than a 1px hairline border can achieve. Default to borders, not shadows.
- Emoji in UI copy, icons, or empty states
- Sparkle icons, "✨ AI-powered" badges, rainbow AI accents. AI output is presented as plain, sober text (see §9).
- Title Case Labels On Everything. Use sentence case.
- Bold everything. Body and most headings are regular weight (400). Bold is reserved (see §4).
- Cards inside cards inside cards. Max one level of card nesting.
- Hero sections, marketing-style centred layouts, giant illustrations, blob shapes
- Colourful icon backgrounds (the round pastel circle behind every icon). Icons are monochrome line icons.
- Multiple accent colours competing. One accent. Semantic colours only for semantic meaning.
- Placeholder copy like "Welcome back! 👋", "Let's get started!", "Oops, something went wrong!"
- Toasts and modals for things a quiet inline state could handle
- Default browser blue links, default focus rings, default `font-family: sans-serif`
- Skeleton loaders that shimmer with a gradient. Use a flat, static, slightly darker grey block.

---

## 3. Colour

Warm, not cool. The neutral scale has a faint yellow-brown undertone (stone, not slate). Backgrounds are off-white, never pure white for the page, and surfaces sit on top in pure white.

### Neutral scale
```css
:root {
  --bg-page:        #F5F4F0;  /* warm off-white page background */
  --bg-sidebar:     #EFEEEA;  /* one step darker than page */
  --bg-surface:     #FFFFFF;  /* cards, panels, inputs */
  --bg-surface-2:   #F7F6F3;  /* selected row, hover, secondary surface */
  --bg-surface-3:   #ECEBE7;  /* pressed state, code, dividers-as-fill */

  --border:         #E3E1DC;  /* default hairline */
  --border-strong:  #C9C6BF;  /* input borders, emphasised dividers */

  --text-primary:   #1A1A1A;  /* near-black, never #000 */
  --text-secondary: #5F5E5A;  /* labels, metadata, descriptions */
  --text-tertiary:  #8B8985;  /* placeholders, timestamps, disabled */
  --text-inverse:   #FFFFFF;
}
```

### Accent (exactly one, chosen on the day)

**STOP. The accent colour is deliberately not set in this file.** Before you write the first line of UI code, CSS, or Tailwind config in this repo, you must ask the user which accent colour to use. Do not assume lime-yellow. Do not pick a default silently. Ask once, in a single short question, offering the options below plus "something else (give me a hex)". Once answered, write the chosen values into this file under `--accent` (replace the `UNSET` lines), and into the token file, and never ask again for the rest of the project.

Ask it like this:

> Which accent colour for this project? (a) Acid lime #E8F04A, Ramp-style. (b) Signal orange #F4640A. (c) Electric blue #2F5BFF. (d) Deep green #1F6B47. (e) Ink black #1A1A1A, monochrome with a black primary button. (f) Something else, give me a hex.

Pre-vetted options with their derived hover and on-accent text colours (text on accent must pass 4.5:1 contrast):

| Option | `--accent` | `--accent-hover` | `--accent-text` |
|---|---|---|---|
| Acid lime | `#E8F04A` | `#DDE63E` | `#1A1A1A` |
| Signal orange | `#F4640A` | `#E05A08` | `#FFFFFF` |
| Electric blue | `#2F5BFF` | `#2650E6` | `#FFFFFF` |
| Deep green | `#1F6B47` | `#1A5B3C` | `#FFFFFF` |
| Ink black | `#1A1A1A` | `#000000` | `#FFFFFF` |

If the user supplies a custom hex: derive hover by darkening 6–8% in HSL, and set `--accent-text` to `#1A1A1A` if the accent's relative luminance is above 0.4, otherwise `#FFFFFF`. If the custom colour is close to `--info` (#3B5BDB), change `--info` to the dusty violet `#7A6FA8` so progress bars and the primary button never share a hue.

```css
:root {
  --accent:         #E84C0E;  /* Valstone orange. Primary CTA, count badges, nothing else */
  --accent-hover:   #D64408;
  --accent-text:    #FFFFFF;
}
```
Whatever the colour, the rules do not change: the accent appears at most once or twice per screen, on the primary action button and small notification count badges. It is never used for text colour, links, icons, backgrounds, or charts. Everything else in this file stays warm neutral.

### Semantic (muted, desaturated, used only for meaning)
```css
:root {
  --positive:       #1F6B47;  /* approve, success, complete. Deep forest green */
  --positive-bg:    #E6F2EC;
  --negative:       #B5441F;  /* reject, error, destructive. Burnt orange-red, not fire-engine red */
  --negative-bg:    #F9ECE6;
  --warning:        #8A6A1A;
  --warning-bg:     #F7F0DC;
  --info:           #3B5BDB;  /* progress bars, links in data context. Only blue in the system */
  --info-bg:        #E9EDFA;
}
```
Semantic colours are used for: status text, status pills, the Approve/Reject button pair, progress fill. They are not used decoratively.

### Data visualisation
Charts use the neutral scale plus at most two muted hues: `--info` (#3B5BDB) and a dusty violet (#7A6FA8). Fills are 15–25% opacity of the stroke. No gridlines, or at most horizontal hairlines in `--border`. No legends where a direct label works. No 3D, no donut charts with centre text bigger than the chart.

---

## 4. Typography

One typeface. Inter (or the system's Inter-metric equivalent). Load weights 400 and 500 only. 600 is permitted for one or two display numbers per screen. 700 is never loaded.

```css
:root {
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-feature-settings: "cv11", "ss01", "tnum"; /* tabular numerals everywhere */
}
```

### Scale
| Token | Size / line | Weight | Use |
|---|---|---|---|
| `display` | 32px / 38px | 400 | Page greeting, single hero number ("$712.65 USD at Uluh") |
| `h1` | 24px / 30px | 400 | Page title |
| `h2` | 18px / 24px | 400 | Section title ("Requires your approval", "Policy & controls") |
| `h3` | 15px / 20px | 500 | Card title, row primary text |
| `body` | 14px / 20px | 400 | Default |
| `small` | 13px / 18px | 400 | Metadata, secondary lines, helper text |
| `micro` | 11px / 14px | 500 | Badges, uppercase eyebrow labels (rare) |
| `stat` | 24–28px / 1.1 | 400 | KPI values ("$405K", "$1.9M") |

Rules:
- Hierarchy comes from size and colour (`--text-primary` vs `--text-secondary`), not weight. Two adjacent lines of text should differ in size or grey, rarely in weight.
- Headings are regular weight. Yes, really. A 24px regular heading over 14px body reads as a heading.
- All numbers use tabular figures (`tnum`) so columns align.
- Sentence case for everything: headings, buttons, labels, menu items. No Title Case, no ALL CAPS except `micro` eyebrows.
- Letter-spacing: 0 for body, -0.01em for display and h1, +0.04em for micro uppercase.
- Max line length for prose: 65ch.

---

## 5. Spacing, radius, borders

4px base grid. Use only these values: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.

```css
:root {
  --radius-sm: 4px;   /* badges, tags, inputs, buttons */
  --radius-md: 6px;   /* cards, panels, menus */
  --radius-lg: 8px;   /* modals, drawers. Maximum. */
  --shadow-none: none;
  --shadow-menu: 0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.06); /* dropdowns and popovers only */
}
```

- Cards: `--bg-surface`, `1px solid --border`, `--radius-md`, no shadow. Padding 16–20px.
- Dividers between rows: `1px solid --border`. Never full-bleed to the card edge if the content is indented; align divider to the content.
- Page gutters: 32px on desktop, 16px on mobile. Sidebar 260px.
- Vertical rhythm between sections: 32px. Between a section heading and its content: 12–16px.
- Density is a feature. Table rows are 44–52px tall with a primary line and a `small` secondary line in `--text-secondary`.

---

## 6. Layout patterns

Application shell: fixed left sidebar (`--bg-sidebar`), top command bar with a wide search input ("⌘K Search for anything"), main content column max 1120px, optional right rail (320px) for summary cards and primary actions.

Detail views use a three-pane split: list on the left (280px), detail in the centre, evidence/preview on the right (receipt, document, chart). Panes are separated by a 1px border, not by gaps or shadows.

Sections are collapsible with a chevron on the left of the heading. Section headings sit outside the card; the card contains the rows.

Primary action lives top-right of the right rail or bottom-right of a detail pane, and is the only thing on screen using `--accent` or `--positive`.

Empty space is used generously above the fold (page title has 32–40px above it) and tightly within data (rows, tables).

---

## 7. Components

### Buttons
- Primary: `--accent` background, `--accent-text`, 500 weight, 36–40px tall, `--radius-sm`, no shadow, no icon unless essential.
- Positive/negative pair (Approve / Reject): solid `--positive` with white text; outlined `--negative` with `--negative` text. Equal width, side by side.
- Secondary: white, `1px solid --border-strong`, `--text-primary`.
- Ghost: no border, `--text-secondary`, hover `--bg-surface-2`.
- Show keyboard shortcut hints inside buttons as small bordered key caps (`⌘ ↵`) in `--text-tertiary`.
- Never add a loading spinner inside a button; disable it and change the label ("Approving…").

### Inputs
- White, `1px solid --border-strong`, `--radius-sm`, 40px tall, 12px horizontal padding. Floating or top-aligned label in `small` `--text-secondary`. Helper text below in `small` `--text-tertiary`.
- Focus: `border-color: --text-primary` and a 2px outer ring of `--bg-surface-3`. Not blue.
- Selects use a small chevron-down in `--text-secondary`. Combobox-style search inside long lists.

### Rows / list items
- Left: 32px monochrome icon or 28px logo in a plain circle with `--bg-surface-2` background (no colour).
- Middle: primary text (h3 weight 500 or body 400) and one secondary line in `small` `--text-secondary`, separated from other metadata by ` · ` middots.
- Right: amount in tabular figures, then a chevron-right or overflow menu (`⋮`).
- Hover: `--bg-surface-2`. Selected: `--bg-surface-2` plus a 2px left border in `--text-primary`.

### Badges and pills
- Count badge: `--accent` background, `--accent-text`, `micro` weight 500, `--radius-sm`, min-width 20px.
- Status pill: semantic `-bg` colour with semantic text ("Complete" in `--positive-bg`/`--positive`). `--radius-sm`, not full pill.
- Tag chips (categories, merchants): white, hairline border, icon left (check-circle for allowed, x-circle for blocked), `small` text. Wrap in a bordered container.

### Progress and meters
- 6px tall bar, `--radius-sm`, track in `--bg-surface-3`, fill in `--info`. Segmented fills (two colours) are fine for split budgets. Label and remaining value ("$682.92 left") on one line above the bar, value right-aligned.

### Links
- `--text-primary`, underlined with `text-decoration-thickness: 1px; text-underline-offset: 2px`. Not blue. "View all" with a count badge next to it.

### Tables
- Header row: `small` `--text-secondary`, regular weight, no background fill. Rows separated by `--border` hairlines. Numeric columns right-aligned, tabular figures. No zebra striping. Hover highlights row.

### Icons
- Single set (Lucide or Phosphor Light). 16px in text, 20px in navigation. 1.5px stroke. `currentColor`. Never filled, never coloured except semantic states.

### Navigation
- Sidebar items: 36px tall, `body` text, icon left, count badge right (uses `--accent`). Active item: `--bg-surface-3` background, `--text-primary`. Grouped with 16px gaps and hairline dividers between groups. A "Setup guide" or onboarding block sits at the top with a thin progress bar.

### Callouts (including AI)
- White card, 1px border, optionally a 1px `--positive` border when the callout is a recommendation. Heading in `--positive` or `--text-primary`, weight 500. Body is a plain bulleted list of reasoning in `body` text. Thumbs up / thumbs down in `--text-tertiary` top-right. No icon glow, no gradient, no sparkle.

---

## 8. Data and copy formatting

- Currency: `$712.65 USD`, `$642,530.35 total`, abbreviate on dashboards: `$405K`, `$1.9M`. Always 2 decimals when not abbreviated.
- Dates: `Mar 21, 2026 at 4:05 PM`. Relative dates only in feeds ("2h ago").
- Percent change: `↑ 3.78%` with arrow glyph, coloured `--positive` / `--negative` only when the direction has a value judgement.
- Counts in headings: `8 bills`, `4 reimbursements`, `View all 38`.
- Metadata strings joined with ` · ` (middot with spaces).
- Labels are nouns or short noun phrases: "Spent from", "Entity", "Memo", "Receipt". No "Please select…".
- Button labels are verbs, one or two words: "Issue", "Approve", "Review", "Next".
- Helper text explains the effect, in one sentence, no exclamation: "Only allow spend that happens on or after Apr 1, 2026, 12:00 AM."
- Greeting: "Good morning, David". Nothing after it.
- Empty states: one line of `--text-secondary` and, if useful, one secondary button. No illustration.
- Errors: state what happened and what to do, in that order. "Card declined: over the $900 domestic limit. Request an increase."

---

## 9. Presenting AI

AI is a competent analyst, not a mascot. Its output appears as "Approval recommended" style callouts: a plain heading, a short reasoning list with the specific numbers it used, a source link, and a thumbs up/down. The word "AI" is rarely shown; name the feature ("Ask Ramp" equivalent) with a small asterisk-style glyph, not a sparkle. Confidence is expressed in words in the reasoning, not as a percentage badge. Never animate the AI text in with a typewriter effect in transactional UI.

---

## 10. Motion

- Durations: 120ms for hover and colour, 180ms for expand/collapse and menus, 240ms for drawers. Nothing longer.
- Easing: `cubic-bezier(0.2, 0, 0, 1)` for enter, `cubic-bezier(0.4, 0, 1, 1)` for exit.
- Drawers slide in from the right 16px with opacity. Menus fade and translate 4px. No bounce, no spring, no scale-up from 0.
- No scroll-triggered animations, no parallax, no animated gradients, no confetti.
- Respect `prefers-reduced-motion`: disable all transforms.

---

## 11. Implementation defaults

Tailwind users: map the tokens above into `theme.extend.colors`, set `borderRadius` to `{ sm: '4px', md: '6px', lg: '8px' }` and delete `xl`+ so they cannot be used. Set `fontFamily.sans` to Inter. Add `font-feature-settings: "tnum"` to `html` in the base layer.

Component library: prefer headless primitives (Radix, Ark, Headless UI) styled with these tokens over pre-styled kits. If using shadcn/ui, override `--radius` to `0.375rem`, replace the slate palette with the warm neutrals above, and remove all default shadows from Card.

Every new screen must pass this check before it is done:
0. Has the accent colour been chosen by the user and written into §3 (no `UNSET` left)?
1. Is there exactly one `--accent` element (plus small count badges)?
2. Is every heading regular weight?
3. Are all borders 1px `--border` and all shadows absent (except menus)?
4. Are numbers tabular and right-aligned in columns?
5. Is copy in sentence case with no exclamation marks and no emoji?
6. Would this screen look at home next to a bank statement?

If the answer to any is no, fix it before adding features.
