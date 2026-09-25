"use client";
import { RoleToggle, useRole } from "./role-toggle";

export function MarketplaceIntro() {
  const [role, setRole] = useRole();
  return (
    <>
      <h1 className="font-display text-3xl tracking-[-0.045em]">
        {role === "seller"
          ? "Choose where to sell your upside"
          : "Trade stock upside"}
      </h1>
      <p className="text-muted mt-3 max-w-[68ch] leading-7">
        {role === "seller"
          ? "Compare the sell price, expiry and available premium for each listed strategy."
          : "Compare upside markets by stock, sell price and expiry. Trade available liquidity on the order book."}
      </p>
      <div data-tour="role-choice" className="mt-6">
        <RoleToggle role={role} onChange={setRole} />
      </div>
    </>
  );
}
