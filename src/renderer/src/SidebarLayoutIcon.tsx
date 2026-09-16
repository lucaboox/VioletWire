/**
 * Theater mode's icon: the window with its side panel, filled in once theater
 * is on. Shared so the single player and multistream show the same thing.
 */
export function SidebarLayoutIcon({ filled, size = 18 }: { filled: boolean; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M15 3v18" />
      {filled && <path d="M16 4h4v16h-4z" fill="currentColor" stroke="none" />}
    </svg>
  );
}
