import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: "#1B2A4A",
          dark: "#141f38",
          light: "#253561",
        },
        brand: {
          DEFAULT: "#E84C0E",
          orange: "#E84C0E",
          "orange-hover": "#c93d09",
          hover: "#C93D09",
          soft: "#FEF1EC",
        },
        surface: {
          DEFAULT: "#F5F6F8",
          2: "#FFFFFF",
          3: "#FAFBFC",
        },
        line: {
          DEFAULT: "#E5E7EB",
          strong: "#D1D5DB",
        },
        ink: {
          DEFAULT: "#0F172A",
          secondary: "#475569",
          muted: "#94A3B8",
          inverse: "#F8FAFC",
          "inverse-muted": "#A0AEC0",
        },
        ok: {
          DEFAULT: "#16A34A",
          soft: "#DCFCE7",
        },
        warn: {
          DEFAULT: "#D97706",
          soft: "#FEF3C7",
        },
        danger: {
          DEFAULT: "#DC2626",
          soft: "#FEE2E2",
        },
        info: {
          DEFAULT: "#2563EB",
          soft: "#DBEAFE",
        },
      },
      borderRadius: {
        md: "6px",
        lg: "10px",
        xl: "14px",
      },
      boxShadow: {
        xs: "0 1px 2px rgba(15, 23, 42, 0.04)",
        sm: "0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)",
        md: "0 4px 12px rgba(15, 23, 42, 0.08)",
        lg: "0 10px 30px rgba(15, 23, 42, 0.12)",
      },
      fontFamily: {
        sans: ["Poppins", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
