import { useTheme } from "@sketch/ui";
import { useCallback, useEffect, useRef, useState } from "react";

interface QRCardProps {
  onConnected: (phone: string) => void;
  demo?: boolean;
  /** Admin's own number (typed earlier). Reserved for future server-side comparison; not used in the demo. */
  enteredNumber?: string;
  /** "qr" works when the user has a second device. "code" works on the same phone they're onboarding from
   *  (no camera scan required — they paste the pairing code into WhatsApp's "Link with phone number" flow). */
  initialMode?: "qr" | "code";
}

/** Stable demo pairing code in WhatsApp's XXXX-XXXX format. Production replaces with a server-issued code. */
const DEMO_PAIRING_CODE = "LM3K-9P2R";

/** WhatsApp icon SVG */
function WhatsAppIcon({ size = 16, color = "#25D366" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

/** Self-contained WhatsApp linking card. Two modes:
 *  - QR: shows a scannable code (default on desktop where the admin has a second device).
 *  - Code: shows an 8-char pairing code (default on mobile where camera-scan-from-same-device is impossible).
 *  Both modes share the scanning → verifying → connected state machine and the same-number warning. */
export function QRCard({ onConnected, demo = true, initialMode = "qr" }: QRCardProps) {
  const { resolvedTheme } = useTheme();
  const [mode, setMode] = useState<"qr" | "code">(initialMode);
  const [status, setStatus] = useState<"scanning" | "verifying" | "connected" | "expired" | "same-number">("scanning");
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  /** Demo: first click triggers the same-number warning, second click succeeds. */
  const [errorShown, setErrorShown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setElapsed((e) => e + 1);
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    if (demo) return;
    if (elapsed >= 60 && status === "scanning") {
      setStatus("expired");
      clearInterval(timerRef.current);
    }
  }, [elapsed, status, demo]);

  /** Demo only: clicking the QR simulates a scan. First click → same-number error, second → success.
   * The mock spare-phone number is intentionally different from the admin's typed number so the chat
   * shows two distinct numbers (admin's vs Sketch's). Production replaces this with the real paired number from the server. */
  const handleQrClick = useCallback(() => {
    if (!demo) return;
    if (status !== "scanning" && status !== "same-number") return;
    setStatus("verifying");
    setTimeout(() => {
      if (!errorShown) {
        setErrorShown(true);
        setStatus("same-number");
        return;
      }
      setStatus("connected");
      onConnected("+1 (555) 234-5678");
    }, 900);
  }, [demo, status, errorShown, onConnected]);

  const handleRefresh = useCallback(() => {
    setStatus("scanning");
    setElapsed(0);
  }, []);

  /** In demo mode, copying the code is the trigger that simulates the spare phone completing the link
   *  (production listens via webhook and advances passively). The lag between "Copied" feedback and the
   *  status flip mirrors the real round-trip: user copies → switches to WhatsApp → enters code → backend confirms. */
  const handleCopyCode = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(DEMO_PAIRING_CODE.replace("-", "")).catch(() => {
        /* clipboard blocked (insecure context / permissions) — code is still selectable on the card */
      });
    }
    setCopied(true);

    if (!demo) return;
    if (status !== "scanning" && status !== "same-number") return;

    setTimeout(() => {
      setStatus("verifying");
      setTimeout(() => {
        if (!errorShown) {
          setErrorShown(true);
          setStatus("same-number");
          setCopied(false);
          return;
        }
        setStatus("connected");
        onConnected("+1 (555) 234-5678");
      }, 1100);
    }, 900);
  }, [demo, status, errorShown, onConnected]);

  const handleSwitchMode = useCallback(() => {
    setMode((m) => (m === "qr" ? "code" : "qr"));
    if (status === "verifying") setStatus("scanning");
    setCopied(false);
  }, [status]);

  const isConnected = status === "connected";
  const isVerifying = status === "verifying";
  const isSameNumber = status === "same-number";

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-qr-card" data-connected={isConnected} data-state={isSameNumber ? "warning" : undefined}>
        {/* Header */}
        <div className="ob-qr-header" data-connected={isConnected} data-state={isSameNumber ? "warning" : undefined}>
          <WhatsAppIcon size={14} color={isConnected ? "#25D366" : resolvedTheme === "dark" ? "#feed01" : "#6b6200"} />
          {isConnected ? "DEVICE LINKED" : isVerifying ? "LINKING DEVICE" : "LINK DEVICE"}
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
            <span className="ob-qr-text">{mode === "qr" ? "QR code expired." : "Pairing code expired."}</span>
            <button type="button" className="ob-btn ob-btn-primary" onClick={handleRefresh}>
              Generate new code
            </button>
          </>
        ) : (
          <>
            {isSameNumber && (
              <div className="ob-qr-warning ob-qr-warning-inline">
                <div className="ob-qr-warning-icon" aria-hidden="true">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" strokeLinecap="round" />
                    <line x1="12" y1="16" x2="12.01" y2="16" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="ob-qr-warning-text">
                  <strong className="ob-qr-warning-title">That's your own number.</strong>{" "}
                  <span className="ob-qr-warning-body">Pick a different one.</span>
                </div>
              </div>
            )}
            {mode === "qr" ? (
              <>
                <button
                  type="button"
                  className="ob-qr-container"
                  data-verifying={isVerifying}
                  onClick={handleQrClick}
                  disabled={!demo || isVerifying}
                  aria-label="Simulate scan"
                >
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
                </button>
                <span className="ob-qr-subtext">
                  {isVerifying ? "Verifying…" : "Open WhatsApp › Settings › Linked devices"}
                </span>
              </>
            ) : (
              <>
                <div className="ob-code-display">
                  <span className="ob-code-value">{DEMO_PAIRING_CODE}</span>
                  <button
                    type="button"
                    className="ob-code-copy"
                    onClick={handleCopyCode}
                    aria-label={copied ? "Code copied" : "Copy pairing code"}
                    title={copied ? "Copied" : "Copy code"}
                    data-copied={copied}
                  >
                    {copied ? (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                </div>
                <ol className="ob-code-steps">
                  <li>Open WhatsApp on the spare phone</li>
                  <li>Settings &rsaquo; Linked Devices &rsaquo; Link with phone number</li>
                  <li>Enter this code</li>
                </ol>
                <output className="ob-code-status">
                  <span className="ob-code-status-dot" data-verifying={isVerifying} aria-hidden="true" />
                  <span className="ob-code-status-text">
                    {isVerifying ? "Linking…" : "We'll continue once your spare phone links"}
                  </span>
                </output>
              </>
            )}
            <button type="button" className="ob-qr-mode-toggle" onClick={handleSwitchMode}>
              {mode === "qr" ? "Can't scan? Use a code instead" : "On a second device? Show QR instead"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
