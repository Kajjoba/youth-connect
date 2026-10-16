/**
 * The brand mark, as inline SVG.
 *
 * DESIGN DECISION (ADR-013): the logo is inline SVG, not an image file.
 *
 * A PNG or SVG file is a separate network request that blocks the
 * header from looking finished, and on a slow connection the page sits
 * there branded as nothing for a second or two. Inlined, it costs about
 * 400 bytes inside a chunk that is already being downloaded, renders
 * with the first paint, scales to any size, and recolours with the
 * theme because it inherits currentColor.
 *
 * The mark itself: three nodes on an arc, linked. The arc reads as a
 * shared horizon and the nodes as participants in different countries
 * joined by the platform. It survives being drawn at 20px, which a
 * detailed illustration would not.
 */

export function Mark({ size = 32, title = 'YouthConnect' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* the shared horizon */}
      <path
        d="M6 33 C 14 18, 34 18, 42 33"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.35"
      />
      {/* the links */}
      <path
        d="M10 30 L24 20 L38 30"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* the participants */}
      <circle cx="10" cy="30" r="4.5" fill="currentColor" />
      <circle cx="38" cy="30" r="4.5" fill="currentColor" />
      <circle cx="24" cy="20" r="5.5" fill="var(--meter, #F5A623)" />
    </svg>
  );
}

/** Mark plus wordmark, for the masthead and the sign-in screen. */
export function Brand({ size = 32, stacked = false }) {
  return (
    <span className={stacked ? 'brand brand-stacked' : 'brand'}>
      <span className="brand-mark"><Mark size={size} /></span>
      <span className="brand-word">Youth<span>Connect</span></span>
    </span>
  );
}
