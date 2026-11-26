import { css } from "@emotion/react";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useAreaStore } from "@/state/areaStore";
import { UI, iconSize } from "./styles";

/** the size of the round buttons, so it lines up with the settings button above it */
const SIZE = UI.barHeight;
const STROKE = 2.5;
/** ring radius: 2 px of the disc around it, which leaves a 25 px opening ("99%" measures 19 px at 10 px) */
const R = SIZE / 2 - 2 - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;
/** a load that finishes faster than this never shows the ring (no flash on cached tiles) */
const SHOW_AFTER_MS = 250;
/** at 100 %, the full ring stays this long before it fades */
const HIDE_AFTER_MS = 600;

/**
 * Google Earth style loading ring (bottom left): how much of what the view needs is drawn, in percent.
 * Shown only while something is missing; floor() so it reads 100 only once everything is on screen, where a
 * check mark replaces the number ("100%" is wider than the opening) until the ring fades.
 */
export function LoadProgress() {
  const { done, total } = useAreaStore((s) => s.progress);
  const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
  const complete = pct >= 100;
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShown(!complete), complete ? HIDE_AFTER_MS : SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [complete]);

  return (
    <div
      role="progressbar"
      aria-label="Loading map"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-hidden={!shown}
      css={css({
        position: "relative",
        width: SIZE,
        height: SIZE,
        borderRadius: "50%",
        backgroundColor: UI.surface,
        color: UI.text,
        opacity: shown ? 1 : 0,
        transform: shown ? "scale(1)" : "scale(0.85)",
        transition: "opacity .2s, transform .2s",
      })}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} css={css({ position: "absolute", inset: 0, transform: "rotate(-90deg)" })}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={UI.line} strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke={UI.accent}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
          css={css({ transition: "stroke-dashoffset .3s ease-out" })}
        />
      </svg>
      <span
        css={css({
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: -0.2,
          fontVariantNumeric: "tabular-nums",
        })}
      >
        {complete ? (
          <Check css={[iconSize(13), css({ color: UI.accent })]} strokeWidth={3} />
        ) : (
          <>
            {pct}
            <span css={css({ fontSize: 7, fontWeight: 600, marginLeft: 0.5 })}>%</span>
          </>
        )}
      </span>
    </div>
  );
}
