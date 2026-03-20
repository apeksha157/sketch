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
  onComplete: () => void;
}

interface RowData {
  label: string;
  value: string;
}

/** Animated card revealing workspace info line by line. */
export function WorkspaceCard({ authMethod, data, isAdmin, onComplete }: WorkspaceCardProps) {
  const [visibleRows, setVisibleRows] = useState(0);

  const rows: RowData[] =
    authMethod === "slack"
      ? [
          { label: "Workspace", value: data.name },
          { label: "Members", value: `${data.members} people` },
          { label: "Channels", value: `${data.channels} channels` },
        ]
      : [
          { label: "Account", value: data.email || "" },
          { label: "Workspace", value: data.name },
          { label: "Role", value: isAdmin ? "Admin" : "Member" },
        ];

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const rowCount = rows.length;
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (let i = 0; i < rowCount; i++) {
      timers.push(
        setTimeout(
          () => {
            setVisibleRows(i + 1);
          },
          (i + 1) * 1000,
        ),
      );
    }

    timers.push(
      setTimeout(
        () => {
          onCompleteRef.current();
        },
        (rowCount + 1) * 1000,
      ),
    );

    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [rowCount]);

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-workspace-card">
        <div className="ob-workspace-header">
          <SketchIcon size={20} />
          SETTING UP WORKSPACE
        </div>

        {rows.map(
          (row, i) =>
            i < visibleRows && (
              <div key={row.label} className="ob-workspace-row ob-animate-row">
                <span className="ob-workspace-row-label">{row.label}</span>
                <span className="ob-workspace-row-value">{row.value}</span>
              </div>
            ),
        )}
      </div>
    </div>
  );
}
