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
        cx="78"
        cy="116"
        rx="54"
        ry="7"
        fill="var(--foreground)"
        opacity="0.06"
      />

      <path
        d="M18 39c0-7.18 5.82-13 13-13h28.3c4.01 0 7.8 1.85 10.26 5.02l7.88 10.14A13 13 0 0 0 87.7 46H124c7.18 0 13 5.82 13 13v38c0 7.18-5.82 13-13 13H31c-7.18 0-13-5.82-13-13V39Z"
        fill="var(--muted)"
        stroke="var(--muted-foreground)"
        strokeWidth="2.5"
        opacity="0.82"
      />
      <path
        d="M20 62h115v35c0 6.08-4.92 11-11 11H31c-6.08 0-11-4.92-11-11V62Z"
        fill="var(--background)"
        opacity="0.72"
      />
      <path
        d="M20 62h115"
        stroke="var(--muted-foreground)"
        strokeWidth="2"
        opacity="0.28"
      />

      <rect
        x="42"
        y="70"
        width="54"
        height="27"
        rx="6"
        fill="var(--primary)"
        opacity="0.08"
      />
      <path
        d="M51 79h29M51 87h20"
        stroke="var(--primary)"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.62"
      />

      <circle
        cx="112"
        cy="88"
        r="31"
        fill="var(--background)"
        stroke="var(--border)"
        strokeWidth="2.5"
        className="drop-shadow-[0_14px_24px_rgb(0_0_0/0.18)]"
      />
      <circle cx="107" cy="83" r="12" fill="var(--primary)" opacity="0.12" />
      <circle cx="107" cy="83" r="11" stroke="var(--primary)" strokeWidth="4" />
      <path
        d="m115.5 91.5 11 11"
        stroke="var(--primary)"
        strokeWidth="4"
        strokeLinecap="round"
      />

      <circle cx="137" cy="48" r="2.5" fill="var(--primary)" opacity="0.8" />
      <circle cx="28" cy="21" r="2" fill="var(--primary)" opacity="0.45" />
      <path
        d="M145 69h7M148.5 65.5v7"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}
