import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Valstone Platform",
  description: "Valstone — Sales, sourcing, and M&A operations platform",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Stops iOS browsers (Chrome included) zooming the page when a text box is
  // focused. iOS still allows pinch-zoom for accessibility.
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
