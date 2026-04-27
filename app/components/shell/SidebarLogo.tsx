import Image from "next/image";
import Link from "next/link";

export function SidebarLogo() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2.5 group min-w-0"
      aria-label="Valstone home"
    >
      <Image
        src="/valstone-logo.png"
        alt=""
        width={28}
        height={28}
        className="rounded-md shrink-0"
        priority
      />
      <span className="text-[15px] font-semibold tracking-tight text-white truncate">
        <span className="text-brand">Val</span>stone
      </span>
    </Link>
  );
}
