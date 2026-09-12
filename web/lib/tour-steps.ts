/**
 * The default end-user guide.
 *
 * Network initialization, test-token creation, Registry authority, and
 * MagicBlock session operation are separate jobs with their own sections. A
 * trader should choose one side and make one move, not impersonate the seller,
 * administrator, seller again, and buyer in a single walkthrough.
 */
export type TourStep = {
  id: string;
  route: string;
  /** Routes where this step can continue without redirecting to its default. */
  allowedRoutes?: string[];
  target?: string;
  /** Visible alternatives, in priority order, when the primary control is not rendered yet. */
  fallbackTargets?: string[];
  title: string;
  body: string;
  /** A short imperative shown both in the card and beside the highlighted control. */
  action?: string;
  /** Clicking one of these controls completes the step automatically. */
  advanceOn?: string[];
  /** A visible target proving this step was completed before the guide reached it. */
  completeWhenVisible?: string[];
  /** What must happen before a target that is not on screen can appear. */
  waitFor?: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "side",
    route: "/app",
    target: "test-keys",
    fallbackTargets: ["role-choice"],
    title: "Choose a demo account",
    body: "Seller owns demo collateral. Buyer owns demo USDC.",
    action: "Choose seller or buyer. The guide advances when you choose.",
    advanceOn: ["test-key-seller", "test-key-buyer", "role-choice"],
    waitFor: "Choose one of the visible demo accounts.",
  },
  {
    id: "open",
    route: "/app",
    target: "series-card",
    allowedRoutes: ["/trade/markets"],
    title: "Choose a market",
    body: "Compare the underlying, strike and expiry.",
    action: "Choose a market row. The guide advances automatically.",
    completeWhenVisible: ["market-header"],
    waitFor: "Markets are loading. If none appear, check the devnet connection.",
  },
  {
    id: "act",
    route: "/trade/markets",
    target: "trade-action",
    fallbackTargets: ["place-order", "book"],
    title: "Choose an action",
    body: "Sellers lock collateral and offer N. Buyers purchase N from the order book.",
    action: "Follow the highlighted action for the demo account you chose.",
    waitFor: "Open a market first. Its order book initializes automatically when needed.",
  },
  {
    id: "portfolio",
    route: "/portfolio",
    allowedRoutes: ["/trade/markets", "/app"],
    target: "nav-portfolio",
    title: "Track what you own",
    body: "Portfolio shows P and N balances and any claim available after settlement.",
    action: "Click Portfolio to view your positions and finish the guide.",
    advanceOn: ["nav-portfolio"],
  },
];
