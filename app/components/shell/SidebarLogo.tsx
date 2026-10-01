import Image from "next/image";
import Link from "next/link";

// The image is the full "VALSTONE" wordmark (636 x 177, navy background that
// matches the sidebar), so it is the only logo: no separate text next to it.
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
        className="h-8 w-auto shrink-0"
        priority
      />
    </Link>
  );
}
