"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";

import { TOUR_STEPS, type TourStep } from "@/lib/tour-steps";
import { IS_DEVNET } from "@/lib/network-config";

/**
 * A walkthrough that points at the real page.
 *
 * The alternative was a page of instructions, which is what the copy already
 * was before it got cut. This puts each sentence next to the thing it describes
 * and keeps the default journey on the trading surface. Network setup, test
 * scaffolding, and market operations have their own sections instead of
 * turning one end user into four different roles.
 *
 * Deliberately non-blocking: the highlight is a hole in a shadow, not a click
 * shield, so every button stays live while the tour is open. A guide you have
 * to close before you can do the thing it just described is a worse guide.
 */
type Ctx = {
  active: boolean;
  index: number;
  start: () => void;
  stop: () => void;
  complete: (stepId: string) => void;
};

const TourContext = createContext<Ctx>({
  active: false,
  index: 0,
  start: () => {},
  stop: () => {},
  complete: () => {},
});

export const useTour = () => useContext(TourContext);

const SEEN = "erodoro.tour.v1";

const stepMatchesRoute = (step: TourStep, pathname: string) =>
  step.route === pathname || step.allowedRoutes?.includes(pathname);

function firstStepForRoute(pathname: string) {
  const exact = TOUR_STEPS.findIndex((step) => step.route === pathname);
  return exact >= 0
    ? exact
    : TOUR_STEPS.findIndex((step) => step.allowedRoutes?.includes(pathname));
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const pathname = usePathname();
  const router = useRouter();

  /**
   * Open the tour.
   *
   * `here` starts at the first step belonging to the current page instead of
   * the beginning. That distinction exists because opening the tour must never
   * move anyone: on the first visit to /app the tour opened at step 1, which
   * lives on /mint, and the route effect below dutifully navigated there. A
   * first-time visitor who pressed Launch App landed on a page they had not
   * asked for, and the tour looked like a redirect bug.
   *
   * Pressing Guide follows the same rule. On a market it resumes at the market
   * action; on pages outside the journey it falls back to the beginning.
   */
  const open = useCallback(
    (here: boolean) => {
      const at = here ? firstStepForRoute(pathname) : 0;
      setIndex(at < 0 ? 0 : at);
      setActive(true);
      window.localStorage.setItem(SEEN, "1");
    },
    [pathname],
  );

  // Guide is contextual when the current route has a dedicated step. On the
  // market terminal it resumes at trading instead of ejecting the user back to
  // discovery; pages outside the end-user journey still fall back to step 1.
  const start = useCallback(() => open(true), [open]);

  const stop = useCallback(() => {
    setActive(false);
    window.localStorage.setItem(SEEN, "1");
  }, []);

  const step: TourStep | undefined = TOUR_STEPS[index];

  const next = useCallback(() => {
    setIndex((i) => {
      if (i >= TOUR_STEPS.length - 1) {
        setActive(false);
        return i;
      }
      return i + 1;
    });
  }, []);

  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Transaction steps complete on confirmation, not on click. Advancing on
  // click would send a rejected or failed wallet request to the next step and
  // incorrectly claim the action worked.
  const complete = useCallback(
    (stepId: string) => {
      if (!active || TOUR_STEPS[index]?.id !== stepId) return;
      next();
    },
    [active, index, next],
  );

  /*
    The guide is never offered unprompted.

    A card that appears on its own 700ms after the markets finish loading
    arrives exactly when someone has started reading, covers the corner of the
    page they were reading, and has to be dismissed before it stops. It is
    available from Devnet tools and starts from wherever the user already is.
  */

  // The step decides the page, not the other way round.
  useEffect(() => {
    if (!active || !step) return;
    if (!stepMatchesRoute(step, pathname)) router.push(step.route);
  }, [active, step, pathname, router]);

  return (
    <TourContext.Provider value={{ active, index, start, stop, complete }}>
      {children}
      {IS_DEVNET && active && step && (
        <TourOverlay
          step={step}
          index={index}
          total={TOUR_STEPS.length}
          onNext={next}
          onPrev={prev}
          onSkip={stop}
        />
      )}
    </TourContext.Provider>
  );
}

const GAP = 14;
const MARGIN = 12;

