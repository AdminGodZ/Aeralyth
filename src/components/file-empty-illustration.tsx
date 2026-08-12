import { cn } from "@/lib/utils";

export function FileEmptyIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 132"
      fill="none"
      aria-hidden="true"
      className={cn("size-full", className)}
    >
      <path
        d="M27 48V25.5C27 19.15 32.15 14 38.5 14h70c6.9 0 12.5 5.6 12.5 12.5V50H27v-2Z"
        fill="var(--muted)"
        opacity="0.62"
      />
      <path
        d="M27 33V25.5C27 19.15 32.15 14 38.5 14h70c6.9 0 12.5 5.6 12.5 12.5V47"
        stroke="color-mix(in srgb, var(--foreground) 72%, transparent)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M25.9 31h44.6c4.9 0 9.6 2.1 12.9 5.7l6.7 7.25a13 13 0 0 0 9.55 4.15h27.9c7.7 0 13.67 6.75 12.74 14.4l-5.25 43.2c-.78 6.44-6.25 11.3-12.74 11.3H31.5c-6.8 0-12.4-5.2-13-12L13.1 45c-.7-7.6 5.2-14 12.8-14Z"
        fill="var(--card)"
        stroke="color-mix(in srgb, var(--foreground) 72%, transparent)"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />

      <path
        d="M41.5 58.5 54.5 71.5M54.5 58.5l-13 13M94.5 56l13 13M107.5 56l-13 13"
        stroke="color-mix(in srgb, var(--foreground) 72%, transparent)"
        strokeWidth="3.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M56.5 93.5c11-11.3 29-11.3 40 0"
        stroke="color-mix(in srgb, var(--foreground) 72%, transparent)"
        strokeWidth="3.25"
        strokeLinecap="round"
      />

      <path
        d="m123 13.5 5-8.5M128 20l9-7M130 27l11-1"
        stroke="color-mix(in srgb, var(--foreground) 72%, transparent)"
        strokeWidth="3.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
