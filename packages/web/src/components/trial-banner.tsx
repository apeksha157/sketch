/**
 * TrialBanner — persistent promotional banner shown during a 15-day free trial.
 *
 * Two states:
 *   A (days 1–10): Celebration — gift box with confetti, dismissible per session
 *   B (days 11–15): Urgency — calendar/hourglass, non-dismissible, CTA to /plans
 *
 * Ticker (compact bar) shows on all dashboard pages except /plans.
 * Full banner shows on /plans.
 *
 * Preview — append ?trial=<day> to any page:
 *   ?trial=1   → day 1 (celebration)
 *   ?trial=12  → day 12 (urgency)
 */
import type { TrialBannerState } from "@/lib/use-trial-banner";
import { useTrialBanner } from "@/lib/use-trial-banner";
import { GiftIcon, HourglassIcon } from "@phosphor-icons/react";
import { useTheme } from "@sketch/ui/hooks/use-theme";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// Sketch icon — uses the actual logo from /logos/
// ---------------------------------------------------------------------------

function SketchIcon({ size = 28, isDark = true }: { size?: number; isDark?: boolean }) {
  return (
    <img
      src={isDark ? "/logos/sketch-icon-darkmode.png" : "/logos/sketch-icon-lightmode.png"}
      alt=""
      width={size}
      height={size}
    />
  );
}

// ---------------------------------------------------------------------------
// Confetti / sparkle particles (decorative, State A)
// ---------------------------------------------------------------------------

