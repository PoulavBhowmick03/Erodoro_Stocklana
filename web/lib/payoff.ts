/**
 * The settlement payoff, mirroring `common::compute_pools` on-chain.
 *
 * On-chain the split is expressed in raw collateral units:
 *
 *   price <= strike:  p_pool = collateral
 *   price >  strike:  p_pool = floor(collateral * strike / price)
 *                     n_pool = collateral - p_pool
 *
 * For one whole share that reduces to the dollar values below, which is the
 * form worth showing a human: P is capped at the strike, N takes the rest.
 */
export function splitPayoff(price: number, strike: number) {
  const p = Math.min(price, strike);
  const n = Math.max(0, price - strike);
  return { p, n };
}

/**
 * Explain the worked example without confusing distance from the strike with
 * profit or loss from the entry price.
 */
export function payoffExplanation(price: number, spot: number, strike: number) {
  const { p, n } = splitPayoff(price, strike);

  if (price > strike) {
    return `P is capped at ${usd(strike)}. N receives the remaining ${usd(n)} of value.`;
  }

  if (price === strike) {
    return `The collateral finishes at the ${usd(strike)} strike. P is worth ${usd(p)} and N expires worthless.`;
  }

  if (price < spot) {
    return `The collateral is ${usd(spot - price)} below its ${usd(spot)} entry price. P is worth ${usd(p)} and N expires worthless.`;
  }

  if (price > spot) {
    return `The collateral is ${usd(price - spot)} above its ${usd(spot)} entry price but below the ${usd(strike)} strike. P is worth ${usd(p)} and N expires worthless.`;
  }

  return `The collateral is unchanged from its ${usd(spot)} entry price and below the ${usd(strike)} strike. P is worth ${usd(p)} and N expires worthless.`;
}

export function usd(n: number, maximumFractionDigits = 0) {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits })}`;
}
