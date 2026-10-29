import * as React from "react";

import { cn } from "@/lib/utils";

type LogoTone =
  | "pale"
  | "light"
  | "bright"
  | "baseLight"
  | "base"
  | "baseDark"
  | "deep"
  | "shadow";

type LogoGradient = {
  x1: string;
  y1: string;
  x2: string;
  y2: string;
  from: LogoTone;
  to: LogoTone;
};

type LogoFacet = {
  id: string;
  points: string;
  fill: LogoTone | LogoGradient;
};

type AeralythLogoProps = Omit<React.SVGProps<SVGSVGElement>, "children"> & {
  title?: string;
};

const logoTones: Record<LogoTone, string> = {
  pale: "color-mix(in oklch, var(--primary) 34%, white)",
  light: "color-mix(in oklch, var(--primary) 50%, white)",
  bright: "color-mix(in oklch, var(--primary) 66%, white)",
  baseLight: "color-mix(in oklch, var(--primary) 82%, white)",
  base: "var(--primary)",
  baseDark: "color-mix(in oklch, var(--primary) 86%, black)",
  deep: "color-mix(in oklch, var(--primary) 72%, black)",
  shadow: "color-mix(in oklch, var(--primary) 58%, black)",
};

// Keep in sync with public/aeralyth_logo.svg, which bakes these tones to hex.
const logoFacets: LogoFacet[] = [
  {
    id: "left-outer",
    points: "30,5 4,58 12,58",
    fill: {
      x1: "30",
      y1: "5",
      x2: "4",
      y2: "58",
      from: "baseLight",
      to: "base",
    },
  },
  {
    id: "left-inner",
    points: "30,5 12,58 20,58",
    fill: {
      x1: "30",
      y1: "5",
      x2: "20",
      y2: "58",
      from: "baseDark",
      to: "deep",
    },
  },
  {
    id: "right-inner",
    points: "34,5 44,58 52,58",
    fill: {
      x1: "34",
      y1: "5",
      x2: "44",
      y2: "58",
      from: "light",
      to: "baseLight",
    },
  },
  {
    id: "right-outer",
    points: "34,5 52,58 60,58",
    fill: {
      x1: "34",
      y1: "5",
      x2: "60",
      y2: "58",
      from: "baseDark",
      to: "shadow",
    },
  },
  { id: "gem-top-left", points: "32,30 26,38 32,38", fill: "light" },
  { id: "gem-top-right", points: "32,30 32,38 38,38", fill: "baseLight" },
  { id: "gem-bottom-left", points: "26,38 32,46 32,38", fill: "base" },
  { id: "gem-bottom-right", points: "32,38 32,46 38,38", fill: "deep" },
];

export function AeralythLogo({
  className,
  title,
  ...props
}: AeralythLogoProps) {
  const idPrefix = React.useId().replaceAll(":", "");
  const titleId = `${idPrefix}-title`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      focusable="false"
      className={cn("shrink-0", className)}
      {...props}
    >
      <title id={titleId}>{title ?? "Aeralyth"}</title>
      <defs>
        {logoFacets.map((facet) => {
          if (typeof facet.fill === "string") {
            return null;
          }

          return (
            <linearGradient
              key={facet.id}
              id={`${idPrefix}-${facet.id}`}
              gradientUnits="userSpaceOnUse"
              x1={facet.fill.x1}
              y1={facet.fill.y1}
              x2={facet.fill.x2}
              y2={facet.fill.y2}
            >
              <stop offset="0" stopColor={logoTones[facet.fill.from]} />
              <stop offset="1" stopColor={logoTones[facet.fill.to]} />
            </linearGradient>
          );
        })}
      </defs>
      <g
        shapeRendering="geometricPrecision"
        strokeLinejoin="round"
        strokeWidth="0.08"
      >
        {logoFacets.map((facet) => {
          const paint =
            typeof facet.fill === "string"
              ? logoTones[facet.fill]
              : `url(#${idPrefix}-${facet.id})`;

          return (
            <polygon
              key={facet.id}
              points={facet.points}
              fill={paint}
              stroke={paint}
            />
          );
        })}
      </g>
    </svg>
  );
}
