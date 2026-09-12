"use client";

const STEPS = ["Demo collateral", "Demo USDC", "List market", "Trade"];

export function DevnetSetupProgress({
  current,
  completed,
  onSelect,
}: {
  current: number;
  completed: boolean[];
  onSelect?: (index: number) => void;
}) {
  return (
    <div className="border-line bg-panel overflow-hidden rounded-md border" aria-label="Devnet setup progress">
      {/* Four columns at every width, but the phone drops the "Step N" line and
          the padding rather than making the last two steps a sideways scroll. */}
      <ol className="grid grid-cols-4 divide-x divide-[var(--color-line)]">
        {STEPS.map((label, index) => {
          const done = Boolean(completed[index]);
          const active = current === index;
          const enabled = Boolean(onSelect) && (done || active);

          return (
            <li key={label} className="relative">
              <button
                type="button"
                data-setup-step={index + 1}
                disabled={!enabled}
                onClick={() => enabled && onSelect?.(index)}
                aria-current={active ? "step" : undefined}
                // A step you cannot jump to is not broken, it is simply not
                // reached yet — and a greyed control with no explanation is
                // indistinguishable from one that is.
                title={
                  enabled
                    ? `Go to step ${index + 1}: ${label}`
                    : `Step ${index + 1} unlocks once step ${index} is complete`
                }
                className={`relative flex w-full items-center gap-2 px-2 py-3 text-left transition-colors disabled:cursor-default sm:gap-3 sm:px-4 sm:py-4 ${
                  active ? "bg-text text-bg" : done ? "bg-p/5" : ""
                } ${enabled && !active ? "hover:bg-panel-2" : ""}`}
              >
                <span
                  className={`z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[0.7rem] sm:h-6 sm:w-6 sm:text-[0.8125rem] ${
                    done
                      ? "border-p/40 bg-panel text-p"
                      : active
                        ? "border-bg/35 bg-bg/10 text-bg"
                        : "border-line bg-panel text-dim"
                  }`}
                >
                  {done ? "✓" : index + 1}
                </span>
                <span className="min-w-0">
                  <span className={`hidden font-mono text-[0.8125rem] tracking-[0.1em] uppercase sm:block ${active ? "text-bg/60" : "text-dim"}`}>Step {index + 1}</span>
                  <span className={`block text-[0.7rem] leading-tight sm:mt-0.5 sm:text-xs ${active ? "text-bg" : done ? "text-p" : "text-dim"}`}>{label}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
