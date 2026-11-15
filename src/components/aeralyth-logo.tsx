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

type AeralythLogoProps = {
  className?: string;
  /**
   * The surface behind the mark. "theme" follows the light or dark theme;
   * "dark" is for surfaces that stay dark in both, such as the dashboard.
   */
  surface?: "theme" | "dark";
};

// The mark's geometry and shading, which the login page's LED matrix draws.
// public/aeralyth_logo_light.svg and aeralyth_logo_dark.svg bake it to greys.
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

/** How bright each tone is, 0 to 255, for rendering the mark without color. */
export const aeralythLogoToneLevels: Record<LogoTone, number> = {
  pale: 255,
  light: 238,
  bright: 222,
  baseLight: 204,
  base: 184,
  baseDark: 150,
  deep: 122,
  shadow: 98,
};

/** The mark's facets as numbers, in its 64 by 64 box. */
export const aeralythLogoFacets = logoFacets.map((facet) => ({
  points: facet.points
    .split(" ")
    .map((point) => point.split(",").map(Number) as [number, number]),
  from: typeof facet.fill === "string" ? facet.fill : facet.fill.from,
  to: typeof facet.fill === "string" ? facet.fill : facet.fill.to,
}));

/**
 * The monochrome mark: white on dark surfaces, black on light ones. On a
 * themed surface both files sit in one box so the swap follows the theme
 * class without a flash, and the caller's classes (size, visibility) apply to
 * the box. It is decorative: every use sits next to the product name or a
 * labelled link.
 */
export function AeralythLogo({
  className,
  surface = "theme",
}: AeralythLogoProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 select-none", className)}
    >
      {surface === "theme" ? (
        // biome-ignore lint/performance/noImgElement: a static SVG gains nothing from next/image.
        <img
          src="/aeralyth_logo_light.svg"
          alt=""
          draggable={false}
          className="size-full dark:hidden"
        />
      ) : null}
      {/* biome-ignore lint/performance/noImgElement: a static SVG gains nothing from next/image. */}
      <img
        src="/aeralyth_logo_dark.svg"
        alt=""
        draggable={false}
        className={cn("size-full", surface === "theme" && "hidden dark:block")}
      />
    </span>
  );
}
