"use client";

import { type PointerEvent, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type StorageMatrixSegment = {
  key: string;
  value: number;
  /** Any CSS color. Custom properties resolve against the bar itself. */
  color: string;
};

export type StorageMatrixSpan = { key: string; start: number; end: number };

type MatrixInput = {
  segments: StorageMatrixSegment[];
  total: number;
  restKey: string | null;
  activeKey: string | null;
  scanning: boolean;
};

const PITCH = 6;
const CELL = 4;
const MIN_SPAN = 2;
const RADIUS = 9;
const INTRO_MS = 1100;
const INTRO_EDGE = 12;
const ACTIVE_FRAME_MS = 32;
const IDLE_FRAME_MS = 100;
const DIMMED = 0.3;
const GLOW_OPACITY = 0.3;

/**
 * Splits `columns` between the segments in proportion to their share of
 * `total`. Columns after the last span are the unused remainder of the bar.
 */
export function planMatrixColumns(
  segments: readonly { key: string; value: number }[],
  total: number,
  columns: number,
): StorageMatrixSpan[] {
  const filled = segments.filter(
    (segment) => Number.isFinite(segment.value) && segment.value > 0,
  );
  const sum = filled.reduce((bytes, segment) => bytes + segment.value, 0);
  const capacity = Math.max(sum, Number.isFinite(total) ? total : 0);
  if (columns < 1 || capacity <= 0) return [];

  // A sliver of usage stays visible, and so does a sliver of free space.
  const widths = filled.map((segment) =>
    Math.max(MIN_SPAN, Math.round((segment.value / capacity) * columns)),
  );
  const limit = capacity > sum ? columns - 1 : columns;
  let used = widths.reduce((count, width) => count + width, 0);
  while (used > limit) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 1) break;
    widths[widest] -= 1;
    used -= 1;
  }
  if (capacity === sum && used < columns) {
    widths[widths.indexOf(Math.max(...widths))] += columns - used;
  }

  let start = 0;
  return filled.flatMap((segment, index) => {
    const end = Math.min(columns, start + widths[index]);
    const span = { key: segment.key, start, end };
    start = end;
    return span.end > span.start ? [span] : [];
  });
}

