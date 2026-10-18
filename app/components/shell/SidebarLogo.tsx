import Image from "next/image";
import Link from "next/link";

// The full "VALSTONE" wordmark, dark lettering on a transparent background
// (derived from the navy original), so it sits on the light sidebar.
export function SidebarLogo() {
  return (
    <Link
      href="/"
      className="flex items-center min-w-0"
      aria-label="Valstone home"
    >
      <Image
        src="/valstone-logo.png"
        alt="Valstone"
        width={115}
        height={32}
        className="h-7 w-auto shrink-0"
        priority
      />
    </Link>
  );
}
