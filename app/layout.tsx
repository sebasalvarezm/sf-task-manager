import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Valstone — Task Manager",
  description: "Salesforce open task manager for Valstone M&A",
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