function cellNoise(column: number, row: number, channel: number) {
  let hash =
    Math.imul(column + 1, 374761393) ^
    Math.imul(row + 1, 668265263) ^
    Math.imul(channel + 1, 2246822519);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function createMatrixController(
  canvas: HTMLCanvasElement,
  glow: HTMLElement | null,
) {
  const context = canvas.getContext("2d");
  const stillLayer = document.createElement("canvas");
  const stillContext = stillLayer.getContext("2d");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let input: MatrixInput = {
    segments: [],
    total: 0,
    restKey: null,
    activeKey: null,
    scanning: false,
  };
  let signature = "";
  let width = 0;
  let height = 0;
  let columns = 0;
  let rows = 0;
  let originX = 0;
  let originY = 0;
  let noise = new Float32Array(0);
  let spans: StorageMatrixSpan[] = [];
  let columnSpans = new Int16Array(0);
  let colors: string[] = [];
  let trackColor = "";
  let emphasis: number[] = [];
  let lift: number[] = [];
  let restLift = 0;
  let introStart = -1;
  let glowOpacity = "";
  let visible = false;
  let dirty = true;
  let settled = false;
  let stillValid = false;
  let frame = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPaint = 0;
  let disposed = false;

  function resolvePalette() {
    canvas.style.color = "";
    trackColor = getComputedStyle(canvas).color;
    colors = spans.map((span) => {
      const segment = input.segments.find(({ key }) => key === span.key);
      canvas.style.color = "";
      // An unsupported color leaves the declaration unset, falling back to the track.
      canvas.style.color = segment?.color ?? "";
      return getComputedStyle(canvas).color;
    });
    canvas.style.color = "";
  }

  function layout() {
    columns = Math.max(0, Math.floor(width / PITCH));
    rows = Math.max(0, Math.floor((height - 8) / PITCH));
    originX = (width - columns * PITCH) / 2;
    originY = (height - rows * PITCH) / 2;
    noise = new Float32Array(columns * rows * 3);
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        const cell = (column * rows + row) * 3;
        noise[cell] = cellNoise(column, row, 0);
        noise[cell + 1] = cellNoise(column, row, 1);
        noise[cell + 2] = cellNoise(column, row, 2);
      }
    }
    plan();
  }

  function plan() {
    spans = planMatrixColumns(input.segments, input.total, columns);
    columnSpans = new Int16Array(columns).fill(-1);
    spans.forEach((span, index) => {
      columnSpans.fill(index, span.start, span.end);
    });
    emphasis = spans.map((_, index) => emphasis[index] ?? 1);
    lift = spans.map((_, index) => lift[index] ?? 0);
    resolvePalette();
  }

  function spanEdge(column: number) {
    if (column <= 0) return 0;
    if (column >= columns) return width;
    return originX + column * PITCH;
  }

  function drawFrames(target: CanvasRenderingContext2D, front: number) {
    // Track: the whole bar, drawn as unused space.
    target.beginPath();
    target.roundRect(0.5, 0.5, width - 1, height - 1, RADIUS);
    target.fillStyle = trackColor;
    target.strokeStyle = trackColor;
    target.lineWidth = 1;
    target.globalAlpha = 0.025 + 0.03 * restLift;
    target.fill();
    target.setLineDash([2, 3]);
    target.globalAlpha = 0.16 + 0.2 * restLift;
    target.stroke();
    target.setLineDash([]);

    // Segment frames appear as the intro sweep passes over them.
    target.save();
    target.beginPath();
    target.rect(0, 0, spanEdge(Math.floor(front)), height);
    target.clip();
    spans.forEach((span, index) => {
      const left = spanEdge(span.start);
      const right = spanEdge(span.end);
      const corner = Math.min(RADIUS, (right - left) / 2);
      const leftCorner = span.start === 0 ? corner : 0;
      const rightCorner = span.end === columns ? corner : 0;
      target.beginPath();
      target.roundRect(left + 0.5, 0.5, right - left - 1, height - 1, [
        leftCorner,
        rightCorner,
        rightCorner,
        leftCorner,
      ]);
      target.fillStyle = colors[index];
      target.strokeStyle = colors[index];
      target.globalAlpha = (0.13 + 0.09 * lift[index]) * emphasis[index];
      target.fill();
      target.globalAlpha = 0.9 * emphasis[index];
      target.stroke();
    });
    target.restore();
  }

  function drawCells(
    target: CanvasRenderingContext2D,
    time: number,
    front: number,
    pass: "all" | "still" | "twinkling",
  ) {
    const scanAt = ((time * 0.42) % 1.3) * columns - columns * 0.15;
    const inset = (PITCH - CELL) / 2;
    // Assigning a fill style parses the color, so only do it when it changes.
    let fill = "";
    for (let column = 0; column < columns; column += 1) {
      const spanIndex = columnSpans[column];
      const reveal = spanIndex < 0 ? 0 : clamp01((front - column) / INTRO_EDGE);
      const flash = Math.sin(Math.PI * reveal) * 0.6;
      const sweep = input.scanning
        ? Math.exp(-(((column - scanAt) / 7) ** 2))
        : 0;
      const x = originX + column * PITCH + inset;
      for (let row = 0; row < rows; row += 1) {
        const cell = (column * rows + row) * 3;
        const y = originY + row * PITCH + inset;
        const trackTwinkles = noise[cell] < 0.07;
        const spanTwinkles = noise[cell + 1] < 0.36;
        const drawTrack =
          reveal < 1 &&
          (pass === "all" || trackTwinkles === (pass === "twinkling"));
        const drawSpan =
          reveal > 0 &&
          (pass === "all" || spanTwinkles === (pass === "twinkling"));
        const pulse =
          (drawTrack && trackTwinkles) || (drawSpan && spanTwinkles)
            ? 0.5 +
              0.5 *
                Math.sin(
                  time * (0.5 + noise[cell + 2] * 1.7) +
                    noise[cell + 1] * 6.2832,
                )
            : 0;
        if (drawTrack) {
          const level =
            (0.075 + (trackTwinkles ? 0.14 * pulse : 0)) *
              (1 + 1.5 * restLift) +
            0.32 * sweep;
          if (fill !== trackColor) {
            fill = trackColor;
            target.fillStyle = fill;
          }
          target.globalAlpha = Math.min(1, level) * (1 - reveal);
          target.fillRect(x, y, CELL, CELL);
        }
        if (drawSpan) {
          // Lit cells gather toward the bottom, like a container filling up.
          const lit = noise[cell] < 0.14 + 0.34 * ((row + 1) / rows);
          let level = lit ? 0.95 : 0.2 + 0.16 * noise[cell + 2];
          if (spanTwinkles) {
            level = lit ? 0.4 + 0.6 * pulse : level + 0.6 * pulse ** 4;
          }
          level += flash + 0.5 * sweep + (lit ? 0 : 0.1 * lift[spanIndex]);
          if (fill !== colors[spanIndex]) {
            fill = colors[spanIndex];
            target.fillStyle = fill;
          }
          target.globalAlpha =
            Math.min(1, level) * emphasis[spanIndex] * reveal;
          target.fillRect(x, y, CELL, CELL);
        }
      }
    }
    target.globalAlpha = 1;
  }

  function paint(now: number) {
    if (!context || !stillContext || width === 0 || height === 0) return;
    const animated = !reducedMotion.matches;
    const elapsed = Math.min(120, now - lastPaint);
    const ease = animated ? 1 - Math.exp(-elapsed / 110) : 1;
    const time = animated ? now / 1000 : 0;
    const scale = canvas.width / width;

    if (introStart < 0 && visible) introStart = now;
    const intro = !animated
      ? 1
      : introStart < 0
        ? 0
        : clamp01((now - introStart) / INTRO_MS);
    const front = (1 - (1 - intro) ** 3) * (columns + INTRO_EDGE);
    const nextGlowOpacity = (GLOW_OPACITY * intro ** 2).toFixed(2);
    if (glow && nextGlowOpacity !== glowOpacity) {
      glowOpacity = nextGlowOpacity;
      glow.style.opacity = glowOpacity;
    }

    const restActive =
      input.restKey !== null && input.activeKey === input.restKey;
    let moving = intro < 1 || input.scanning;
    spans.forEach((span, index) => {
      const active = input.activeKey === span.key;
      const emphasisTarget = input.activeKey === null || active ? 1 : DIMMED;
      const liftTarget = active ? 1 : 0;
      emphasis[index] += (emphasisTarget - emphasis[index]) * ease;
      lift[index] += (liftTarget - lift[index]) * ease;
      if (
        Math.abs(emphasisTarget - emphasis[index]) > 0.01 ||
        Math.abs(liftTarget - lift[index]) > 0.01
      )
        moving = true;
    });
    restLift += ((restActive ? 1 : 0) - restLift) * ease;
    if (Math.abs((restActive ? 1 : 0) - restLift) > 0.01) moving = true;
    settled = !moving;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (moving) {
      stillValid = false;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      drawFrames(context, front);
      drawCells(context, time, front, "all");
      return;
    }
    // At rest only a minority of cells change, so the others are drawn once and reused.
    if (!stillValid) {
      stillLayer.width = canvas.width;
      stillLayer.height = canvas.height;
      stillContext.setTransform(scale, 0, 0, scale, 0, 0);
      drawFrames(stillContext, front);
      drawCells(stillContext, time, front, "still");
      stillValid = true;
    }
    context.drawImage(stillLayer, 0, 0);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    drawCells(context, time, front, "twinkling");
  }

  function tick(now: number) {
    frame = 0;
    if (disposed) return;
    if (dirty || settled || now - lastPaint >= ACTIVE_FRAME_MS) {
      paint(now);
      lastPaint = now;
      dirty = false;
    }
    const animated = !reducedMotion.matches && visible && !document.hidden;
    if (!animated) return;
    if (settled) {
      // The idle twinkle is slow; sleep between frames instead of spinning at the display rate.
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        schedule();
      }, IDLE_FRAME_MS);
    } else {
      schedule();
    }
  }

  function schedule() {
    if (!frame && !disposed) frame = requestAnimationFrame(tick);
  }

  function invalidate() {
    dirty = true;
    stillValid = false;
    clearTimeout(idleTimer);
    idleTimer = undefined;
    schedule();
  }

  const resizeObserver = new ResizeObserver(([entry]) => {
    const density = Math.min(window.devicePixelRatio || 1, 2);
    width = entry.contentRect.width;
    height = entry.contentRect.height;
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    layout();
    stillValid = false;
    // Resizing clears the bitmap, so repaint before the browser presents it.
    paint(performance.now());
    schedule();
  });
  resizeObserver.observe(canvas);

  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) invalidate();
  });
  intersectionObserver.observe(canvas);

  // The accent color is a user preference applied to the root element.
  const paletteObserver = new MutationObserver(() => {
    resolvePalette();
    invalidate();
  });
  paletteObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  document.addEventListener("visibilitychange", invalidate);
  reducedMotion.addEventListener("change", invalidate);

  return {
    update(next: MatrixInput) {
      const nextSignature = `${next.total}|${next.segments
        .map((segment) => `${segment.key}:${segment.value}:${segment.color}`)
        .join("|")}`;
      input = next;
      if (nextSignature !== signature) {
        signature = nextSignature;
        introStart = -1;
        plan();
      }
      invalidate();
    },
    keyAt(clientX: number) {
      if (columns === 0) return null;
      const x = clientX - canvas.getBoundingClientRect().left;
      const column = Math.min(
        columns - 1,
        Math.max(0, Math.floor((x - originX) / PITCH)),
      );
      const spanIndex = columnSpans[column];
      return spanIndex < 0 ? input.restKey : spans[spanIndex].key;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(idleTimer);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      paletteObserver.disconnect();
      document.removeEventListener("visibilitychange", invalidate);
      reducedMotion.removeEventListener("change", invalidate);
    },
  };
}

