export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect
        width="28"
        height="28"
        rx="7"
        fill="#0F1115"
        stroke="var(--border-strong)"
        strokeWidth="1"
      />
      <circle cx="8" cy="14" r="3" fill="#C2410C" />
      <circle cx="14" cy="14" r="3" fill="#6741D9" />
      <circle cx="20" cy="14" r="3" fill="#1971C2" />
    </svg>
  );
}
