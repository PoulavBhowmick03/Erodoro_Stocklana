# The idea, in plain language

## One sentence

You own a tokenized stock. You give up any gains above a price you pick. In
exchange, someone pays you cash **today**.

## Concretely

Say you hold 1 TSLAx — a Tesla share that lives on Solana — worth **$400**.

You lock it in a vault and pick a **$500 strike** and a date, say three months
out. The vault hands you back two tokens:

- **P** — "I get the stock, but capped at $500"
- **N** — "I get anything above $500"

You **sell N** to someone for cash — maybe $15. That $15 is yours immediately,
whatever happens next. You keep P.

## What happens at maturity

The vault looks up the stock's price and splits your locked share between
whoever holds P and whoever holds N:

| Tesla ends at | P holder (you) gets | N holder gets |
| --- | --- | --- |
| $250 | all of it — $250 | nothing |
| $400 | all of it — $400 | nothing |
| $600 | $500 worth | $100 worth |
| $1000 | $500 worth | $500 worth |

Below $500 nothing was given up, and N expires worthless — the buyer's $15 was
simply a bad bet. Above $500 you are capped and N takes the rest.

In traditional finance this is a **covered call**. You wrote it; the N buyer
bought it. This makes both halves into tokens that can be traded
independently.

## The part that must not be glossed over

**This is not downside protection.**

If the stock goes to $250 you lose $150, exactly as you would holding it. The
$15 premium is the *only* cushion. You have sold your upside, not bought
insurance.

Every interface built on this has to say so. A name or a tagline implying a
floor — "protected", "safe", "hedged" — would be false, and the first person to
read the contract would say so publicly.

## Why it was hard to build

Three things that sound boring and are not.

**A stock split could silently rob one side.** If the stock does a 2-for-1
split, its price halves to $300. A naive contract compares $300 against the
$500 strike, concludes "below strike", and hands *everything* to P — wiping out
N in an event where nobody lost a penny. The fix is to halve the strike
alongside the split. Both the bug and the fix are demonstrated in the tests.

**The company that issues the token can take it out of the vault.** The issuer
holds a "permanent delegate" key over these tokens — it can move them from
anywhere, without anyone's permission. No contract can prevent that. What a
contract *can* do is make sure that if it happens, everyone takes the same
proportional loss, instead of the first person to hit redeem walking away whole
and the last getting nothing.

**Settlement has to land on a real price.** Tesla trades weekdays 09:30–16:00.
The token trades 24/7. A price at 3am on a Sunday is not a market price, it is
noise on a thin book — and settling real money against it would be a gift to
whoever nudged it.

## The catch nobody has solved

The contract works perfectly with zero users. **The product does not.**

Your entire compensation for capping your upside is that $15 — and that $15
only exists if somebody actually wants to buy N. Nobody has committed to yet.

That is not an engineering problem and no amount of code fixes it. It is the
real risk, and it is recorded as such in [`decisions.md`](decisions.md) rather
than buried.