/**
 * A segmented usage bar drawn as a grid of twinkling cells. It is decorative:
 * the figures it shows must also be present as text next to it.
 */
export function StorageMatrix({
  segments,
  total,
  restKey = null,
  activeKey = null,
  onActiveKeyChange,
  scanning = false,
  className,
}: {
  segments: StorageMatrixSegment[];
  /** Capacity of the bar. Space the segments leave over is drawn as unused. */
  total: number;
  /** Key reported for the unused remainder, when it can be highlighted. */
  restKey?: string | null;
  activeKey?: string | null;
  onActiveKeyChange?: (key: string | null) => void;
  /** Sweeps a band of light across the bar while a measurement is running. */
  scanning?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReturnType<
    typeof createMatrixController
  > | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const controller = createMatrixController(
      canvasRef.current,
      glowRef.current,
    );
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.update({
      segments,
      total,
      restKey,
      activeKey,
      scanning,
    });
  }, [segments, total, restKey, activeKey, scanning]);

  function reportKey(event: PointerEvent<HTMLCanvasElement>) {
    const key = controllerRef.current?.keyAt(event.clientX) ?? null;
    if (key !== activeKey) onActiveKeyChange?.(key);
  }

  const filled = segments.reduce(
    (bytes, segment) => bytes + Math.max(0, segment.value),
    0,
  );

  return (
    <div className={cn("relative isolate h-24", className)} aria-hidden="true">
      <div
        ref={glowRef}
        className="pointer-events-none absolute inset-x-[2%] top-1/2 -bottom-3 -z-10 flex opacity-0 blur-xl"
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            style={{
              flexGrow: Math.max(0, segment.value),
              background: segment.color,
            }}
          />
        ))}
        <span style={{ flexGrow: Math.max(0, total - filled) }} />
      </div>
      <canvas
        ref={canvasRef}
        className="block size-full"
        onPointerDown={reportKey}
        onPointerMove={reportKey}
        onPointerLeave={() => onActiveKeyChange?.(null)}
      />
    </div>
  );
}
