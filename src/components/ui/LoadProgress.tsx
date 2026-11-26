import { css } from "@emotion/react";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useAreaStore } from "@/state/areaStore";
import { UI, iconSize } from "./styles";

/** small, in the corner on the credits line (about one line of the credits tall) */
const SIZE = 18;
const STROKE = 2;
/** ring radius: 1.5 px of the disc around it */
const R = SIZE / 2 - 1.5 - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;
/** a load that finishes faster than this never shows the ring (no flash on cached tiles) */
const SHOW_AFTER_MS = 250;
/** at 100 %, the full ring stays this long before it fades */
const HIDE_AFTER_MS = 600;

/**
 * Google Earth style loading ring (bottom left): the ring fills as what the view needs gets drawn (no number;
 * the percent is only given to screen readers). Shown only while something is missing; floor() so it is full
 * only once everything is on screen, where a check mark appears until the ring fades.
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
        flexShrink: 0,
        width: SIZE,
        height: SIZE,
        borderRadius: "50%",
        backgroundColor: UI.surface,
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
      {complete && (
        <span css={css({ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" })}>
          <Check css={[iconSize(9), css({ color: UI.accent })]} strokeWidth={4} />
        </span>
      )}
    </div>
  );
}
