import { cn } from "@/lib/utils";

export function FileEmptyIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 132"
      fill="none"
      aria-hidden="true"
      className={cn("size-full", className)}
    >
      <ellipse
        cx="79"
        cy="116"
        rx="53"
        ry="6"
        fill="var(--foreground)"
        opacity="0.055"
      />

      <path
        d="M18.5 59V38c0-8.28 6.72-15 15-15h27.84c5.04 0 9.78 2.39 12.78 6.44l7.8 10.53a16 16 0 0 0 12.86 6.48h32.72c7.73 0 14 6.27 14 14V94.5c0 8.28-6.72 15-15 15h-93c-8.28 0-15-6.72-15-15V59Z"
        fill="var(--muted)"
        opacity="0.72"
      />
      <path
        d="M18.5 59h123v35.5c0 8.28-6.72 15-15 15h-93c-8.28 0-15-6.72-15-15V59Z"
        fill="var(--card)"
      />
      <path
        d="M18.5 59V38c0-8.28 6.72-15 15-15h27.84c5.04 0 9.78 2.39 12.78 6.44l7.8 10.53a16 16 0 0 0 12.86 6.48h32.72c7.73 0 14 6.27 14 14V94.5c0 8.28-6.72 15-15 15h-93c-8.28 0-15-6.72-15-15V59Z"
        stroke="color-mix(in srgb, var(--muted-foreground) 54%, transparent)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M19.88 59h120.24"
        stroke="color-mix(in srgb, var(--muted-foreground) 20%, transparent)"
        strokeWidth="1.75"
      />

      <rect
        x="37"
        y="68"
        width="53"
        height="29"
        rx="7"
        fill="var(--primary)"
        opacity="0.065"
      />
      <path
        d="M47 78h30M47 87h20"
        stroke="color-mix(in srgb, var(--primary) 72%, transparent)"
        strokeWidth="2.75"
        strokeLinecap="round"
      />

      <circle
        cx="111"
        cy="88.5"
        r="32.5"
        fill="var(--foreground)"
        opacity="0.035"
      />
      <circle
        cx="111"
        cy="86"
        r="31.5"
        fill="var(--card)"
        stroke="color-mix(in srgb, var(--muted-foreground) 26%, transparent)"
        strokeWidth="2.25"
        className="drop-shadow-[0_14px_24px_rgb(0_0_0/0.14)]"
      />
      <circle
        cx="111"
        cy="86"
        r="27.5"
        stroke="color-mix(in srgb, var(--primary) 8%, transparent)"
      />

      <circle
        cx="105.5"
        cy="80.5"
        r="11.75"
        fill="color-mix(in srgb, var(--primary) 9%, transparent)"
        stroke="var(--primary)"
        strokeWidth="4.5"
      />
      <path
        d="m114.25 89.25 13 13"
        stroke="var(--primary)"
        strokeWidth="4.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
