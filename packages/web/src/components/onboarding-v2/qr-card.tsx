import { useTheme } from "@/hooks/use-theme";
import { useCallback, useEffect, useRef, useState } from "react";

interface QRCardProps {
  onConnected: (phone: string) => void;
  demo?: boolean;
}

/** WhatsApp icon SVG */
function WhatsAppIcon({ size = 16, color = "#25D366" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

/** Self-contained QR code card with WhatsApp branding. Transitions from scanning → verifying → connected in-place. */
export function QRCard({ onConnected, demo = true }: QRCardProps) {
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState<"scanning" | "verifying" | "connected" | "expired">("scanning");
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    if (!demo) return;
    // Demo: scanning → verifying at 2.5s → connected at 4.5s
    const t1 = setTimeout(() => setStatus("verifying"), 2500);
    const t2 = setTimeout(() => {
      setStatus("connected");
      onConnected("+1 (555) 234-5678");
    }, 4500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [demo, onConnected]);

  useEffect(() => {
    if (demo) return;
    if (elapsed >= 60 && status === "scanning") {
      setStatus("expired");
      clearInterval(timerRef.current);
    }
  }, [elapsed, status, demo]);

  const handleRefresh = useCallback(() => {
    setStatus("scanning");
    setElapsed(0);
  }, []);

  const isConnected = status === "connected";
  const isVerifying = status === "verifying";

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-qr-card" data-connected={isConnected}>
        {/* Header */}
        <div className="ob-qr-header" data-connected={isConnected}>
          <WhatsAppIcon size={14} color={isConnected ? "#25D366" : resolvedTheme === "dark" ? "#feed01" : "#6b6200"} />
          {isConnected ? "WHATSAPP CONNECTED" : "CONNECT WHATSAPP"}
        </div>

        {isConnected ? (
          <>
            <div className="ob-qr-success-circle">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <path
                  d="M5 11L9 15L17 7"
                  stroke="#fff"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="ob-qr-text ob-qr-connected">Connected!</span>
            <span className="ob-qr-subtext">Confirmation sent to your phone.</span>
          </>
        ) : status === "expired" ? (
          <>
            <span className="ob-qr-text">QR code expired.</span>
            <button type="button" className="ob-btn ob-btn-primary" onClick={handleRefresh}>
              Generate new code
            </button>
          </>
        ) : (
          <>
            <div className="ob-qr-container" data-verifying={isVerifying}>
              {/* Placeholder QR — production uses server-generated QR */}
              <svg viewBox="0 0 180 180" width="200" height="200" role="img" aria-label="QR code">
                <title>QR code</title>
                <rect width="180" height="180" fill="#fff" />
                <rect x="12" y="12" width="48" height="48" rx="4" fill="#000" />
                <rect x="18" y="18" width="36" height="36" rx="2" fill="#fff" />
                <rect x="24" y="24" width="24" height="24" rx="2" fill="#000" />
                <rect x="120" y="12" width="48" height="48" rx="4" fill="#000" />
                <rect x="126" y="18" width="36" height="36" rx="2" fill="#fff" />
                <rect x="132" y="24" width="24" height="24" rx="2" fill="#000" />
                <rect x="12" y="120" width="48" height="48" rx="4" fill="#000" />
                <rect x="18" y="126" width="36" height="36" rx="2" fill="#fff" />
                <rect x="24" y="132" width="24" height="24" rx="2" fill="#000" />
                {[72, 84, 96, 108].map((x) =>
                  [72, 84, 96, 108].map((y) => (
                    <rect
                      key={`${x}-${y}`}
                      x={x}
                      y={y}
                      width="10"
                      height="10"
                      rx="1"
                      fill="#000"
                      opacity={(x + y) % 24 === 0 ? 0 : 1}
                    />
                  )),
                )}
                {[72, 84, 96].map((x) =>
                  [12, 24, 36, 48].map((y) => (
                    <rect
                      key={`m-${x}-${y}`}
                      x={x}
                      y={y}
                      width="10"
                      height="10"
                      rx="1"
                      fill="#000"
                      opacity={(x * y) % 5 === 0 ? 0 : 1}
                    />
                  )),
                )}
                {[12, 24, 36, 48].map((x) =>
                  [72, 84, 96].map((y) => (
                    <rect
                      key={`n-${x}-${y}`}
                      x={x}
                      y={y}
                      width="10"
                      height="10"
                      rx="1"
                      fill="#000"
                      opacity={(x + y) % 7 === 0 ? 0 : 1}
                    />
                  )),
                )}
              </svg>
              {!isVerifying && (
                <div className="ob-qr-wa-logo">
                  <WhatsAppIcon size={20} />
                </div>
              )}
              {isVerifying && (
                <div className="ob-qr-verifying-overlay">
                  <div className="ob-spinner ob-spinner-dark" />
                </div>
              )}
            </div>
            <span className="ob-qr-text">{isVerifying ? "Connecting..." : "Scan this QR code"}</span>
            <span className="ob-qr-subtext">
              {isVerifying ? "Verifying with WhatsApp..." : "Open WhatsApp → Settings → Linked devices"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
