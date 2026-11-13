"use client";

import { useEffect, useRef } from "react";
import {
  aeralythLogoFacets,
  aeralythLogoToneLevels,
} from "@/components/aeralyth-logo";
import { cn } from "@/lib/utils";

// Brightness to color: black, blood red, red-orange, hot orange, pale coral.
const EMBER_STOPS = [
  [0, 0, 0, 0],
  [0.14, 58, 3, 2],
  [0.36, 158, 12, 3],
  [0.6, 238, 38, 6],
  [0.82, 255, 84, 20],
  [1, 255, 168, 112],
] as const;
const FRAME_MS = 70;
const REVEAL_MS = 2200;
// Values precomputed per cell; see layout().
const FIELD_SIZE = 10;
// The band of light climbs from the lower left to the upper right.
const BAND_ANGLE = 0.44;

function buildEmberRamp() {
  const ramp = new Uint8ClampedArray(256 * 3);
  for (let level = 0; level < 256; level += 1) {
    const value = level / 255;
    let upper = 1;
    while (upper < EMBER_STOPS.length - 1 && EMBER_STOPS[upper][0] < value)
      upper += 1;
    const from = EMBER_STOPS[upper - 1];
    const to = EMBER_STOPS[upper];
    const mix = (value - from[0]) / (to[0] - from[0]);
    for (let channel = 0; channel < 3; channel += 1) {
      ramp[level * 3 + channel] =
        from[channel + 1] + (to[channel + 1] - from[channel + 1]) * mix;
    }
  }
  return ramp;
}

function latticeValue(x: number, y: number) {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
function noise(x: number, y: number) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fx = x - cellX;
  const fy = y - cellY;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const top =
    latticeValue(cellX, cellY) +
    (latticeValue(cellX + 1, cellY) - latticeValue(cellX, cellY)) * ux;
  const bottom =
    latticeValue(cellX, cellY + 1) +
    (latticeValue(cellX + 1, cellY + 1) - latticeValue(cellX, cellY + 1)) * ux;
  return top + (bottom - top) * uy;
}

function smoothstep(from: number, to: number, value: number) {
  const amount = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return amount * amount * (3 - 2 * amount);
}

