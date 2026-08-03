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

type LogoFacet = {
  id: string;
  points: string;
  x1: string;
  y1: string;
  x2: string;
  y2: string;
  from: LogoTone;
  to: LogoTone;
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

const logoFacets: LogoFacet[] = [
  {
    id: "left-top",
    points: "386,0 167,373 323,270",
    x1: "339.1",
    y1: "237.9",
    x2: "255.6",
    y2: "196.1",
    from: "baseLight",
    to: "base",
  },
  {
    id: "left-dark-mid",
    points: "167,373 323,270 216,497",
    x1: "294.7",
    y1: "393.6",
    x2: "168.9",
    y2: "364.8",
    from: "baseDark",
    to: "deep",
  },
  {
    id: "left-outer-mid",
    points: "0,671 167,373 216,497",
    x1: "197.5",
    y1: "542.2",
    x2: "73.4",
    y2: "491.5",
    from: "baseLight",
    to: "base",
  },
  {
    id: "left-lower",
    points: "0,671 216,497 166,625",
    x1: "216.4",
    y1: "497.3",
    x2: "34.8",
    y2: "701.9",
    from: "deep",
    to: "baseDark",
  },
  {
    id: "left-bridge-light",
    points: "216,497 395,546 166,625",
    x1: "241.4",
    y1: "490.2",
    x2: "270.0",
    y2: "597.3",
    from: "light",
    to: "bright",
  },
  {
    id: "left-bridge-dark",
    points: "166,625 395,546 280,635",
    x1: "361.2",
    y1: "633.3",
    x2: "188.7",
    y2: "566.5",
    from: "baseDark",
    to: "baseLight",
  },
  {
    id: "right-top",
    points: "402,0 462,265 637,406",
    x1: "366.1",
    y1: "24.2",
    x2: "627.4",
    y2: "412.5",
    from: "pale",
    to: "light",
  },
  {
    id: "right-mid",
    points: "462,265 573,501 637,406",
    x1: "637.5",
    y1: "394.1",
    x2: "456.8",
    y2: "386.3",
    from: "light",
    to: "bright",
  },
  {
    id: "right-outer-mid",
    points: "637,406 573,501 786,671",
    x1: "704.9",
    y1: "496.2",
    x2: "618.4",
    y2: "561.3",
    from: "light",
    to: "baseLight",
  },
  {
    id: "right-lower",
    points: "573,501 637,632 786,671",
    x1: "590.5",
    y1: "489.3",
    x2: "734.8",
    y2: "705.2",
    from: "baseDark",
    to: "baseLight",
  },
  {
    id: "right-bridge-light",
    points: "395,546 573,501 637,632",
    x1: "627.2",
    y1: "642.8",
    x2: "451.0",
    y2: "483.9",
    from: "baseLight",
    to: "bright",
  },
  {
    id: "right-bridge-dark",
    points: "395,546 508,635 637,632",
    x1: "608.2",
    y1: "672.2",
    x2: "407.5",
    y2: "528.5",
    from: "shadow",
    to: "deep",
  },
  {
    id: "diamond-top-left",
    points: "393,289 328,416 393,394",
    x1: "394.7",
    y1: "367.9",
    x2: "331.4",
    y2: "363.7",
    from: "pale",
    to: "light",
  },
  {
    id: "diamond-top-right",
    points: "393,289 393,394 458,416",
    x1: "441.3",
    y1: "342.0",
    x2: "389.1",
    y2: "389.7",
    from: "bright",
    to: "baseLight",
  },
  {
    id: "diamond-bottom-left",
    points: "328,416 393,478 393,394",
    x1: "407.4",
    y1: "462.2",
    x2: "341.0",
    y2: "401.7",
    from: "light",
    to: "bright",
  },
  {
    id: "diamond-bottom-right",
    points: "393,394 393,478 458,416",
    x1: "437.3",
    y1: "445.3",
    x2: "383.6",
    y2: "407.4",
    from: "baseLight",
    to: "bright",
  },
  {
    id: "bottom-left-upper",
    points: "7,713 180,736 316,839",
    x1: "175.7",
    y1: "734.8",
    x2: "158.7",
    y2: "794.0",
    from: "bright",
    to: "light",
  },
  {
    id: "bottom-left-lower",
    points: "7,713 316,839 151,822",
    x1: "140.3",
    y1: "689.7",
    x2: "170.7",
    y2: "864.3",
    from: "baseLight",
    to: "baseDark",
  },
  {
    id: "bottom-right-upper",
    points: "774,713 471,840 601,737",
    x1: "600.8",
    y1: "737.1",
    x2: "631.3",
    y2: "792.2",
    from: "light",
    to: "bright",
  },
  {
    id: "bottom-right-lower",
    points: "774,713 638,821 471,840",
    x1: "622.0",
    y1: "726.1",
    x2: "630.7",
    y2: "826.2",
    from: "baseDark",
    to: "baseLight",
  },
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
      viewBox="-70 -42 927 927"
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
          const gradientId = `${idPrefix}-${facet.id}`;

          return (
            <linearGradient
              key={facet.id}
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={facet.x1}
              y1={facet.y1}
              x2={facet.x2}
              y2={facet.y2}
            >
              <stop offset="0" stopColor={logoTones[facet.from]} />
              <stop offset="1" stopColor={logoTones[facet.to]} />
            </linearGradient>
          );
        })}
      </defs>
      <g
        shapeRendering="geometricPrecision"
        strokeLinejoin="round"
        strokeWidth="0.55"
      >
        {logoFacets.map((facet) => {
          const paint = `url(#${idPrefix}-${facet.id})`;

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
