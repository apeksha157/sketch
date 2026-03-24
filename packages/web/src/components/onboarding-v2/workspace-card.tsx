import { useEffect, useRef, useState } from "react";
import { SketchIcon } from "./spark-icon";
import type { AuthMethod } from "./types";

interface WorkspaceCardProps {
  authMethod: AuthMethod;
  data: {
    name: string;
    members: number;
    channels: number;
    email?: string;
    role?: string;
  };
  isAdmin: boolean;
  onComplete?: () => void;
  /** When true, show all rows immediately without animation and don't call onComplete. */
  frozen?: boolean;
}

/** Fixed palette for generated member avatars */
const AVATAR_COLORS = ["#5B8DEF", "#9B6DFF", "#F0A050", "#4CB87E", "#E05C7A", "#50B8C8"];

/** Generates N placeholder avatar initials + colors deterministically. */
function genAvatars(count: number) {
  const letters = "ABCDEFGHJKLMNPRSTW";
  return Array.from({ length: Math.min(count, 6) }, (_, i) => ({
    letter: letters[i % letters.length],
    color: AVATAR_COLORS[i % AVATAR_COLORS.length],
  }));
}

/** Stacked avatar pile for the Members row. */
function MemberAvatars({ count }: { count: number }) {
  const shown = Math.min(count, 4);
  const avatars = genAvatars(shown);
  const extra = count - shown;
  return (
    <div className="ob-avatars">
      {avatars.map((a, i) => (
        <span
          key={i}
          className="ob-avatar"
          style={{ background: a.color, zIndex: shown - i }}
          aria-hidden="true"
        >
          {a.letter}
        </span>
      ))}
      {extra > 0 && (
        <span className="ob-avatar ob-avatar-extra" style={{ zIndex: 0 }} aria-hidden="true">
          +{extra}
        </span>
      )}
      <span className="ob-avatars-label">{count} people</span>
    </div>
  );
}

/** Channel chips row — shows first 2 named channels and a "+N more" badge. */
function ChannelChips({ total }: { total: number }) {
  const named = ["general", "random"];
  const extra = Math.max(0, total - named.length);
  return (
    <div className="ob-channel-chips">
      {named.map((ch) => (
        <span key={ch} className="ob-channel-chip">
          <span className="ob-channel-hash">#</span>
          {ch}
        </span>
      ))}
      {extra > 0 && <span className="ob-channel-chip ob-channel-chip-more">+{extra} more</span>}
    </div>
  );
}

/** Workspace logo — first letter of name in a rounded square. */
function WorkspaceLogo({ name }: { name: string }) {
  const letter = name.trim()[0]?.toUpperCase() ?? "W";
  return (
    <span className="ob-ws-logo" aria-hidden="true">
      {letter}
    </span>
  );
}

/** Animated card revealing workspace info line by line. Frozen mode shows all rows instantly. */
export function WorkspaceCard({ authMethod, data, isAdmin, onComplete, frozen = false }: WorkspaceCardProps) {
  const rowCount = 3;
  const [visibleRows, setVisibleRows] = useState(frozen ? rowCount : 0);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (frozen) return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    for (let i = 0; i < rowCount; i++) {
      timers.push(setTimeout(() => setVisibleRows(i + 1), (i + 1) * 1000));
    }

    // Extra 1.5s pause after the last row before proceeding — gives user time to read
    timers.push(setTimeout(() => onCompleteRef.current?.(), rowCount * 1000 + 1500));

    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [frozen]);

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-workspace-card">
        <div className="ob-workspace-header">
          <SketchIcon size={20} />
          SETTING UP WORKSPACE
        </div>

        {/* Row 1 */}
        {visibleRows >= 1 && (
          <div className="ob-workspace-row ob-animate-row">
            <span className="ob-workspace-row-label">{authMethod === "slack" ? "Workspace" : "Account"}</span>
            <span className="ob-workspace-row-value ob-ws-name-value">
              {authMethod === "slack" ? (
                <>
                  <WorkspaceLogo name={data.name} />
                  {data.name}
                </>
              ) : (
                <>
                  <span className="ob-user-avatar" aria-hidden="true">
                    {(data.email || data.name).trim()[0].toUpperCase()}
                  </span>
                  {data.email}
                </>
              )}
            </span>
          </div>
        )}

        {/* Row 2 */}
        {visibleRows >= 2 && (
          <div className="ob-workspace-row ob-animate-row">
            <span className="ob-workspace-row-label">{authMethod === "slack" ? "Members" : "Workspace"}</span>
            <span className="ob-workspace-row-value ob-ws-name-value">
              {authMethod === "slack" ? (
                <MemberAvatars count={data.members} />
              ) : (
                <>
                  <WorkspaceLogo name={data.name} />
                  {data.name}
                </>
              )}
            </span>
          </div>
        )}

        {/* Row 3 */}
        {visibleRows >= 3 && (
          <div className="ob-workspace-row ob-animate-row">
            <span className="ob-workspace-row-label">{authMethod === "slack" ? "Channels" : "Role"}</span>
            <span className="ob-workspace-row-value">
              {authMethod === "slack" ? (
                <ChannelChips total={data.channels} />
              ) : (
                <span className={`ob-role-badge${isAdmin ? " ob-role-badge-admin" : ""}`}>
                  {isAdmin ? "Admin" : "Member"}
                </span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