function createLedMatrix(
  root: HTMLElement,
  canvases: readonly HTMLCanvasElement[],
) {
  const contexts = canvases.map((canvas) => canvas.getContext("2d"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ramp = buildEmberRamp();
  let columns = 0;
  let rows = 0;
  let images: ImageData[] = [];
  // Per cell: band coordinates (along, across), band envelope, mark
  // brightness, corona strength, direction from the mark (x, y), distance from
  // it, the dimming over the page's text, and the mark's soft glow.
  let field = new Float32Array(0);
  let start = -1;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function layout() {
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (width === 0 || height === 0) return;
    const pitch = Math.min(14, Math.max(9, Math.round(width / 150)));
    columns = Math.ceil(width / pitch);
    rows = Math.ceil(height / pitch);
    root.style.setProperty("--led-pitch", `${pitch}px`);
    for (const canvas of canvases) {
      canvas.width = columns;
      canvas.height = rows;
      canvas.style.width = `${columns * pitch}px`;
      canvas.style.height = `${rows * pitch}px`;
    }
    images = contexts.map(
      (context) =>
        context?.createImageData(columns, rows) ?? new ImageData(1, 1),
    );

    // The mark glows where the page reserves room for it; without that room
    // it sits small at the top, clear of the sign-in card.
    const bounds = root.getBoundingClientRect();
    const anchor = document
      .querySelector("[data-led-anchor]")
      ?.getBoundingClientRect();
    const anchored = anchor !== undefined && anchor.width > 0;
    const size = anchored
      ? Math.min(anchor.width, anchor.height)
      : Math.min(height * 0.17, width * 0.36);
    const centerX = anchored
      ? anchor.left - bounds.left + anchor.width / 2
      : width / 2;
    const centerY = anchored
      ? anchor.top - bounds.top + anchor.height / 2
      : Math.max(size * 0.62, height * 0.1);

    const stencil = document.createElement("canvas");
    stencil.width = columns;
    stencil.height = rows;
    const pen = stencil.getContext("2d", { willReadFrequently: true });
    let logo: Uint8ClampedArray | null = null;
    if (pen) {
      const scale = size / pitch / 64;
      pen.setTransform(
        scale,
        0,
        0,
        scale,
        centerX / pitch - 32 * scale,
        centerY / pitch - 32 * scale,
      );
      for (const facet of aeralythLogoFacets) {
        const [first, ...rest] = facet.points;
        pen.beginPath();
        pen.moveTo(first[0], first[1]);
        for (const [x, y] of rest) pen.lineTo(x, y);
        pen.closePath();
        const from = aeralythLogoToneLevels[facet.from];
        const to = aeralythLogoToneLevels[facet.to];
        // Facets shade from their apex toward the middle of the far edge.
        const farX =
          rest.reduce((sum, point) => sum + point[0], 0) / rest.length;
        const farY =
          rest.reduce((sum, point) => sum + point[1], 0) / rest.length;
        const shade = pen.createLinearGradient(first[0], first[1], farX, farY);
        shade.addColorStop(0, `rgb(${from} ${from} ${from})`);
        shade.addColorStop(1, `rgb(${to} ${to} ${to})`);
        pen.fillStyle = shade;
        pen.fill();
      }
      logo = pen.getImageData(0, 0, columns, rows).data;
    }

    // A blurred copy of the mark gives it a glow that spills onto its neighbours.
    const glow = new Float32Array(columns * rows);
    if (logo) {
      const sharp = new Float32Array(columns * rows);
      for (let index = 0; index < sharp.length; index += 1) {
        sharp[index] = (logo[index * 4] / 255) * (logo[index * 4 + 3] / 255);
      }
      const reachCells = 3;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          let sum = 0;
          let weight = 0;
          for (let dy = -reachCells; dy <= reachCells; dy += 1) {
            for (let dx = -reachCells; dx <= reachCells; dx += 1) {
              const x = column + dx;
              const y = row + dy;
              if (x < 0 || y < 0 || x >= columns || y >= rows) continue;
              const falloff = Math.exp(-(dx * dx + dy * dy) / 5);
              sum += sharp[y * columns + x] * falloff;
              weight += falloff;
            }
          }
          glow[row * columns + column] = sum / weight;
        }
      }
    }

    field = new Float32Array(columns * rows * FIELD_SIZE);
    const cos = Math.cos(BAND_ANGLE);
    const sin = Math.sin(BAND_ANGLE);
    const reach = size / height;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cell = (row * columns + column) * FIELD_SIZE;
        const x = ((column + 0.5) * pitch - centerX) / height;
        const y = ((row + 0.5) * pitch - centerY) / height;
        const along = x * cos - y * sin;
        const across = x * sin + y * cos;
        const radius = Math.hypot(x, y);
        field[cell] = along;
        field[cell + 1] = across;
        // The mark sits in a darker pocket so its edges read against the light.
        const pocket = 1 - 0.88 * Math.exp(-((radius / (reach * 0.72)) ** 2));
        field[cell + 2] =
          (Math.exp(-((across / 0.18) ** 2)) *
            (0.5 + 0.5 * Math.exp(-((along / 1.5) ** 2))) +
            // A fainter second arm above the main band.
            0.32 *
              Math.exp(-(((across + 0.4) / 0.08) ** 2)) *
              Math.exp(-(((along - 0.35) / 0.8) ** 2))) *
          pocket;
        const lit = logo
          ? (logo[(row * columns + column) * 4] / 255) *
            (logo[(row * columns + column) * 4 + 3] / 255)
          : 0;
        field[cell + 3] = lit > 0.05 ? 0.66 + 0.34 * lit : 0;
        // A corona of rays, strongest just outside the mark.
        field[cell + 4] = Math.exp(
          -(((radius - reach * 0.78) / (reach * 0.42)) ** 2),
        );
        field[cell + 5] = radius > 0 ? x / radius : 0;
        field[cell + 6] = radius > 0 ? y / radius : 0;
        field[cell + 7] = radius;
        // The page's text sits under the mark, so the light thins out there.
        const beside = anchored
          ? Math.max(
              anchor.left - bounds.left - (column + 0.5) * pitch,
              (column + 0.5) * pitch - (anchor.right - bounds.left),
            )
          : 0;
        field[cell + 8] = anchored
          ? 1 -
            0.78 *
              smoothstep(reach * 0.45, reach * 0.8, y) *
              (1 - smoothstep(0, 90, beside))
          : 1;
        field[cell + 9] = glow[row * columns + column];
      }
    }
  }

  function paint(now: number) {
    if (columns === 0) return;
    const animated = !reducedMotion.matches;
    if (start < 0) start = now;
    const time = animated ? now / 1000 : 40;
    const reveal = animated ? (now - start) / REVEAL_MS : 2;
    const [bloom, cells, cores] = images.map((image) => image.data);
    for (let index = 0; index < columns * rows; index += 1) {
      const cell = index * FIELD_SIZE;
      const along = field[cell];
      const across = field[cell + 1];
      const radius = field[cell + 7];
      const phase = latticeValue(index, 7);
      const strands = noise(along * 1.4 + time * 0.035, across * 12 + 3.7);
      const drift = noise(along * 0.55 - time * 0.014, across * 2.4 + 11.3);
      const band =
        field[cell + 2] *
        (0.07 + 1.55 * strands ** 2.3 * (0.35 + 0.65 * drift));
      const corona = field[cell + 4];
      // Sampling around a circle keeps the rays seamless all the way round.
      const rays =
        corona > 0.02
          ? corona *
            noise(
              field[cell + 5] * 2.6 + 20 + time * 0.03,
              field[cell + 6] * 2.6 + 20 - time * 0.022,
            ) **
              1.8
          : 0;
      const twinkle =
        1 + 0.2 * Math.sin(time * (0.5 + phase * 1.7) + phase * 40);
      const mark =
        field[cell + 3] * (0.9 + 0.1 * Math.sin(time * 1.1 + phase * 6.3));
      let level =
        (1 - (1 - Math.min(1, band)) * (1 - rays * 0.85)) * twinkle +
        0.02 +
        0.04 * drift;
      level = Math.max(level, mark, field[cell + 9] * 0.62) * field[cell + 8];
      // The light spreads outward from the mark as the page opens.
      level *= smoothstep(0, 0.5, reveal * 1.5 - radius);
      level = Math.min(1, Math.max(0, level));

      const pixel = index * 4;
      const tone = Math.round(level * 255) * 3;
      const hot = Math.min(255, Math.round(level * 330) + 18) * 3;
      bloom[pixel] = ramp[tone];
      bloom[pixel + 1] = ramp[tone + 1];
      bloom[pixel + 2] = ramp[tone + 2];
      bloom[pixel + 3] = Math.min(255, level ** 0.9 * 300);
      cells[pixel] = ramp[tone];
      cells[pixel + 1] = ramp[tone + 1];
      cells[pixel + 2] = ramp[tone + 2];
      cells[pixel + 3] = smoothstep(0.24, 0.7, level) * 255;
      cores[pixel] = ramp[hot];
      cores[pixel + 1] = ramp[hot + 1];
      cores[pixel + 2] = ramp[hot + 2];
      cores[pixel + 3] = smoothstep(0.02, 0.3, level) * 255;
    }
    contexts.forEach((context, layer) => {
      context?.putImageData(images[layer], 0, 0);
    });
    root.dataset.ready = "true";
  }

  function tick(now: number) {
    frame = 0;
    if (disposed) return;
    paint(now);
    if (reducedMotion.matches || document.hidden) return;
    timer = setTimeout(schedule, FRAME_MS);
  }

  function schedule() {
    timer = undefined;
    if (!frame && !disposed) frame = requestAnimationFrame(tick);
  }

  function restart() {
    clearTimeout(timer);
    schedule();
  }

  const resizeObserver = new ResizeObserver(() => {
    layout();
    restart();
  });
  resizeObserver.observe(root);
  document.addEventListener("visibilitychange", restart);
  reducedMotion.addEventListener("change", restart);

  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", restart);
    reducedMotion.removeEventListener("change", restart);
  };
}

/**
 * A full-bleed wall of glowing cells: streaks of light drifting across the
 * page and the Aeralyth mark lit up where `data-led-anchor` reserves room.
 */
export function LedMatrixBackground({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bloomRef = useRef<HTMLCanvasElement>(null);
  const cellsRef = useRef<HTMLCanvasElement>(null);
  const coresRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const bloom = bloomRef.current;
    const cells = cellsRef.current;
    const cores = coresRef.current;
    if (!root || !bloom || !cells || !cores) return;
    return createLedMatrix(root, [bloom, cells, cores]);
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn("led-matrix", className)}
      aria-hidden="true"
    >
      <canvas ref={bloomRef} className="led-matrix-bloom" />
      <canvas ref={cellsRef} className="led-matrix-cells" />
      <canvas ref={coresRef} className="led-matrix-cores" />
    </div>
  );
}
