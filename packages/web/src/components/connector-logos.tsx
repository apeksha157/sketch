/**
 * Brand SVG logos for connector integrations.
 *
 * All icons use viewBox="0 0 24 24" and fill="currentColor" so they
 * inherit the parent's text color. Wrap in a colored container to
 * show the brand color, or apply the color directly.
 *
 * Source: Simple Icons (CC0 1.0 Universal license).
 */

interface LogoProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function GoogleDriveLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z" />
    </svg>
  );
}

export function ClickUpLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z" />
    </svg>
  );
}

export function NotionLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

export function LinearLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

export function SlackLogo({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.521A2.528 2.528 0 0 1 0 15.165a2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zm1.27 0a2.528 2.528 0 0 1 2.52-2.52 2.528 2.528 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.832 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.83 5.042a2.528 2.528 0 0 1-2.52-2.52A2.528 2.528 0 0 1 8.83 0a2.528 2.528 0 0 1 2.522 2.522v2.52H8.831zm0 1.27a2.528 2.528 0 0 1 2.522 2.52 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.832a2.528 2.528 0 0 1 2.522-2.521h6.31zm10.122 2.52a2.528 2.528 0 0 1 2.522-2.52A2.528 2.528 0 0 1 24 8.832a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.832zm-1.268 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.522-2.52V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.521 2.522v6.31zm-2.521 10.122a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.165 24a2.528 2.528 0 0 1-2.522-2.522v-2.522h2.522zm0-1.268a2.528 2.528 0 0 1-2.522-2.521 2.528 2.528 0 0 1 2.522-2.522h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.521h-6.313z" />
    </svg>
  );
}

export function WhatsAppLogo({ size = 16, className, style }: LogoProps) {
  // Simple Icons WhatsApp glyph — silhouette ready for white-on-brand-color rendering.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

export function FirefliesLogo({ size = 16, className, style }: LogoProps) {
  // Fireflies brand mark — actual firefly silhouette (Simple Icons, CC0).
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d="M16.6 4.8c0-1.2-.5-2.3-1.5-3-1.7-1.3-4.4-1.3-6.1 0-1 .7-1.5 1.8-1.5 3 0 .5.1.9.3 1.4-.7-.2-1.5-.3-2.3-.3-3.2 0-5.5 2.4-5.5 5.5 0 .9.2 1.8.7 2.6.3.5.6 1 1.1 1.4.8.7 1.8 1.1 3 1.1.8 0 1.6-.2 2.2-.6-.4 1-.6 2-.6 3.1 0 4.5 3.7 8.2 8.2 8.2s8.2-3.7 8.2-8.2c0-1.1-.2-2.1-.6-3.1.6.4 1.4.6 2.2.6 1.1 0 2.1-.4 3-1.1.4-.4.8-.9 1.1-1.4.4-.8.6-1.7.6-2.6 0-3.1-2.3-5.5-5.5-5.5-.8 0-1.5.1-2.3.3.2-.5.3-.9.3-1.4z" />
    </svg>
  );
}

/**
 * Abstract shape "logos" — geometric primitives used as placeholders for
 * additional integrations in demos / dense backgrounds (e.g., Integrations
 * card's floating-glyph layer). Each is a distinct silhouette so the visual
 * stays varied; opacity wrapping + brand color keep them feeling on-brand.
 */
function ShapeSVG({ size, className, style, path }: LogoProps & { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
const SHAPE_PATHS: Record<string, string> = {
  "shape-hexagon": "M12 2L22 7v10l-10 5L2 17V7z",
  "shape-diamond": "M12 2l10 10-10 10L2 12z",
  "shape-triangle": "M12 3L22 21H2z",
  "shape-square": "M3 3h18v18H3z",
  "shape-plus": "M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z",
  "shape-star": "M12 2l3 7h7l-6 5 2 8-6-4-6 4 2-8-6-5h7z",
  "shape-pill": "M5 8h14a4 4 0 010 8H5a4 4 0 010-8z",
  "shape-ring":
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z",
};

/** Returns the brand logo component for a connector type, or null if unknown. */
export function ConnectorLogo({
  type,
  size = 16,
  className,
  style,
}: {
  type: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const props = { size, className, style };
  switch (type) {
    case "google_drive":
    case "drive":
      return <GoogleDriveLogo {...props} />;
    case "clickup":
      return <ClickUpLogo {...props} />;
    case "notion":
      return <NotionLogo {...props} />;
    case "linear":
      return <LinearLogo {...props} />;
    case "slack":
      return <SlackLogo {...props} />;
    case "whatsapp":
      return <WhatsAppLogo {...props} />;
    case "fireflies":
      return <FirefliesLogo {...props} />;
    default: {
      const shapePath = SHAPE_PATHS[type];
      if (shapePath) return <ShapeSVG {...props} path={shapePath} />;
      return null;
    }
  }
}
