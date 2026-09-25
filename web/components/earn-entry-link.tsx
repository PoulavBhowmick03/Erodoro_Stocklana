import Link from "next/link";
import type { ComponentProps } from "react";

export function EarnEntryLink(
  props: Omit<ComponentProps<typeof Link>, "href">,
) {
  return <Link {...props} href="/earn" />;
}
