import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

/**
 * Design tokens. The look is quiet fintech back-office (see the design guide):
 * warm stone neutrals, one accent (Valstone orange) reserved for the primary
 * action, radii capped at 8px, no shadows outside menus, Inter at 400/500.
 * Class names are kept from the first build (navy, brand, surface, line, ink,
 * ok, warn, danger, info) so every page picks the new values up unchanged.
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Raw Tailwind palettes used across older pages are remapped onto the
        // warm, muted system so nothing stays cool-grey or fire-engine red.
        gray: colors.stone,
        slate: colors.stone,
        zinc: colors.stone,
        neutral: colors.stone,
        red: { ...colors.red, 50: "#F9ECE6", 100: "#F3DACF", 200: "#E8BBA8", 500: "#B5441F", 600: "#B5441F", 700: "#8F3517", 800: "#732B13" },
        green: { ...colors.green, 50: "#E6F2EC", 100: "#D0E6DA", 200: "#A9D0BB", 500: "#1F6B47", 600: "#1F6B47", 700: "#1A5B3C", 800: "#154A31" },
        emerald: { ...colors.emerald, 50: "#E6F2EC", 100: "#D0E6DA", 500: "#1F6B47", 600: "#1F6B47", 700: "#1A5B3C" },
        blue: { ...colors.blue, 50: "#E9EDFA", 100: "#D6DEF5", 200: "#B3C1EC", 400: "#6F86E3", 500: "#3B5BDB", 600: "#3B5BDB", 700: "#2F49B0", 800: "#263B8E" },
        amber: { ...colors.amber, 50: "#F7F0DC", 100: "#EFE2B8", 200: "#E2CC8A", 500: "#8A6A1A", 600: "#8A6A1A", 700: "#705515", 800: "#5A4411" },
        yellow: { ...colors.yellow, 50: "#F7F0DC", 100: "#EFE2B8", 700: "#705515", 800: "#5A4411" },
        // "navy" is the selected-state colour for chips and segments: the muted
        // --info blue, the only blue in the system (DESIGN.md §3).
        navy: {
          DEFAULT: "#3B5BDB",
          dark: "#2F49B0",
          light: "#6F86E3",
        },
        brand: {
          DEFAULT: "#E84C0E",
          orange: "#E84C0E",
          "orange-hover": "#D64408",
          hover: "#D64408",
          soft: "#FBEFE8",
        },
        surface: {
          DEFAULT: "#F5F4F0", // page
          2: "#FFFFFF",       // cards, inputs
          3: "#F7F6F3",       // hover, selected row
          4: "#ECEBE7",       // pressed, dividers as fill
          sidebar: "#1B2A4A", // the original navy, back by request
          "sidebar-active": "#253561",
        },
        line: {
          DEFAULT: "#E3E1DC",
          strong: "#C9C6BF",
        },
        ink: {
          DEFAULT: "#1A1A1A",
          secondary: "#5F5E5A",
          muted: "#8B8985",
          inverse: "#FFFFFF",
          "inverse-muted": "#A0AEC0",
        },
        ok: { DEFAULT: "#1F6B47", soft: "#E6F2EC" },
        warn: { DEFAULT: "#8A6A1A", soft: "#F7F0DC" },
        danger: { DEFAULT: "#B5441F", soft: "#F9ECE6" },
        info: { DEFAULT: "#3B5BDB", soft: "#E9EDFA" },
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
        xl: "12px",
        "2xl": "12px",
        "3xl": "12px",
      },
      boxShadow: {
        xs: "none",
        sm: "none",
        DEFAULT: "none",
        md: "none",
        lg: "none",
        xl: "0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.06)", // menus and popovers only
        "2xl": "0 1px 2px rgba(0,0,0,.04), 0 4px 12px rgba(0,0,0,.06)",
      },
      fontFamily: {
        // Poppins is the app's own face (kept from the first build); Inter stays for tabular numbers.
        sans: ["Poppins", "Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        num: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "monospace"],
      },
      fontWeight: {
        // Headings may be a touch heavier than body, never more than 600.
        semibold: "600",
        bold: "600",
        extrabold: "600",
        black: "600",
      },
      transitionDuration: {
        DEFAULT: "120ms",
      },
    },
  },
  plugins: [],
};

export default config;