function TourOverlay({
  step,
  index,
  total,
  onNext,
  onPrev,
  onSkip,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [card, setCard] = useState({ w: 360, h: 210 });
  const cardRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const targetNames = [step.target, ...(step.fallbackTargets ?? [])].filter(
    (name): name is string => Boolean(name),
  );
  const completionTargets = step.completeWhenVisible ?? [];

  /**
   * Track the target every frame rather than measuring once.
   *
   * The element can move under the overlay for several reasons at once: the
   * smooth scroll this triggers, a panel that finishes loading, a route that
   * has not painted yet. Re-reading each frame handles all of them without
   * guessing at timings, and the state only updates when the numbers actually
   * change, so it does not re-render on a still page.
   */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // A user can start or restart the guide after opening a contract. The
      // completed view may also arrive asynchronously after clicking a row,
      // so check alongside the continuously measured highlight rather than
      // only once when the step mounts.
      if (completionTargets.length && findVisibleTarget(completionTargets)) {
        onNext();
        return;
      }

      // A target may exist twice in responsive chrome, with one copy hidden.
      // querySelector used to select the hidden desktop Portfolio link on a
      // phone and produce a zero-sized highlight. Always resolve the first
      // actually visible candidate, including a step's precondition fallback.
      const el = findVisibleTarget(targetNames);

      if (el) {
        if (scrolledFor.current !== step.id) {
          scrolledFor.current = step.id;
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev &&
          prev.top === r.top &&
          prev.left === r.left &&
          prev.width === r.width &&
          prev.height === r.height
            ? prev
            : r,
        );
      } else {
        setRect((prev) => (prev === null ? prev : null));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, targetNames.join("|"), completionTargets.join("|"), onNext]);

  useEffect(() => {
    if (!step.advanceOn?.length) return;

    const handleAction = (event: MouseEvent) => {
      const clicked = event.target instanceof Element ? event.target : null;
      if (!clicked) return;
      const completed = step.advanceOn!.some((name) =>
        Boolean(clicked.closest(`[data-tour="${name}"]`)),
      );
      if (!completed) return;

      // Let the underlying click update role/query/navigation state first.
      // Advancing in the next task means the next step measures the new page,
      // rather than the DOM that is about to disappear.
      window.setTimeout(onNext, 80);
    };

    window.addEventListener("click", handleAction);
    return () => window.removeEventListener("click", handleAction);
  }, [step, onNext]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCard((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
  }, [step, rect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
      if (e.key === "ArrowRight") onNext();
      if (e.key === "ArrowLeft") onPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, onPrev, onSkip]);

  const pos = placeCard(rect, card);
  const last = index === total - 1;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]">
      {rect ? (
        <>
          <div
            data-tour-highlight
            className="rounded-md transition-[top,left,width,height] duration-200"
            style={{
              position: "fixed",
              top: rect.top - 8,
              left: rect.left - 8,
              width: rect.width + 16,
              height: rect.height + 16,
              // The dim is this element's shadow, so the darkened area is not
              // part of anything's hit region and the page underneath stays live.
              boxShadow:
                "0 0 0 9999px rgb(10 17 24 / 0.72), 0 0 0 4px rgb(214 93 50 / 0.24), 0 0 28px rgb(214 93 50 / 0.62)",
              outline: "3px solid rgb(214 93 50)",
              outlineOffset: 0,
            }}
          />
          {step.action && (
            <div
              data-tour-cue
              className="bg-accent text-bg fixed rounded-md px-2.5 py-1 font-mono text-[0.8125rem] font-semibold tracking-[0.08em] uppercase shadow-lg"
              style={placeCue(rect)}
            >
              Click here ↓
            </div>
          )}
        </>
      ) : (
        <div className="fixed inset-0" style={{ background: "rgb(10 17 24 / 0.72)" }} />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-label={step.title}
        className="border-line bg-panel pointer-events-auto fixed w-[min(23rem,calc(100vw-1.5rem))] rounded-md border p-5 shadow-[0_24px_80px_rgb(10_17_24/0.22)]"
        style={{ top: pos.top, left: pos.left }}
      >
        <div className="text-dim flex items-center justify-between font-mono text-[0.8125rem] tracking-[0.12em] uppercase">
          <span>
            Step {index + 1} of {total}
          </span>
          <button
            onClick={onSkip}
            className="hover:text-text tracking-[0.12em] underline-offset-2 transition-colors hover:underline"
          >
            Skip
          </button>
        </div>

        <h3 className="mt-3 font-medium">{step.title}</h3>
        <p className="text-muted mt-1.5 text-[0.9rem]">{step.body}</p>

        {step.action && rect && (
          <p className="border-accent/40 bg-accent/10 text-text mt-3 rounded-sm border px-3 py-2 text-[0.85rem] font-medium">
            → {step.action}
          </p>
        )}

        {/* The step is ahead of the user: its target is not on the page yet.
            Saying so beats a dimmed screen with a card floating over nothing,
            which is what this looked like before and reads as a broken
            overlay rather than a step you have not reached. */}
        {targetNames.length > 0 && !rect && step.waitFor && (
          <p className="border-n/30 bg-n/5 text-n mt-3 rounded-sm border px-3 py-2 text-[0.85rem]">
            {step.waitFor}
          </p>
        )}

        {/* The dot strip must never be allowed to grow the card: the earlier
            full-system guide pushed Next past the right edge. `min-w-0` lets
            it yield -- a flex item defaults to
            `min-width: auto` and refuses to -- and `shrink-0` keeps the buttons
            whole, so the controls stay inside the card at any step count. */}
        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 gap-1 overflow-hidden">
            {Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={`h-1 shrink-0 rounded-full transition-all ${
                  i === index ? "bg-accent w-4" : "bg-line w-1"
                }`}
              />
            ))}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onPrev}
              disabled={index === 0}
              title={index === 0 ? "Already at the first step" : undefined}
              className="border-line hover:border-text rounded-sm border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={last ? onSkip : onNext}
              className="bg-text hover:bg-accent text-bg rounded-sm px-3 py-1.5 text-sm font-medium transition-colors"
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function findVisibleTarget(names: string[]): HTMLElement | null {
  for (const name of names) {
    const candidates = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
    for (const candidate of candidates) {
      if (isReallyVisible(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Whether a control is actually on screen for the user.
 *
 * A non-zero bounding box is not enough. The demo-account chips live inside the
 * closed `<details>` in the header, and a positioned element inside a collapsed
 * `<details>` still reports a full-size rect in Chrome — so the guide's first
 * step pointed a "CLICK HERE" cue at a box the user could not see, floating
 * over unrelated copy, instead of falling through to its visible alternative.
 */
function isReallyVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  // `checkVisibility` understands content-visibility and the details slot,
  // which is exactly the case that defeated the manual checks below.
  const check = (element as HTMLElement & {
    checkVisibility?: (options?: {
      contentVisibilityAuto?: boolean;
      opacityProperty?: boolean;
      visibilityProperty?: boolean;
    }) => boolean;
  }).checkVisibility;
  if (typeof check === "function") {
    if (!check.call(element, {
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    })) {
      return false;
    }
  }

  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    const details = node.closest("details");
    if (details && !details.open && !node.closest("summary")) return false;
  }
  return true;
}

function placeCue(rect: DOMRect): React.CSSProperties {
  const height = 28;
  const top = rect.top > height + MARGIN
    ? rect.top - height - 10
    : Math.min(window.innerHeight - height - MARGIN, rect.bottom + 10);
  const left = Math.min(
    Math.max(MARGIN, rect.left),
    Math.max(MARGIN, window.innerWidth - 112 - MARGIN),
  );
  return { top, left };
}

/**
 * Below the target if it fits, above if it does not, pinned to the bottom of
 * the viewport if neither works.
 *
 * The last case is not hypothetical: the create steps are tall panels, and one
 * of them is taller than a laptop viewport once it is centred.
 */
function placeCard(rect: DOMRect | null, card: { w: number; h: number }) {
  if (typeof window === "undefined") return { top: MARGIN, left: MARGIN };

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect) {
    return { top: Math.max(MARGIN, (vh - card.h) / 2), left: Math.max(MARGIN, (vw - card.w) / 2) };
  }

  const below = rect.bottom + GAP;
  const above = rect.top - GAP - card.h;

  const preferred =
    below + card.h < vh - MARGIN
      ? below
      : above > MARGIN
        ? above
        : vh - card.h - MARGIN;

  // Clamped, not just chosen. Scrolling the target above the viewport makes
  // `rect.bottom` negative, and "does it fit below" is then trivially true of a
  // position off the top of the screen: the card vanished while its highlight
  // stayed, which reads as a broken overlay rather than a step you scrolled
  // past. The clamp is what keeps the card reachable no matter where the
  // target has gone.
  const top = Math.min(Math.max(MARGIN, preferred), Math.max(MARGIN, vh - card.h - MARGIN));
  const left = Math.min(Math.max(MARGIN, rect.left), vw - card.w - MARGIN);
  return { top, left: Math.max(MARGIN, left) };
}

/** Re-opens the walkthrough. Lives in the header, next to the cluster badge. */
export function TourButton() {
  const { start } = useTour();
  if (!IS_DEVNET) return null;
  return (
    <button
      onClick={start}
      className="border-line text-muted hover:text-text rounded-lg border px-2.5 py-1.5 text-sm transition-colors sm:px-3"
    >
      Guide
    </button>
  );
}
