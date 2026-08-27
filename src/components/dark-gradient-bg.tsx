import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type DarkGradientBgProps = {
  as?: "div" | "main";
  children?: ReactNode;
  className?: string;
};

const STREAK_MASKS = [
  "linear-gradient(90deg, transparent 0%, #000 20%, transparent 36%, #000 55%, rgb(0 0 0 / 13%) 67%, #000 78%, transparent 97%)",
  "linear-gradient(90deg, transparent 11%, #000 25%, rgb(0 0 0 / 55%) 41%, rgb(0 0 0 / 13%) 67%, #000 78%, transparent 97%)",
  "linear-gradient(90deg, transparent 9%, #000 20%, rgb(0 0 0 / 55%) 28%, rgb(0 0 0 / 42%) 40%, #000 48%, rgb(0 0 0 / 27%) 54%, rgb(0 0 0 / 13%) 78%, #000 88%, transparent 97%)",
  "linear-gradient(90deg, transparent 0%, #000 17%, rgb(0 0 0 / 55%) 26%, #000 35%, transparent 47%, rgb(0 0 0 / 13%) 69%, #000 79%, transparent 97%)",
  "linear-gradient(90deg, transparent 0%, #000 20%, rgb(0 0 0 / 55%) 27%, #000 42%, transparent 48%, rgb(0 0 0 / 13%) 67%, #000 74%, #000 82%, rgb(0 0 0 / 47%) 88%, transparent 97%)",
] as const;

export function DarkGradientBg({
  as: Component = "div",
  children,
  className,
}: DarkGradientBgProps) {
  return (
    <Component
      className={cn(
        "dark relative min-h-screen min-h-dvh w-full overflow-hidden bg-black",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(100% 100% at 0% 0%, rgb(46 46 46) 0%, rgb(0 0 0) 100%)",
            maskImage:
              "radial-gradient(125% 100% at 0% 0%, #000 0%, rgb(0 0 0 / 22.4%) 88.2883%, transparent 100%)",
            WebkitMaskImage:
              "radial-gradient(125% 100% at 0% 0%, #000 0%, rgb(0 0 0 / 22.4%) 88.2883%, transparent 100%)",
          }}
        >
          {STREAK_MASKS.map((maskImage) => (
            <div
              key={maskImage}
              className="absolute inset-0 opacity-20"
              style={{
                background:
                  "linear-gradient(rgb(0 207 255) 0%, rgb(0 207 255 / 0%) 100%)",
                maskImage,
                WebkitMaskImage: maskImage,
                transform: "skewX(45deg)",
              }}
            />
          ))}
        </div>

        <div
          className="absolute inset-0 bg-repeat opacity-[0.05]"
          style={{
            backgroundImage: 'url("/dark-gradient-noise.svg")',
            backgroundSize: "149.76px",
          }}
        />
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgb(255 255 255 / 50%) 1px, transparent 0)",
            backgroundSize: "20px 20px",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 15%, rgb(30 41 59 / 20%), transparent 48%)",
          }}
        />
      </div>

      <div className="relative z-10">{children}</div>
    </Component>
  );
}
