import type { CSSProperties } from "react";

/**
 * A statement that resolves as it is read.
 *
 * Each word carries its own slice of the scroll timeline, offset by its index,
 * so the sentence settles from muted to full ink roughly left to right rather
 * than all at once. The offset is the whole effect: without it every word on a
 * line shares a Y position and therefore a timeline position, and the line
 * flips in one step.
 *
 * No JavaScript. `animation-timeline: view()` does the work, `@supports`
 * handles browsers without it, and the reduced-motion rule in `globals.css`
 * settles every word immediately -- see the note there about why the resting
 * state has to be the readable one.
 */
export function Reveal({
  text,
  as: Tag = "p",
  className = "",
}: {
  text: string;
  as?: "h1" | "h2" | "p";
  className?: string;
}) {
  const words = text.split(" ");
  return (
    <Tag className={`reveal text-balance ${className}`}>
      {words.map((word, index) => (
        <span
          key={`${word}-${index}`}
          style={{ "--i": index } as CSSProperties}
          // A wrapping inline-block would break the space between words, so
          // the space is part of the span rather than between them.
        >
          {word}
          {index < words.length - 1 ? " " : ""}
        </span>
      ))}
    </Tag>
  );
}