function ConfettiField({ isDark, popped }: { isDark: boolean; popped: boolean }) {
  const colors = isDark
    ? ["#FEED01", "#D4C800", "#FFF566", "#FEED01", "#E8D800"]
    : ["#292524", "#78716C", "#57534E", "#44403C", "#A8A29E"];

  // Idle particles — fall from top to bottom across the full banner width
  const idle = [
    { x: 5, w: 5, h: 3, rot: 30, c: 0, o: 0.28, d: 0, dur: 4.5, fall: 140 },
    { x: 12, w: 4, h: 6, rot: -45, c: 2, o: 0.22, d: 1.2, dur: 5.0, fall: 130 },
    { x: 18, w: 6, h: 3, rot: 55, c: 4, o: 0.2, d: 2.8, dur: 4.8, fall: 150 },
    { x: 25, w: 5, h: 5, rot: -20, c: 1, o: 0.26, d: 0.5, dur: 5.5, fall: 135 },
    { x: 32, w: 7, h: 3, rot: 40, c: 0, o: 0.3, d: 3.5, dur: 4.2, fall: 145 },
    { x: 38, w: 3, h: 6, rot: -60, c: 3, o: 0.2, d: 1.8, dur: 5.2, fall: 125 },
    { x: 45, w: 6, h: 3, rot: 25, c: 2, o: 0.25, d: 0.8, dur: 4.6, fall: 140 },
    { x: 52, w: 5, h: 7, rot: -35, c: 0, o: 0.24, d: 2.2, dur: 5.0, fall: 150 },
    { x: 58, w: 4, h: 4, rot: 50, c: 4, o: 0.22, d: 4.0, dur: 4.4, fall: 130 },
    { x: 64, w: 6, h: 3, rot: -15, c: 1, o: 0.28, d: 0.3, dur: 5.3, fall: 145 },
    { x: 70, w: 5, h: 5, rot: 65, c: 0, o: 0.3, d: 1.5, dur: 4.8, fall: 135 },
    { x: 76, w: 7, h: 3, rot: -50, c: 3, o: 0.24, d: 3.0, dur: 5.1, fall: 140 },
    { x: 82, w: 4, h: 6, rot: 35, c: 2, o: 0.26, d: 0.7, dur: 4.3, fall: 150 },
    { x: 88, w: 6, h: 3, rot: -30, c: 0, o: 0.22, d: 2.5, dur: 5.4, fall: 125 },
    { x: 93, w: 5, h: 4, rot: 70, c: 1, o: 0.2, d: 1.0, dur: 4.7, fall: 145 },
    { x: 97, w: 3, h: 5, rot: -40, c: 4, o: 0.24, d: 3.8, dur: 5.0, fall: 135 },
  ];

  // Pop particles — rain from top to bottom on hover, spread across full width
  const pops = [
    { x: 4, rot: 30, c: 0, d: 0, s: 1.2, fall: 150 },
    { x: 10, rot: -45, c: 1, d: 0.08, s: 1.0, fall: 140 },
    { x: 16, rot: 60, c: 2, d: 0.15, s: 1.3, fall: 155 },
    { x: 22, rot: -20, c: 0, d: 0.03, s: 1.1, fall: 135 },
    { x: 28, rot: 50, c: 3, d: 0.12, s: 0.9, fall: 145 },
    { x: 34, rot: -35, c: 4, d: 0.06, s: 1.2, fall: 150 },
    { x: 40, rot: 25, c: 1, d: 0.18, s: 1.0, fall: 130 },
    { x: 46, rot: -55, c: 0, d: 0.02, s: 1.3, fall: 155 },
    { x: 52, rot: 40, c: 2, d: 0.1, s: 1.1, fall: 140 },
    { x: 58, rot: -30, c: 3, d: 0.2, s: 0.8, fall: 150 },
    { x: 64, rot: 70, c: 0, d: 0.05, s: 1.2, fall: 145 },
    { x: 70, rot: -15, c: 4, d: 0.14, s: 1.0, fall: 135 },
    { x: 76, rot: 45, c: 1, d: 0.07, s: 1.3, fall: 155 },
    { x: 82, rot: -60, c: 2, d: 0.16, s: 1.1, fall: 140 },
    { x: 88, rot: 35, c: 0, d: 0.04, s: 0.9, fall: 150 },
    { x: 94, rot: -40, c: 3, d: 0.11, s: 1.2, fall: 145 },
  ];

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Idle confetti — falls top to bottom across full width */}
      {idle.map((p) => (
        <div
          key={`i-${p.x}-${p.d}`}
          className="absolute"
          style={{
            left: `${p.x}%`,
            top: "-5%",
            width: p.w,
            height: p.h,
            backgroundColor: colors[p.c],
            opacity: popped ? 0 : p.o,
            borderRadius: p.w === p.h ? "50%" : 1,
            ["--r" as string]: `${p.rot}deg`,
            ["--o" as string]: `${p.o}`,
            ["--fall" as string]: `${p.fall}px`,
            animation: `trialConfettiDrift ${p.dur}s linear ${p.d}s infinite`,
            transition: "opacity 0.3s ease",
          }}
        />
      ))}
      {/* Pop confetti — rains top to bottom on hover */}
      {popped &&
        pops.map((p, i) => (
          <div
            key={`p-${p.x}-${i}`}
            className="absolute"
            style={{
              left: `${p.x}%`,
              top: "-5%",
              width: 6 * p.s,
              height: (i % 3 === 0 ? 3 : 6) * p.s,
              backgroundColor: colors[p.c],
              borderRadius: i % 2 === 0 ? "50%" : 1,
              ["--r" as string]: `${p.rot}deg`,
              ["--o" as string]: "0.5",
              ["--fall" as string]: `${p.fall}px`,
              animation: `trialConfettiDrift 1.2s linear ${p.d}s forwards`,
            }}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gift box (State A) — larger, more detailed, with 3D shading
// ---------------------------------------------------------------------------

function GiftBoxGraphic({ isDark, hovered }: { isDark: boolean; hovered: boolean; setHovered: (v: boolean) => void }) {
  // Stone palette grays from theme
  const box1 = isDark ? "#57534E" : "#262524";
  const box2 = isDark ? "#44403C" : "#1C1B1A";
  const box3 = isDark ? "#78716C" : "#302E2C";
  const boxS = isDark ? "#78716C" : "#3A3836";
  const rb = isDark ? "#FEED01" : "#FFFFFF";
  const rbL = isDark ? "#FFF566" : "#FFFFFF";
  const rbD = isDark ? "#C9BE00" : "#C8C8C8";
  const rbDD = isDark ? "#9A9200" : "#A0A0A0";

  return (
    <div className="relative flex items-center justify-center" style={{ width: 130, height: 120 }}>
      <div
        className="relative"
        style={{
          width: 100,
          height: 104,
          animation: hovered ? "none" : "trialBob 3.2s ease-in-out infinite",
        }}
      >
        {/* ── Box body ── */}
        <div
          className="absolute inset-0"
          style={{
            opacity: hovered ? 0 : 1,
            transform: hovered ? "scale(0.88) translateY(8px)" : "scale(1)",
            transition: hovered
              ? "opacity 0.3s ease 0.3s, transform 0.4s ease 0.25s"
              : "opacity 0.3s ease 0.05s, transform 0.3s ease",
          }}
        >
          <svg width="100" height="104" viewBox="0 0 88 92" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="gbf" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={box1} />
                <stop offset="100%" stopColor={box2} />
              </linearGradient>
              <linearGradient id="grb" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={rbD} />
                <stop offset="20%" stopColor={rbL} />
                <stop offset="50%" stopColor={rb} />
                <stop offset="80%" stopColor={rbL} />
                <stop offset="100%" stopColor={rbD} />
              </linearGradient>
              <clipPath id="ribbonClipBody">
                <rect x="34" y="37" width="12" height="50" />
              </clipPath>
              <clipPath id="boxClip">
                <rect x="9" y="34" width="72" height="58" rx="5" />
              </clipPath>
            </defs>
            {/* Shadow */}
            <rect x="12" y="40" width="62" height="50" rx="5" fill="black" opacity="0.18" />
            {/* Body */}
            <rect x="9" y="37" width="62" height="50" rx="5" fill="url(#gbf)" />
            <rect x="9" y="37" width="62" height="50" rx="5" stroke={boxS} strokeWidth="0.5" fill="none" />
            {/* Surface texture — subtle horizontal lines */}
            {[0, 1, 2, 3].map((i) => (
              <line
                key={i}
                x1="11"
                y1={47 + i * 12}
                x2="69"
                y2={47 + i * 12}
                stroke={isDark ? "black" : "white"}
                strokeWidth="0.3"
                opacity="0.04"
              />
            ))}
            {/* Top edge highlight */}
            <rect x="12" y="38" width="56" height="2.5" rx="1.25" fill="white" opacity={isDark ? "0.06" : "0.1"} />
            {/* Left edge light */}
            <rect x="10" y="41" width="1.5" height="42" rx="0.75" fill="white" opacity="0.04" />
            {/* Vertical ribbon */}
            <rect x="34" y="37" width="12" height="50" fill="url(#grb)" />
            {/* Ribbon center highlight */}
            <rect x="38.5" y="37" width="3" height="50" fill="white" opacity="0.1" />
            {/* Ribbon edge stitching */}
            <line
              x1="34.5"
              y1="37"
              x2="34.5"
              y2="87"
              stroke={rbDD}
              strokeWidth="0.4"
              opacity="0.25"
              strokeDasharray="2 2"
            />
            <line
              x1="45.5"
              y1="37"
              x2="45.5"
              y2="87"
              stroke={rbDD}
              strokeWidth="0.4"
              opacity="0.25"
              strokeDasharray="2 2"
            />
            {/* Ribbon shimmer */}
            <g clipPath="url(#ribbonClipBody)">
              <rect
                x="34"
                y="37"
                width="12"
                height="50"
                fill="white"
                opacity="0.18"
                style={{ animation: "trialShimmer 3s ease-in-out infinite", transformOrigin: "40px 62px" }}
              />
            </g>
            {/* Sweeping shine — clipped to box */}
            <g clipPath="url(#boxClip)">
              <rect
                x="-20"
                y="30"
                width="16"
                height="70"
                fill="white"
                opacity="0.12"
                rx="8"
                style={{
                  animation: "trialBoxShine 4s ease-in-out 1s infinite",
                  transform: "rotate(-20deg)",
                }}
              />
            </g>
          </svg>
        </div>

        {/* ── Lid ── tilts back on hover */}
        <div
          className="absolute inset-0"
          style={{
            transformOrigin: "44px 33px",
            transform: hovered
              ? "perspective(300px) rotateX(-80deg) translateY(-6px)"
              : "perspective(300px) rotateX(0deg)",
            opacity: hovered ? 0 : 1,
            transition: hovered
              ? "transform 0.5s cubic-bezier(.34,1.2,.64,1) 0.05s, opacity 0.2s ease 0.35s"
              : "transform 0.4s cubic-bezier(.4,0,.2,1), opacity 0.15s ease",
          }}
        >
          <svg width="100" height="104" viewBox="0 0 88 92" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="glf" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={box3} />
                <stop offset="100%" stopColor={box1} />
              </linearGradient>
              <clipPath id="ribbonClipLid">
                <rect x="34" y="34" width="12" height="14" />
              </clipPath>
            </defs>
            {/* Shadow */}
            <rect x="8" y="37" width="72" height="14" rx="4" fill="black" opacity="0.1" />
            {/* Lid */}
            <rect x="5" y="34" width="72" height="14" rx="4" fill="url(#glf)" />
            <rect x="5" y="34" width="72" height="14" rx="4" stroke={boxS} strokeWidth="0.5" fill="none" />
            {/* Lid highlight */}
            <rect x="8" y="35" width="66" height="2" rx="1" fill="white" opacity={isDark ? "0.08" : "0.12"} />
            {/* Ribbon on lid */}
            <rect x="34" y="34" width="12" height="14" fill="url(#grb)" />
            <rect x="38.5" y="34" width="3" height="14" fill="white" opacity="0.1" />
            {/* Lid ribbon shimmer */}
            <g clipPath="url(#ribbonClipLid)">
              <rect
                x="34"
                y="34"
                width="12"
                height="14"
                fill="white"
                opacity="0.18"
                style={{ animation: "trialShimmer 3s ease-in-out infinite", transformOrigin: "40px 41px" }}
              />
            </g>
          </svg>
        </div>

        {/* ── Bow ── floats up first */}
        <div
          className="absolute inset-0"
          style={{
            opacity: hovered ? 0 : 1,
            transform: hovered ? "translateY(-14px) scale(0.5)" : "translateY(0) scale(1)",
            transition: hovered
              ? "opacity 0.2s ease, transform 0.25s cubic-bezier(.4,0,.2,1)"
              : "opacity 0.2s ease 0.2s, transform 0.25s ease 0.15s",
          }}
        >
          <svg width="100" height="104" viewBox="0 0 88 92" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="gblL" x1="0.8" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={rbL} />
                <stop offset="100%" stopColor={rb} />
              </linearGradient>
              <linearGradient id="gblR" x1="0.2" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={rbL} />
                <stop offset="100%" stopColor={rbD} />
              </linearGradient>
            </defs>
            {/* Left loop — big, round, ribbon-like */}
            <path d="M36 34 C30 28 18 14 12 18 C6 22 10 30 22 34 C28 35.5 33 35 36 34Z" fill="url(#gblL)" />
            {/* Left loop inner sheen */}
            <path d="M34 34 C30 30 24 22 20 24 C16 26 20 30 28 33 C31 34 33 34 34 34Z" fill={rbL} opacity="0.2" />
            {/* Left loop outline */}
            <path
              d="M36 34 C30 28 18 14 12 18 C6 22 10 30 22 34"
              stroke={rbDD}
              strokeWidth="0.4"
              fill="none"
              opacity="0.2"
            />

            {/* Right loop */}
            <path d="M46 34 C52 28 64 14 70 18 C76 22 72 30 60 34 C54 35.5 49 35 46 34Z" fill="url(#gblR)" />
            {/* Right loop inner shadow */}
            <path d="M48 34 C52 30 58 22 62 24 C66 26 62 30 54 33 C51 34 49 34 48 34Z" fill="black" opacity="0.05" />
            {/* Right loop outline */}
            <path
              d="M46 34 C52 28 64 14 70 18 C76 22 72 30 60 34"
              stroke={rbDD}
              strokeWidth="0.4"
              fill="none"
              opacity="0.2"
            />

            {/* Left tail — drapes down */}
            <path d="M35 36 C28 39 18 44 14 40 C12 38 16 36 24 35 C29 34.5 33 35 35 36Z" fill={rb} opacity="0.7" />
            <path d="M14 40 L10 43 L13 38Z" fill={rbD} opacity="0.5" />

            {/* Right tail */}
            <path d="M47 36 C54 39 64 44 68 40 C70 38 66 36 58 35 C53 34.5 49 35 47 36Z" fill={rb} opacity="0.7" />
            <path d="M68 40 L72 43 L69 38Z" fill={rbD} opacity="0.5" />

            {/* Center knot — gathered fabric with folds */}
            <path d="M35 32 C37 28 39 27 41 27 C43 27 45 28 47 32 C47 36 45 38 41 38 C37 38 35 36 35 32Z" fill={rbL} />
            <path
              d="M35 32 C37 28 39 27 41 27 C43 27 45 28 47 32 C47 36 45 38 41 38 C37 38 35 36 35 32Z"
              stroke={rbDD}
              strokeWidth="0.3"
              fill="none"
              opacity="0.25"
            />
            {/* Knot left fold */}
            <path d="M37 30 C38 28.5 39.5 27.5 41 27.5" stroke="white" strokeWidth="0.6" fill="none" opacity="0.15" />
            {/* Knot right fold */}
            <path d="M45 30 C44 28.5 42.5 27.5 41 27.5" stroke={rbDD} strokeWidth="0.5" fill="none" opacity="0.12" />
            {/* Knot center crease */}
            <line x1="41" y1="28" x2="41" y2="37" stroke={rbDD} strokeWidth="0.4" opacity="0.15" />
            {/* Knot highlight dot */}
            <ellipse cx="39.5" cy="30" rx="1.5" ry="1" fill="white" opacity="0.12" />
          </svg>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar grid (State B idle)
// ---------------------------------------------------------------------------

function CalendarGraphic({ daysElapsed, isDark }: { daysElapsed: number; isDark: boolean }) {
  const cell = 16;
  const gap = 3;
  const cols = 5;
  const pad = 9;
  const headerH = 24;
  const gridW = cols * (cell + gap) - gap;
  const w = gridW + pad * 2;
  const h = headerH + pad + 3 * (cell + gap) - gap + pad;

  // Stone palette grays from theme
  const box1 = isDark ? "#57534E" : "#44403C";
  const box2 = isDark ? "#44403C" : "#292524";
  const boxS = isDark ? "#78716C" : "#57534E";
  const accent = isDark ? "#FEED01" : "#1C1917";
  const accentDim = isDark ? "#C9BE00" : "#44403C";

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="calCard" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={box1} />
          <stop offset="100%" stopColor={box2} />
        </linearGradient>
        <linearGradient id="calHeader" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={isDark ? "#78716C" : "#1C1917"} />
          <stop offset="100%" stopColor={isDark ? "#57534E" : "#292524"} />
        </linearGradient>
      </defs>
      {/* Shadow */}
      <rect x="3" y="4" width={w - 1} height={h - 1} rx="6" fill="black" opacity="0.2" />
      {/* Outer card */}
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="6" fill="url(#calCard)" />
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="6" stroke={boxS} strokeWidth="0.5" fill="none" />
      {/* Top edge highlight */}
      <rect x="3" y="1.5" width={w - 7} height="2" rx="1" fill="white" opacity={isDark ? "0.06" : "0.1"} />
      {/* Left edge light */}
      <rect x="1" y="4" width="1.5" height={h - 8} rx="0.75" fill="white" opacity="0.04" />
      {/* Surface texture */}
      {[0, 1, 2].map((i) => (
        <line
          key={i}
          x1="2"
          y1={headerH + 10 + i * 16}
          x2={w - 2}
          y2={headerH + 10 + i * 16}
          stroke={isDark ? "black" : "white"}
          strokeWidth="0.3"
          opacity="0.04"
        />
      ))}
      {/* Header */}
      <rect x="0.5" y="0.5" width={w - 1} height={headerH} rx="6" fill="url(#calHeader)" />
      <rect x="0.5" y={headerH - 5} width={w - 1} height="6" fill={isDark ? "#57534E" : "#262524"} />
      {/* Header highlight */}
      <rect x="3" y="1.5" width={w - 7} height="1.5" rx="0.75" fill="white" opacity={isDark ? "0.08" : "0.12"} />
      {/* Header stitch lines */}
      <line
        x1="3"
        y1={headerH - 0.5}
        x2={w - 3}
        y2={headerH - 0.5}
        stroke={accentDim}
        strokeWidth="0.3"
        opacity="0.15"
        strokeDasharray="2 2"
      />
      <text
        x={w / 2}
        y={headerH / 2 + 1}
        textAnchor="middle"
        dominantBaseline="central"
        fill={isDark ? accent : "#F5F5F4"}
        fontSize="9"
        fontFamily="'IBM Plex Mono', monospace"
        fontWeight="700"
        letterSpacing="0.08em"
      >
        FREE TRIAL
      </text>
      {/* Day cells */}
      {Array.from({ length: 15 }, (_, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = pad + col * (cell + gap);
        const y = headerH + pad + row * (cell + gap);
        const day = i + 1;
        const today = day === daysElapsed;
        const past = day < daysElapsed;
        const future = day > daysElapsed;
        return (
          <g key={day}>
            {/* Cell shadow for future + today */}
            {!past && <rect x={x + 1} y={y + 1.5} width={cell} height={cell} rx="3" fill="black" opacity="0.1" />}
            <rect
              x={x}
              y={y}
              width={cell}
              height={cell}
              rx="3"
              fill={
                today
                  ? "#FEED01"
                  : past
                    ? isDark
                      ? "#292524"
                      : "#78716C"
                    : isDark
                      ? "rgba(254,237,1,0.12)"
                      : "#FEF9C3"
              }
              stroke={today ? "#FEED01" : past ? (isDark ? "#44403C" : "#A8A29E") : isDark ? accentDim : "#D4C800"}
              strokeWidth={today ? 1.5 : future ? 0.8 : 0.4}
              opacity={past ? 0.45 : 1}
            />
            {/* Cell highlight for future + today */}
            {!past && (
              <rect
                x={x + 1}
                y={y + 0.5}
                width={cell - 2}
                height="1.5"
                rx="0.75"
                fill="white"
                opacity={today ? "0.2" : "0.1"}
              />
            )}
            <text
              x={x + cell / 2}
              y={y + cell / 2 + 0.5}
              textAnchor="middle"
              dominantBaseline="central"
              fill={today ? "#1C1917" : past ? (isDark ? "#57534E" : "#D6D3D1") : isDark ? "#FEED01" : "#44403C"}
              fontSize="7"
              fontFamily="system-ui"
              fontWeight={today ? 700 : future ? 600 : 500}
            >
              {day}
            </text>
            {past && (
              <line
                x1={x + 3}
                y1={y + cell / 2}
                x2={x + cell - 3}
                y2={y + cell / 2}
                stroke={isDark ? "#57534E" : "#A8A29E"}
                strokeWidth="0.8"
                strokeLinecap="round"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hourglass (State B hover)
// ---------------------------------------------------------------------------

function HourglassGraphic({ daysLeft, isDark }: { daysLeft: number; isDark: boolean }) {
  const topFill = Math.max(0, Math.min(1, (daysLeft - 1) / 14));
  const bottomFill = 1 - topFill;

  // Stone palette grays from theme
  const box1 = isDark ? "#57534E" : "#262524";
  const box2 = isDark ? "#44403C" : "#1C1B1A";
  const box3 = isDark ? "#78716C" : "#302E2C";
  const boxS = isDark ? "#78716C" : "#3A3836";
  const accent = isDark ? "#FEED01" : "#FFFFFF";
  const accentDim = isDark ? "#C9BE00" : "#C8C8C8";
  const glassTint = isDark ? "#44403C" : "#1C1B1A";

  // Elegant hourglass geometry — cubic bezier curves for smooth S-shape
  const cx = 30;
  const W = 60; // viewBox width
  const glassL = 8;
  const glassR = 52;
  const waistL = 26;
  const waistR = 34;
  const waistY = 40;

  // Glass silhouette paths (cubic beziers for elegant curves)
  const glassLeftPath = `M${glassL} 14 C${glassL} 24, ${glassL + 2} 32, ${waistL} ${waistY} C${glassL + 2} 48, ${glassL} 56, ${glassL} 66`;
  const glassRightPath = `M${glassR} 14 C${glassR} 24, ${glassR - 2} 32, ${waistR} ${waistY} C${glassR - 2} 48, ${glassR} 56, ${glassR} 66`;
  const glassFullPath = `M${glassL} 14 C${glassL} 24, ${glassL + 2} 32, ${waistL} ${waistY} C${glassL + 2} 48, ${glassL} 56, ${glassL} 66 L${glassR} 66 C${glassR} 56, ${glassR - 2} 48, ${waistR} ${waistY} C${glassR - 2} 32, ${glassR} 24, ${glassR} 14 Z`;

  // Top sand
  const topSandY = 20 + (1 - topFill) * 18;
  const topFrac = (topSandY - 14) / (waistY - 14);
  const topSandHL = glassL + topFrac * (waistL - glassL);
  const topSandHR = glassR - topFrac * (glassR - waistR);

  // Bottom sand
  const botSandY = 66 - bottomFill * 18;
  const botFrac = (66 - botSandY) / (66 - waistY);
  const botSandHL = glassL + (1 - botFrac) * (waistL - glassL) * 0.3;
  const botSandHR = glassR - (1 - botFrac) * (glassR - waistR) * 0.3;

  return (
    <svg width={W} height="80" viewBox={`0 0 ${W} 80`} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="hgFrame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={box3} />
          <stop offset="100%" stopColor={box1} />
        </linearGradient>
        <linearGradient id="hgGlass" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={glassTint} stopOpacity="0.45" />
          <stop offset="35%" stopColor={glassTint} stopOpacity="0.18" />
          <stop offset="65%" stopColor={glassTint} stopOpacity="0.18" />
          <stop offset="100%" stopColor={glassTint} stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id="hgSand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} />
          <stop offset="100%" stopColor={accentDim} />
        </linearGradient>
        <radialGradient id="hgSandBot" cx="0.5" cy="0" r="1">
          <stop offset="0%" stopColor={accent} />
          <stop offset="80%" stopColor={accentDim} />
        </radialGradient>
        <clipPath id="hgTopClip">
          <path
            d={`M${glassL} 14 C${glassL} 24, ${glassL + 2} 32, ${waistL} ${waistY} L${waistR} ${waistY} C${glassR - 2} 32, ${glassR} 24, ${glassR} 14 Z`}
          />
        </clipPath>
        <clipPath id="hgBotClip">
          <path
            d={`M${waistL} ${waistY} C${glassL + 2} 48, ${glassL} 56, ${glassL} 66 L${glassR} 66 C${glassR} 56, ${glassR - 2} 48, ${waistR} ${waistY} Z`}
          />
        </clipPath>
      </defs>

      {/* Shadow */}
      <ellipse cx={cx} cy="77" rx="15" ry="2.5" fill="black" opacity="0.18" />

      {/* ── Top frame ── */}
      <rect x="6" y="2" width="48" height="12" rx="5" fill="url(#hgFrame)" />
      <rect x="6" y="2" width="48" height="12" rx="5" stroke={boxS} strokeWidth="0.5" fill="none" />
      <rect x="9" y="3" width="42" height="2" rx="1" fill="white" opacity={isDark ? "0.08" : "0.12"} />
      <line
        x1="9"
        y1="12"
        x2="51"
        y2="12"
        stroke={accentDim}
        strokeWidth="0.3"
        opacity="0.12"
        strokeDasharray="2.5 2"
      />
      {/* Decorative knobs */}
      <circle cx="10" cy="8" r="2.5" fill={box2} stroke={boxS} strokeWidth="0.4" />
      <circle cx="10" cy="7.5" r="0.8" fill="white" opacity="0.06" />
      <circle cx="50" cy="8" r="2.5" fill={box2} stroke={boxS} strokeWidth="0.4" />
      <circle cx="50" cy="7.5" r="0.8" fill="white" opacity="0.06" />

      {/* ── Bottom frame ── */}
      <rect x="6" y="66" width="48" height="12" rx="5" fill="url(#hgFrame)" />
      <rect x="6" y="66" width="48" height="12" rx="5" stroke={boxS} strokeWidth="0.5" fill="none" />
      <rect x="9" y="67" width="42" height="2" rx="1" fill="white" opacity={isDark ? "0.08" : "0.12"} />
      <line
        x1="9"
        y1="68"
        x2="51"
        y2="68"
        stroke={accentDim}
        strokeWidth="0.3"
        opacity="0.12"
        strokeDasharray="2.5 2"
      />
      <circle cx="10" cy="72" r="2.5" fill={box2} stroke={boxS} strokeWidth="0.4" />
      <circle cx="10" cy="71.5" r="0.8" fill="white" opacity="0.06" />
      <circle cx="50" cy="72" r="2.5" fill={box2} stroke={boxS} strokeWidth="0.4" />
      <circle cx="50" cy="71.5" r="0.8" fill="white" opacity="0.06" />

      {/* ── Glass body — elegant S-curves ── */}
      <path d={glassFullPath} fill="url(#hgGlass)" />
      {/* Glass outline — left */}
      <path d={glassLeftPath} stroke={boxS} strokeWidth="1.2" fill="none" opacity="0.7" />
      {/* Glass outline — right */}
      <path d={glassRightPath} stroke={boxS} strokeWidth="1.2" fill="none" opacity="0.7" />
      {/* Left reflection highlight */}
      <path
        d={`M${glassL + 4} 18 C${glassL + 4} 26, ${glassL + 5} 32, ${waistL + 2} 37`}
        stroke="white"
        strokeWidth="1.5"
        fill="none"
        opacity={isDark ? "0.1" : "0.18"}
        strokeLinecap="round"
      />
      {/* Subtle right reflection */}
      <path
        d={`M${glassR - 4} 18 C${glassR - 4} 26, ${glassR - 5} 32, ${waistR - 2} 37`}
        stroke="white"
        strokeWidth="0.5"
        fill="none"
        opacity={isDark ? "0.04" : "0.08"}
      />
      {/* Bottom left reflection */}
      <path
        d={`M${glassL + 4} 62 C${glassL + 4} 56, ${glassL + 5} 50, ${waistL + 2} 43`}
        stroke="white"
        strokeWidth="1"
        fill="none"
        opacity={isDark ? "0.06" : "0.1"}
        strokeLinecap="round"
      />

      {/* ── Top sand ── */}
      {topFill > 0.02 && (
        <g clipPath="url(#hgTopClip)">
          <rect
            x={topSandHL}
            y={topSandY}
            width={topSandHR - topSandHL}
            height={waistY - topSandY}
            fill="url(#hgSand)"
            opacity="0.9"
          />
          <line
            x1={topSandHL + 2}
            y1={topSandY + 0.5}
            x2={topSandHR - 2}
            y2={topSandY + 0.5}
            stroke="white"
            strokeWidth="0.8"
            opacity="0.25"
          />
          <path
            d={`M${topSandHL} ${topSandY} Q${cx} ${topSandY + 3} ${topSandHR} ${topSandY}`}
            stroke={accentDim}
            strokeWidth="0.4"
            fill="none"
            opacity="0.2"
          />
        </g>
      )}

      {/* ── Bottom sand — cone pile ── */}
      {bottomFill > 0.02 && (
        <g clipPath="url(#hgBotClip)">
          <rect
            x={botSandHL}
            y={botSandY + 3}
            width={botSandHR - botSandHL}
            height={66 - botSandY - 3}
            fill="url(#hgSandBot)"
            opacity="0.9"
          />
          <path
            d={`M${cx - 8} ${botSandY + 3} Q${cx} ${botSandY - 1} ${cx + 8} ${botSandY + 3}`}
            fill={accent}
            opacity="0.85"
          />
          <path
            d={`M${cx - 5} ${botSandY + 2} Q${cx} ${botSandY} ${cx + 5} ${botSandY + 2}`}
            stroke="white"
            strokeWidth="0.6"
            fill="none"
            opacity="0.2"
          />
        </g>
      )}

      {/* ── Sand stream ── */}
      <line x1={cx} y1="36" x2={cx} y2="46" stroke={accent} strokeWidth="1.2" strokeLinecap="round" opacity="0.7">
        <animate attributeName="opacity" values="0.5;0.8;0.5" dur="1s" repeatCount="indefinite" />
      </line>
      <line x1={cx} y1="37" x2={cx} y2="45" stroke={accent} strokeWidth="3" strokeLinecap="round" opacity="0.08">
        <animate attributeName="opacity" values="0.05;0.12;0.05" dur="1s" repeatCount="indefinite" />
      </line>
      {/* Falling grains */}
      <circle cx={cx} cy="46" r="1" fill={accent} opacity="0.8">
        <animate attributeName="cy" values="46;56" dur="0.6s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.8;0" dur="0.6s" repeatCount="indefinite" />
        <animate attributeName="r" values="1;0.4" dur="0.6s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx - 1} cy="44" r="0.7" fill={accent} opacity="0.6">
        <animate attributeName="cy" values="44;54" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.6;0" dur="0.7s" begin="0.2s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx + 1} cy="45" r="0.5" fill={accent} opacity="0.5">
        <animate attributeName="cy" values="45;52" dur="0.5s" begin="0.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0" dur="0.5s" begin="0.4s" repeatCount="indefinite" />
      </circle>
      {/* Splash particles */}
      <circle cx={cx - 3} cy={botSandY + 2} r="0.5" fill={accent} opacity="0.4">
        <animate attributeName="cx" values={`${cx - 1};${cx - 5}`} dur="0.8s" repeatCount="indefinite" />
        <animate attributeName="cy" values={`${botSandY + 2};${botSandY}`} dur="0.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.5;0" dur="0.8s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx + 3} cy={botSandY + 2} r="0.5" fill={accent} opacity="0.4">
        <animate attributeName="cx" values={`${cx + 1};${cx + 5}`} dur="0.8s" begin="0.3s" repeatCount="indefinite" />
        <animate
          attributeName="cy"
          values={`${botSandY + 2};${botSandY}`}
          dur="0.8s"
          begin="0.3s"
          repeatCount="indefinite"
        />
        <animate attributeName="opacity" values="0.5;0" dur="0.8s" begin="0.3s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// State B graphic — calendar ↔ hourglass on hover
// ---------------------------------------------------------------------------

function UrgencyGraphic({ daysElapsed, daysLeft, isDark }: { daysElapsed: number; daysLeft: number; isDark: boolean }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: 130, height: 120 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="absolute"
        style={{
          opacity: hovered ? 0 : 1,
          transform: hovered ? "scale(0.92) translateY(4px)" : "scale(1) translateY(0)",
          animation: hovered ? "none" : "trialBob 3.2s ease-in-out infinite",
          transition: "opacity 0.4s ease-out, transform 0.45s cubic-bezier(.4,0,.2,1)",
        }}
      >
        <CalendarGraphic daysElapsed={daysElapsed} isDark={isDark} />
      </div>
      <div
        className="absolute"
        style={{
          opacity: hovered ? 1 : 0,
          transform: hovered ? "scale(1) translateY(0)" : "scale(0.92) translateY(-4px)",
          animation: hovered ? "trialBob 3.2s ease-in-out infinite" : "none",
          transition: hovered
            ? "opacity 0.4s ease-out 0.1s, transform 0.5s cubic-bezier(.22,1,.36,1) 0.1s"
            : "opacity 0.3s ease-in, transform 0.35s ease-in",
        }}
      >
        <HourglassGraphic daysLeft={daysLeft} isDark={isDark} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrialBannerInner — both states
// ---------------------------------------------------------------------------

export function TrialBannerInner({
  state,
  daysElapsed,
  daysLeft,
  dismissed,
  onDismiss,
}: {
  state: TrialBannerState;
  daysElapsed: number;
  daysLeft: number;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const isDark = resolvedTheme === "dark";

  const [giftHovered, setGiftHovered] = useState(false);
  const [urgencyHovered, setUrgencyHovered] = useState(false);

  const handleViewPlans = useCallback(() => {
    navigate({ to: "/plans" });
  }, [navigate]);

  if (state === "none") return null;
  if (state === "celebration" && dismissed) return null;

  if (state === "celebration") {
    return (
      <div className="mx-auto max-w-4xl px-10 pt-4">
        <div
          className="relative overflow-hidden rounded-xl"
          style={{
            background: isDark
              ? "linear-gradient(135deg, #2A2000 0%, #1F1800 60%, #2A2000 100%)"
              : "linear-gradient(135deg, #FEED01 0%, #F5E400 40%, #EDD900 100%)",
            border: `1px solid ${isDark ? "rgba(254,237,1,0.12)" : "rgba(0,0,0,0.08)"}`,
            boxShadow: isDark
              ? "0 1px 3px rgba(0,0,0,0.3), inset 0 1px 0 rgba(254,237,1,0.05)"
              : "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.5)",
            transform: giftHovered ? "scale(1.01)" : "scale(1)",
            transition: "transform 0.3s cubic-bezier(.4,0,.2,1)",
          }}
          onMouseEnter={() => setGiftHovered(true)}
          onMouseLeave={() => setGiftHovered(false)}
        >
          {/* Decorative confetti */}
          <ConfettiField isDark={isDark} popped={giftHovered} />

          {/* Radial glow behind graphic */}
          <div
            className="pointer-events-none absolute"
            style={{
              left: 0,
              top: 0,
              width: "40%",
              height: "100%",
              background: isDark
                ? "radial-gradient(ellipse at 30% 50%, rgba(254,237,1,0.08) 0%, transparent 70%)"
                : "radial-gradient(ellipse at 30% 50%, rgba(255,255,255,0.4) 0%, transparent 60%)",
            }}
          />

          <div className="relative z-10 flex items-center px-8 py-4">
            {/* Graphic zone */}
            <div className="flex w-[130px] shrink-0 items-center justify-center">
              <GiftBoxGraphic isDark={isDark} hovered={giftHovered} setHovered={setGiftHovered} />
            </div>

            {/* Content */}
            <div className="flex flex-1 flex-col pl-3">
              <h2
                style={{
                  fontFamily: "'Gloria Hallelujah', cursive",
                  fontSize: 24,
                  fontWeight: 400,
                  color: isDark ? "#FEED01" : "#292524",
                  lineHeight: 1.2,
                }}
              >
                Your free trial has started
              </h2>
              <p
                className="mt-1.5 max-w-[380px] leading-snug"
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  color: isDark ? "rgba(254,237,1,0.5)" : "#57534E",
                  fontWeight: 500,
                  letterSpacing: "0.01em",
                }}
              >
                Full access to everything &middot; No credit card needed
              </p>
              {/* Progress bar */}
              <div className="mt-3 flex items-center gap-2.5">
                <div
                  className="overflow-hidden rounded-full"
                  style={{
                    height: 3,
                    width: "100%",
                    maxWidth: 300,
                    backgroundColor: isDark ? "rgba(254,237,1,0.08)" : "rgba(0,0,0,0.06)",
                  }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min((daysElapsed / 15) * 100, 100)}%`,
                      backgroundColor: isDark ? "#FEED01" : "#292524",
                      opacity: 0.6,
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: "'IBM Plex Mono', monospace",
                    color: isDark ? "rgba(254,237,1,0.5)" : "rgba(0,0,0,0.4)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {daysElapsed}/{15}
                </span>
              </div>
            </div>

            {/* Right column — pill + CTA stacked */}
            <div className="flex shrink-0 flex-col items-center justify-center gap-3 pl-5 pr-3">
              <span
                className="inline-flex items-center rounded-full px-3 py-1"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: "'IBM Plex Mono', monospace",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase" as const,
                  backgroundColor: isDark ? "rgba(254,237,1,0.16)" : "rgba(0,0,0,0.08)",
                  color: isDark ? "#FEED01" : "#292524",
                }}
              >
                15-day trial
              </span>
              <button
                type="button"
                onClick={handleViewPlans}
                className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.98]"
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  backgroundColor: isDark ? "#FEED01" : "#1C1917",
                  color: isDark ? "#1C1917" : "#FEF3C7",
                  whiteSpace: "nowrap",
                }}
              >
                View plans
                <span>&rarr;</span>
              </button>
            </div>
          </div>

          {/* Sketch logo — rises from gift box, vertically centered in banner */}
          <div
            className="pointer-events-none absolute left-5 top-0 bottom-0 z-20 flex w-[130px] items-center justify-center"
            style={{
              opacity: giftHovered ? 1 : 0,
              transform: giftHovered ? "scale(1)" : "scale(0.3) translateY(10px)",
              transition: giftHovered
                ? "transform 0.6s cubic-bezier(.22,1,.36,1) 0.3s, opacity 0.35s ease 0.25s"
                : "transform 0.3s ease, opacity 0.2s ease",
            }}
          >
            <SketchIcon size={isDark ? 96 : 72} isDark={isDark} />
          </div>

          {/* Dismiss */}
          <button
            type="button"
            onClick={onDismiss}
            className="absolute right-1.5 top-1.5 z-30 flex h-7 w-7 items-center justify-center rounded-lg transition-opacity hover:opacity-100"
            style={{ opacity: 0.6 }}
            title="Dismiss — reappears next session"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path
                d="M1 1L9 9M9 1L1 9"
                stroke={isDark ? "rgba(254,237,1,0.5)" : "#78716C"}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // ── State B: Urgency ──
  return (
    <div className="mx-auto max-w-4xl px-10 pt-4">
      <div
        className="relative overflow-hidden rounded-xl"
        style={{
          background: isDark
            ? "linear-gradient(135deg, #2A2000 0%, #1F1800 60%, #2A2000 100%)"
            : "linear-gradient(135deg, #FEED01 0%, #F5E400 40%, #EDD900 100%)",
          border: `1px solid ${isDark ? "rgba(254,237,1,0.12)" : "rgba(0,0,0,0.08)"}`,
          boxShadow: isDark
            ? "0 1px 3px rgba(0,0,0,0.3), inset 0 1px 0 rgba(254,237,1,0.05)"
            : "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.5)",
          transform: urgencyHovered ? "scale(1.01)" : "scale(1)",
          transition: "transform 0.3s cubic-bezier(.4,0,.2,1)",
        }}
        onMouseEnter={() => setUrgencyHovered(true)}
        onMouseLeave={() => setUrgencyHovered(false)}
      >
        {/* Radial glow behind graphic */}
        <div
          className="pointer-events-none absolute"
          style={{
            left: 0,
            top: 0,
            width: "40%",
            height: "100%",
            background: isDark
              ? "radial-gradient(ellipse at 30% 50%, rgba(254,237,1,0.08) 0%, transparent 70%)"
              : "radial-gradient(ellipse at 30% 50%, rgba(255,255,255,0.4) 0%, transparent 60%)",
          }}
        />

        <div className="relative z-10 flex items-center px-8 py-4">
          {/* Graphic zone */}
          <div className="flex w-[130px] shrink-0 items-center justify-center">
            <UrgencyGraphic daysElapsed={daysElapsed} daysLeft={daysLeft} isDark={isDark} />
          </div>

          {/* Content */}
          <div className="flex flex-1 flex-col pl-3">
            <h2
              style={{
                fontFamily: "'Gloria Hallelujah', cursive",
                fontSize: 24,
                fontWeight: 400,
                color: isDark ? "#FEED01" : "#292524",
                lineHeight: 1.2,
              }}
            >
              Your trial is ending soon
            </h2>
            <p
              className="mt-1.5 max-w-[380px] leading-snug"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 13,
                color: isDark ? "rgba(254,237,1,0.5)" : "#57534E",
                fontWeight: 500,
                letterSpacing: "0.01em",
              }}
            >
              Subscribe to keep your workspace, skills, and integrations
            </p>
            {/* Progress bar */}
            <div className="mt-3 flex items-center gap-2.5">
              <div
                className="overflow-hidden rounded-full"
                style={{
                  height: 3,
                  width: "100%",
                  maxWidth: 300,
                  backgroundColor: isDark ? "rgba(254,237,1,0.08)" : "rgba(0,0,0,0.06)",
                }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min((daysElapsed / 15) * 100, 100)}%`,
                    backgroundColor: isDark ? "#FEED01" : "#292524",
                    opacity: 0.6,
                    transition: "width 0.5s ease",
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: isDark ? "rgba(254,237,1,0.5)" : "rgba(0,0,0,0.4)",
                  whiteSpace: "nowrap",
                }}
              >
                {daysElapsed}/{15}
              </span>
            </div>
          </div>

          {/* Right column — pill + CTA stacked */}
          <div className="flex shrink-0 flex-col items-center justify-center gap-3 pl-5 pr-3">
            <span
              className="inline-flex items-center rounded-full px-3 py-1"
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: "'IBM Plex Mono', monospace",
                letterSpacing: "0.05em",
                textTransform: "uppercase" as const,
                backgroundColor: isDark ? "rgba(254,237,1,0.16)" : "rgba(0,0,0,0.08)",
                color: isDark ? "#FEED01" : "#292524",
              }}
            >
              {daysLeft} day{daysLeft !== 1 ? "s" : ""} left
            </span>
            <button
              type="button"
              onClick={handleViewPlans}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2 font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.98]"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                backgroundColor: isDark ? "#FEED01" : "#1C1917",
                color: isDark ? "#1C1917" : "#FEF3C7",
                whiteSpace: "nowrap",
              }}
            >
              View plans
              <span>&rarr;</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ticker banner — compact strip for non-plans pages
// ---------------------------------------------------------------------------

function TrialTickerBanner({
  state,
  daysElapsed,
  daysLeft,
  dismissed,
  onDismiss,
}: {
  state: TrialBannerState;
  daysElapsed: number;
  daysLeft: number;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const isDark = resolvedTheme === "dark";

  if (state === "none") return null;
  if (state === "celebration" && dismissed) return null;

  const isCelebration = state === "celebration";

  return (
    <div className="flex-1 min-w-0">
      <div
        className="relative flex items-center gap-4 rounded-lg px-4 py-2"
        style={{
          background: isCelebration
            ? isDark
              ? "linear-gradient(90deg, #2A2000 0%, #1F1800 50%, #2A2000 100%)"
              : "linear-gradient(90deg, #FEED01 0%, #F5E400 50%, #EDD900 100%)"
            : "linear-gradient(90deg, #1C1917 0%, #292524 50%, #1C1917 100%)",
          border: `1px solid ${
            isCelebration ? (isDark ? "rgba(254,237,1,0.12)" : "rgba(0,0,0,0.08)") : isDark ? "#44403C" : "#44403C"
          }`,
        }}
      >
        {/* Icon + status text */}
        <div className="flex items-center gap-2">
          {isCelebration ? (
            <GiftIcon size={16} weight="fill" color={isDark ? "#FEED01" : "#292524"} />
          ) : (
            <HourglassIcon size={16} weight="fill" color="#FEED01" />
          )}
          <span
            style={{
              fontFamily: "'Gloria Hallelujah', cursive",
              fontSize: 14,
              color: isCelebration ? (isDark ? "#FEED01" : "#292524") : "#FEED01",
            }}
          >
            {isCelebration ? "Free trial" : "Trial ending"}
          </span>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-2">
          <div
            className="overflow-hidden rounded-full"
            style={{
              height: 3,
              width: 100,
              backgroundColor: isCelebration
                ? isDark
                  ? "rgba(254,237,1,0.08)"
                  : "rgba(0,0,0,0.06)"
                : "rgba(254,237,1,0.15)",
            }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min((daysElapsed / 15) * 100, 100)}%`,
                backgroundColor: isCelebration ? (isDark ? "#FEED01" : "#292524") : "#FEED01",
                opacity: isCelebration ? 0.6 : 0.8,
              }}
            />
          </div>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace",
              color: isCelebration ? (isDark ? "rgba(254,237,1,0.5)" : "rgba(0,0,0,0.4)") : "rgba(254,237,1,0.5)",
              whiteSpace: "nowrap",
            }}
          >
            {daysElapsed}/15
          </span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* CTA */}
        <button
          type="button"
          onClick={() => navigate({ to: "/plans" })}
          className="inline-flex items-center gap-1 rounded-md px-4 py-1.5 font-semibold transition-all hover:shadow-sm active:scale-[0.98]"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            backgroundColor: isCelebration ? (isDark ? "#FEED01" : "#1C1917") : "#FEED01",
            color: isCelebration && !isDark ? "#FFFFFF" : "#1C1917",
            whiteSpace: "nowrap",
          }}
        >
          {isCelebration ? "Explore plans" : "Upgrade now"} <span>&rarr;</span>
        </button>

        {/* Dismiss (celebration only) */}
        {isCelebration && (
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-5 w-5 items-center justify-center rounded transition-opacity hover:opacity-100"
            style={{ opacity: 0.5 }}
            title="Dismiss"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path
                d="M1 1L9 9M9 1L1 9"
                stroke={isDark ? "rgba(254,237,1,0.5)" : "#78716C"}
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview helper
// ---------------------------------------------------------------------------

function usePreviewOverride() {
  const raw = new URLSearchParams(window.location.search).get("trial");
  if (!raw) return null;
  // ?trial=none → force-hide the banner
  if (raw === "none") return { state: "none" as TrialBannerState, daysElapsed: 15, daysLeft: 0 };
  const daysElapsed = Number.parseInt(raw, 10);
  if (Number.isNaN(daysElapsed) || daysElapsed < 0 || daysElapsed > 15) return null;
  const daysLeft = Math.max(0, 15 - daysElapsed);
  const state: TrialBannerState = daysElapsed < 11 ? "celebration" : "urgency";
  return { state, daysElapsed, daysLeft };
}

// ---------------------------------------------------------------------------
// TrialTicker — compact strip for the sticky header bar (all pages)
// ---------------------------------------------------------------------------

export function TrialTicker() {
  const trial = useTrialBanner();
  const preview = usePreviewOverride();

  const state = preview?.state ?? trial.state;
  const daysElapsed = preview?.daysElapsed ?? trial.daysElapsed;
  const daysLeft = preview?.daysLeft ?? trial.daysLeft;

  return (
    <TrialTickerBanner
      state={state}
      daysElapsed={daysElapsed}
      daysLeft={daysLeft}
      dismissed={trial.dismissed}
      onDismiss={trial.dismiss}
    />
  );
}

// ---------------------------------------------------------------------------
// TrialBanner — full banner, intended for /plans page content area
// ---------------------------------------------------------------------------

export function TrialBanner() {
  const trial = useTrialBanner();
  const preview = usePreviewOverride();

  const state = preview?.state ?? trial.state;
  const daysElapsed = preview?.daysElapsed ?? trial.daysElapsed;
  const daysLeft = preview?.daysLeft ?? trial.daysLeft;

  return (
    <TrialBannerInner
      state={state}
      daysElapsed={daysElapsed}
      daysLeft={daysLeft}
      dismissed={trial.dismissed}
      onDismiss={trial.dismiss}
    />
  );
}
