/**
 * Sketch brand icon — hand-drawn spark with "S" in the center.
 * Uses actual PNG assets from /logos/.
 *
 * - "dark" variant: white icon, for use on dark backgrounds (default)
 * - "light" variant: black icon, for use on light/yellow backgrounds
 */
export function SketchIcon({ size = 20, variant = "dark" }: { size?: number; variant?: "dark" | "light" }) {
  const src = variant === "light" ? "/logos/sketch-icon-light.png" : "/logos/sketch-icon-dark.png";
  return (
    <img src={src} alt="" aria-hidden="true" width={size} height={size} style={{ display: "block", flexShrink: 0 }} />
  );
}

/** Sketch icon used as avatar next to the "SKETCH" sender label in chat messages. */
export function SparkAvatar({ size = 20 }: { size?: number }) {
  return <SketchIcon size={size} variant="light" />;
}
