"use client";

import {
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

const FRAME_INSET = 8;
const FRAME_RADIUS = 20;
const CELL_PITCH = 9;
const COMET_SECONDS = 10;
// Three overlapping strokes of falling length give each light a fading tail.
const COMET_TAILS = [
  { length: 0.16, opacity: 0.28 },
  { length: 0.09, opacity: 0.5 },
  { length: 0.035, opacity: 1 },
] as const;

/**
 * The sign-in panel: a dark glass card framed by a ring of small cells, in the
 * manner of the page's LED wall. Two lights circle the ring, and the cells
 * nearest the pointer warm up.
 */
export function LoginCard({ children }: { children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: card.offsetWidth, height: card.offsetHeight });
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  function trackPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty(
      "--pointer-x",
      `${event.clientX - bounds.left}px`,
    );
    event.currentTarget.style.setProperty(
      "--pointer-y",
      `${event.clientY - bounds.top}px`,
    );
  }

  const frame = size
    ? {
        x: FRAME_INSET,
        y: FRAME_INSET,
        width: size.width - FRAME_INSET * 2,
        height: size.height - FRAME_INSET * 2,
        rx: FRAME_RADIUS,
      }
    : null;
  // Space the cells so a whole number of them fits around the ring.
  const perimeter = frame
    ? 2 * (frame.width + frame.height - 4 * FRAME_RADIUS) +
      2 * Math.PI * FRAME_RADIUS
    : 0;
  const cells = `0.01 ${perimeter / Math.max(1, Math.round(perimeter / CELL_PITCH)) - 0.01}`;

  return (
    <div ref={cardRef} className="login-card" onPointerMove={trackPointer}>
      {frame && size ? (
        <>
          <svg
            className="login-card-frame"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            <mask id={maskId} maskUnits="userSpaceOnUse">
              <rect
                {...frame}
                className="login-card-cells login-card-cells-mask"
                strokeDasharray={cells}
              />
            </mask>
            <rect
              {...frame}
              className="login-card-cells login-card-cells-idle"
              strokeDasharray={cells}
            />
            <g mask={`url(#${maskId})`}>
              {[0, 1].map((comet) =>
                COMET_TAILS.map((tail) => (
                  <rect
                    key={`${comet}-${tail.length}`}
                    {...frame}
                    className="login-card-comet"
                    pathLength={1}
                    strokeDasharray={`${tail.length} ${1 - tail.length}`}
                    style={{
                      opacity: tail.opacity,
                      // Starting each tail further along by its own length
                      // puts every tail's leading end at the same point.
                      animationDelay: `${-(1 - tail.length) * COMET_SECONDS - (comet * COMET_SECONDS) / 2}s`,
                      animationDuration: `${COMET_SECONDS}s`,
                    }}
                  />
                )),
              )}
            </g>
          </svg>
          <svg
            className="login-card-frame login-card-spotlight"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            <rect
              {...frame}
              className="login-card-cells"
              strokeDasharray={cells}
            />
          </svg>
        </>
      ) : null}
      {children}
    </div>
  );
}
