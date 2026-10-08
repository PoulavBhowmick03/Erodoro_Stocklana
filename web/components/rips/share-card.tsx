"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hueFor } from "./bits";

export type ShareSubject = { symbol: string; move: string; termDays: number; demo?: boolean };

const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;
const MOVE = /^(AT|[+−]\d{1,3}(\.5)?%)$/;

/**
 * The link a share carries: the pull itself, so whoever opens it lands on
 * "your friend ripped X -- your turn" instead of a cold page. Only display
 * text travels; nothing in it is trusted beyond being shown.
 */
export function shareLink(s: ShareSubject, origin = window.location.origin) {
  const q = new URLSearchParams({ r: s.symbol, m: s.move, d: String(s.termDays) });
  if (s.demo) q.set("demo", "1");
  return `${origin}/market-rip?${q}`;
}

/** The pull a shared link describes, or null if the link carries none or was tampered into nonsense. */
export function readShared(search: string): ShareSubject | null {
  const q = new URLSearchParams(search);
  const symbol = q.get("r")?.toUpperCase() ?? "";
  const move = q.get("m") ?? "";
  const termDays = Number(q.get("d"));
  if (!SYMBOL.test(symbol) || (move && !MOVE.test(move)) || !Number.isInteger(termDays) || termDays < 1 || termDays > 400) {
    return null;
  }
  return { symbol, move, termDays, demo: q.get("demo") === "1" };
}

export const shareText = (s: ShareSubject) =>
  `I ripped ${s.symbol} ↑${s.move ? ` ${s.move}` : ""} · ${s.termDays}D for $1. Your turn:`;

const W = 1200;
const H = 675;

function displayFamily() {
  const probe = document.createElement("span");
  probe.className = "font-display";
  document.body.appendChild(probe);
  const family = getComputedStyle(probe).fontFamily;
  probe.remove();
  return family || "system-ui, sans-serif";
}

/**
 * The share image. Deliberately says almost nothing: the ticker, the arrow,
 * the move, the term, and "$1 RIP". No strike, no protocol, no numbers that
 * need context -- the question it should raise is "what is a Rip?".
 */
export async function drawShareCard(canvas: HTMLCanvasElement, s: ShareSubject) {
  await document.fonts?.ready;
  const font = displayFamily();
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return;
  const hue = hueFor(s.symbol);

  g.fillStyle = "#14120f";
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W * 0.72, H * 0.3, 20, W * 0.72, H * 0.3, 620);
  glow.addColorStop(0, `hsla(${hue}, 70%, 55%, 0.55)`);
  glow.addColorStop(1, "hsla(0, 0%, 0%, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  const warm = g.createRadialGradient(80, H, 10, 80, H, 520);
  warm.addColorStop(0, "rgba(239, 118, 69, 0.45)");
  warm.addColorStop(1, "rgba(239, 118, 69, 0)");
  g.fillStyle = warm;
  g.fillRect(0, 0, W, H);

  // A torn edge along the top, the one visual cue of the mechanic.
  g.fillStyle = "#ef7645";
  g.beginPath();
  g.moveTo(0, 0);
  for (let x = 0; x <= W; x += 30) g.lineTo(x, 18 + ((x / 30) % 2 ? 10 : 0));
  g.lineTo(W, 0);
  g.closePath();
  g.fill();

  g.fillStyle = "rgba(244, 241, 234, 0.72)";
  g.font = `600 34px ${font}`;
  g.letterSpacing = "6px";
  g.fillText("I RIPPED", 80, 150);
  g.letterSpacing = "0px";

  g.fillStyle = "#f4f1ea";
  g.font = `700 210px ${font}`;
  const ticker = s.symbol;
  g.fillText(ticker, 72, 330);
  const tw = g.measureText(ticker).width;
  g.fillStyle = "#4bbd92";
  g.fillText("↑", 72 + tw + 24, 330);

  g.fillStyle = "#f4f1ea";
  g.font = `600 64px ${font}`;
  g.fillText(`${s.move ? `${s.move} · ` : ""}${s.termDays}D`, 80, 462);

  // "$1 RIP" pill.
  g.fillStyle = "#ef7645";
  const pill = { x: 80, y: 530, w: 230, h: 76 };
  g.beginPath();
  g.roundRect(pill.x, pill.y, pill.w, pill.h, 38);
  g.fill();
  g.fillStyle = "#14120f";
  g.font = `700 40px ${font}`;
  g.fillText("$1 RIP", pill.x + 38, pill.y + 52);
  if (s.demo) {
    g.fillStyle = "rgba(244, 241, 234, 0.6)";
    g.font = `600 28px ${font}`;
    g.fillText("DEMO", pill.x + pill.w + 24, pill.y + 49);
  }

  g.fillStyle = "rgba(244, 241, 234, 0.85)";
  g.font = `500 40px ${font}`;
  g.textAlign = "right";
  g.fillText("erodoro", W - 80, 582);
  g.fillStyle = "#ef7645";
  g.beginPath();
  g.arc(W - 80 - g.measureText("erodoro").width - 22, 569, 9, 0, Math.PI * 2);
  g.fill();
  g.textAlign = "left";
}

