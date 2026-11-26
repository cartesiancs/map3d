import { css, keyframes } from "@emotion/react";

/** Colors are CSS variables (index.css): the light and dark themes switch them all at once. */
export const UI = {
  bg: "var(--m3-bg)",
  surface: "var(--m3-surface)",
  surfaceHover: "var(--m3-surface-hover)",
  text: "var(--m3-text)",
  icon: "var(--m3-icon)",
  placeholder: "var(--m3-placeholder)",
  handle: "var(--m3-handle)",
  accent: "var(--m3-accent)",
  accentHover: "var(--m3-accent-hover)",
  /** separators, track of segmented controls */
  line: "var(--m3-line)",
  /** secondary buttons */
  control: "var(--m3-control)",
  controlOff: "var(--m3-control-off)",
  /** selected segment */
  raised: "var(--m3-raised)",
  knob: "var(--m3-knob)",
  field: "var(--m3-field)",
  fieldBorder: "var(--m3-field-border)",
  card: "var(--m3-card)",
  menu: "var(--m3-menu)",
  menuBorder: "var(--m3-menu-border)",
  menuHover: "var(--m3-menu-hover)",
  muted: "var(--m3-muted)",
  shadow: "var(--m3-shadow)",
  shadowStrong: "var(--m3-shadow-strong)",
  scrim: "var(--m3-scrim)",
  floating: "var(--m3-floating)",
  halo: "var(--m3-halo)",
  danger: "var(--m3-danger)",
  warn: "var(--m3-warn)",
  pendingBg: "var(--m3-pending-bg)",
  pendingFg: "var(--m3-pending-fg)",
  barHeight: 34,
  top: 31,
  side: 26,
  sideLeft: 38,
};

export const mobile = "@media (max-width: 768px)";

export const iconSize = (px = 16) => css({ width: px, height: px, flexShrink: 0 });

export const spin = keyframes`
from { transform: rotate(0deg); }
to { transform: rotate(360deg); }
`;

export const pillButton = css({
  height: UI.barHeight,
  minWidth: UI.barHeight,
  border: "none",
  borderRadius: UI.barHeight / 2,
  backgroundColor: UI.surface,
  color: UI.icon,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: 0,
  cursor: "pointer",
  transition: "background-color .15s",
  ":hover": { backgroundColor: UI.surfaceHover },
  ":disabled": { cursor: "default", opacity: 0.6 },
});

export const primaryButton = css(pillButton, {
  backgroundColor: UI.accent,
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 600,
  padding: "0 18px 0 14px",
  ":hover": { backgroundColor: UI.accentHover },
});

export const panel = css({
  backgroundColor: UI.surface,
  color: UI.text,
  boxShadow: `0 8px 30px ${UI.shadow}`,
});
