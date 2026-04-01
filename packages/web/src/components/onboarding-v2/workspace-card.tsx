import { useTheme } from "@/hooks/use-theme";
import { useEffect, useRef } from "react";
import { ThemedSketchIcon } from "./spark-icon";
import type { AuthMethod } from "./types";

interface WorkspaceCardProps {
  authMethod: AuthMethod;
  data: {
    name: string;
    members: number;
    channels: number;
    email?: string;
    role?: string;
    iconDark?: string;
    iconLight?: string;
  };
  isAdmin: boolean;
  onComplete?: () => void;
  /** When true, show all content immediately without animation and don't call onComplete. */
  frozen?: boolean;
}


/** Workspace icon — image if provided, fallback to first letter. */
function WorkspaceIcon({
  name,
  iconDark,
  iconLight,
  size = 48,
}: { name: string; iconDark?: string; iconLight?: string; size?: number }) {
  const { resolvedTheme } = useTheme();
  const iconSrc = resolvedTheme === "dark" ? iconDark : iconLight;
  if (iconSrc) {
    return (
      <span className="ob-ws-icon ob-ws-icon-img" style={{ width: size, height: size }} aria-hidden="true">
        <img src={iconSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </span>
    );
  }
  return null;
}

/** Card revealing workspace info with a single clean fade-in. Frozen mode shows instantly. */
export function WorkspaceCard({ authMethod, data, isAdmin, onComplete, frozen = false }: WorkspaceCardProps) {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (frozen) return;
    const timer = setTimeout(() => onCompleteRef.current?.(), 1500);
    return () => clearTimeout(timer);
  }, [frozen]);

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-workspace-card">
        <div className="ob-workspace-header">
          <ThemedSketchIcon size={20} />
          SETTING UP WORKSPACE
        </div>

        {authMethod === "slack" ? (
          <>
            {/* Identity hero */}
            <div className="ob-ws-identity">
              <WorkspaceIcon name={data.name} iconDark={data.iconDark} iconLight={data.iconLight} />
              <div className="ob-ws-identity-info">
                <div className="ob-ws-identity-name">{data.name}</div>
              </div>
              <span className={`ob-role-badge${isAdmin ? " ob-role-badge-admin" : ""}`}>
                {isAdmin ? "Admin" : "Member"}
              </span>
            </div>

            {/* Stats chips */}
            <div className="ob-ws-stats">
              <div className="ob-ws-stat-chip">
                <div className="ob-ws-stat-number">{data.members}</div>
                <div className="ob-ws-stat-label">MEMBERS</div>
              </div>
              <div className="ob-ws-stat-chip">
                <div className="ob-ws-stat-number">{data.channels}</div>
                <div className="ob-ws-stat-label">CHANNELS</div>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Google: account email row */}
            <div className="ob-account-row">
              <span className="ob-account-email">{data.email}</span>
              <span className="ob-user-avatar" aria-hidden="true">
                {(data.email || data.name).trim()[0].toUpperCase()}
              </span>
            </div>

            {/* Google: identity hero (no member count) */}
            <div className="ob-ws-identity">
              <WorkspaceIcon name={data.name} iconDark={data.iconDark} iconLight={data.iconLight} />
              <div className="ob-ws-identity-info">
                <div className="ob-ws-identity-name">{data.name}</div>
              </div>
              <span className={`ob-role-badge${isAdmin ? " ob-role-badge-admin" : ""}`}>
                {isAdmin ? "Admin" : "Member"}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