/** Preview plus the things people actually do with a pull: send it, post it, keep it. */
export function ShareSheet({ subject, onClose }: { subject: ShareSubject; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [copied, setCopied] = useState<"idle" | "image" | "link" | "failed">("idle");
  const [canNative, setCanNative] = useState(false);

  const link = shareLink(subject);
  const text = shareText(subject);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    void drawShareCard(c, subject).then(() => {
      setUrl(c.toDataURL("image/png"));
      c.toBlob((b) => {
        if (!b) return;
        const f = new File([b], `rip-${subject.symbol.toLowerCase()}.png`, { type: "image/png" });
        setFile(f);
        setCanNative(typeof navigator.share === "function");
      }, "image/png");
    });
  }, [subject]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (copied === "idle") return;
    const t = window.setTimeout(() => setCopied("idle"), 2200);
    return () => window.clearTimeout(t);
  }, [copied]);

  // The phone's own share sheet reaches every chat app at once, image and all.
  const native = async () => {
    const withImage = file && navigator.canShare?.({ files: [file] });
    try {
      await navigator.share(withImage ? { files: [file], text: `${text} ${link}` } : { text, url: link });
    } catch {
      // Dismissed, or the platform refused the image; the buttons below still work.
    }
  };

  const copyImage = async () => {
    try {
      if (!file) throw new Error("no image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
      setCopied("image");
    } catch {
      setCopied("failed");
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${link}`);
      setCopied("link");
    } catch {
      setCopied("failed");
    }
  };

  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
  const secondary = "border-line hover:border-text rounded-full border px-2 py-3 text-center text-sm font-medium whitespace-nowrap transition-colors";

  // Portalled: the reveal overlay's backdrop blur would otherwise become this
  // sheet's containing block and push it off the top of the screen.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share your Rip"
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="bg-panel border-line rip-fade-up max-h-full w-full max-w-lg overflow-y-auto rounded-3xl border p-4 shadow-[var(--shadow-pop)]"
        onClick={(e) => e.stopPropagation()}
      >
        <canvas ref={canvas} className="hidden" />
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={`Share card: I ripped ${subject.symbol} up ${subject.move}, ${subject.termDays} days, $1 Rip`} className="w-full rounded-2xl" />
        ) : (
          <div className="bg-panel-2 aspect-[16/9] w-full animate-pulse rounded-2xl" />
        )}
        <p className="text-muted mt-3 text-center text-xs">Friends who open your link land on your pull, with their own $1 Rip one tap away.</p>
        <div className="mt-3 grid gap-2">
          {canNative ? (
            <button type="button" onClick={() => void native()} className="bg-text text-bg rounded-full px-2 py-3.5 text-center text-base font-semibold">
              Send to friends
            </button>
          ) : (
            <a href={intent} target="_blank" rel="noreferrer" className="bg-text text-bg rounded-full px-2 py-3.5 text-center text-base font-semibold">
              Post on X
            </a>
          )}
          <div className="grid grid-cols-3 gap-2">
            {canNative ? (
              <a href={intent} target="_blank" rel="noreferrer" className={secondary}>
                Post on X
              </a>
            ) : (
              <button type="button" onClick={() => void copyImage()} className={secondary}>
                {copied === "image" ? "Copied" : "Copy image"}
              </button>
            )}
            <button type="button" onClick={() => void copyLink()} className={secondary}>
              {copied === "link" ? "Copied" : "Copy link"}
            </button>
            <a href={url ?? undefined} download={`rip-${subject.symbol.toLowerCase()}.png`} aria-disabled={!url} className={secondary}>
              Save
            </a>
          </div>
          <p className="text-danger h-4 text-center text-xs" aria-live="polite">
            {copied === "failed" ? "Your browser blocked the clipboard. Save the image instead." : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-muted hover:text-text w-full py-2 text-sm">
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
