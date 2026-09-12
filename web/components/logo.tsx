import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="group flex items-center gap-2.5" aria-label="Erodoro home">
      <span className="bg-accent size-2.5 rounded-full transition-transform group-hover:scale-125" />
      <span className="font-display text-[1.08rem] font-medium tracking-[-0.045em]">erodoro</span>
    </Link>
  );
}
