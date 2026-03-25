import { useTheme } from "@/hooks/use-theme";
import { useEffect, useRef, useState } from "react";
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
    /** Icon shown in the workspace logo square — provide both variants for theme switching. */
    iconDark?: string;
    iconLight?: string;
  };
  isAdmin: boolean;
  onComplete?: () => void;
  /** When true, show all rows immediately without animation and don't call onComplete. */
  frozen?: boolean;
}

/** Fixed palette for generated member avatars */
const AVATAR_COLORS = ["#5B8DEF", "#9B6DFF", "#F0A050", "#4CB87E", "#E05C7A", "#50B8C8"];

function genAvatars(count: number) {
  const letters = "ABCDEFGHJKLMNPRSTW";
  return Array.from({ length: Math.min(count, 3) }, (_, i) => ({
    letter: letters[i % letters.length],
    color: AVATAR_COLORS[i % AVATAR_COLORS.length],
  }));
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
  const letter = name.trim()[0]?.toUpperCase() ?? "W";
  return (
    <span className="ob-ws-icon" style={{ width: size, height: size }} aria-hidden="true">
      {letter}
    </span>
  );
}

/** Animated card revealing workspace info section by section. Frozen mode shows all at once. */
export function WorkspaceCard({ authMethod, data, isAdmin, onComplete, frozen = false }: WorkspaceCardProps) {
  const sectionCount = authMethod === "slack" ? 2 : 2;
  const [visibleSections, setVisibleSections] = useState(frozen ? sectionCount : 0);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (frozen) return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    for (let i = 0; i < sectionCount; i++) {
      timers.push(setTimeout(() => setVisibleSections(i + 1), (i + 1) * 1000));
    }

    timers.push(setTimeout(() => onCompleteRef.current?.(), sectionCount * 1000 + 1500));

    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [frozen, sectionCount]);

  const avatars = genAvatars(data.members);

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-workspace-card">
        <div className="ob-workspace-header">
          <ThemedSketchIcon size={20} />
          SETTING UP WORKSPACE
        </div>

        {authMethod === "slack" ? (
          <>
            {/* Section 1: Identity hero */}
            {visibleSections >= 1 && (
              <div className="ob-ws-identity ob-animate-row">
                <WorkspaceIcon name={data.name} iconDark={data.iconDark} iconLight={data.iconLight} />
                <div className="ob-ws-identity-info">
                  <div className="ob-ws-identity-name">{data.name}</div>
                  <div className="ob-ws-identity-sub">{data.email || `${data.members} members`}</div>
                </div>
                <span className={`ob-role-badge${isAdmin ? " ob-role-badge-admin" : ""}`}>
                  {isAdmin ? "Admin" : "Member"}
                </span>
              </div>
            )}

            {/* Section 2: Stats chips */}
            {visibleSections >= 2 && (
              <div className="ob-ws-stats ob-animate-row">
                <div className="ob-ws-stat-chip">
                  <div>
                    <div className="ob-ws-stat-number">{data.members}</div>
                    <div className="ob-ws-stat-label">MEMBERS</div>
                  </div>
                  <div className="ob-ws-stat-avatars">
                    {avatars.map((a, i) => (
                      <span
                        key={a.letter}
                        className="ob-avatar"
                        style={{ background: a.color, zIndex: avatars.length - i }}
                        aria-hidden="true"
                      >
                        {a.letter}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="ob-ws-stat-chip">
                  <div>
                    <div className="ob-ws-stat-number">{data.channels}</div>
                    <div className="ob-ws-stat-label">CHANNELS</div>
                  </div>
                  <div className="ob-ws-stat-chips">
                    <span className="ob-ws-mini-chip">#general</span>
                    <span className="ob-ws-mini-chip">#random</span>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Section 1: Account row */}
            {visibleSections >= 1 && (
              <div className="ob-account-row ob-animate-row">
                <span className="ob-user-avatar" aria-hidden="true">
                  {(data.email || data.name).trim()[0].toUpperCase()}
                </span>
                <span className="ob-account-email">{data.email}</span>
              </div>
            )}

            {/* Section 2: Identity hero */}
            {visibleSections >= 2 && (
              <div className="ob-ws-identity ob-animate-row">
                <WorkspaceIcon name={data.name} iconDark={data.iconDark} iconLight={data.iconLight} />
                <div className="ob-ws-identity-info">
                  <div className="ob-ws-identity-name">{data.name}</div>
                  <div className="ob-ws-identity-sub">
                    {data.members} {data.members === 1 ? "member" : "members"}
                  </div>
                </div>
                <span className={`ob-role-badge${isAdmin ? " ob-role-badge-admin" : ""}`}>
                  {isAdmin ? "Admin" : "Member"}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
