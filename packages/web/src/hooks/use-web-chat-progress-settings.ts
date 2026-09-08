import { type WebChatToolProgress, api } from "@/lib/api";
import { useEffect, useRef, useState } from "react";

export const WEB_CHAT_PROGRESS_MODES: Array<{ value: WebChatToolProgress; label: string }> = [
  { value: "off", label: "Off" },
  { value: "friendly", label: "Friendly" },
  { value: "technical", label: "Technical" },
];

export function useWebChatProgressSettings() {
  const mutationId = useRef(0);
  const [toolProgress, setToolProgress] = useState<WebChatToolProgress>("friendly");
  const [pendingToolProgress, setPendingToolProgress] = useState<WebChatToolProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.webChat
      .progressSettings()
      .then(({ toolProgress }) => {
        if (!cancelled && mutationId.current === 0) setToolProgress(toolProgress);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const changeToolProgress = (next: WebChatToolProgress) => {
    if (next === (pendingToolProgress ?? toolProgress)) return;
    const previous = toolProgress;
    const current = ++mutationId.current;
    setToolProgress(next);
    setPendingToolProgress(next);
    void api.webChat
      .updateProgressSettings(next)
      .then(({ toolProgress }) => {
        if (mutationId.current === current) setToolProgress(toolProgress);
      })
      .catch(() => {
        if (mutationId.current === current) setToolProgress(previous);
      })
      .finally(() => {
        if (mutationId.current === current) setPendingToolProgress(null);
      });
  };

  return { toolProgress, pendingToolProgress, changeToolProgress };
}
