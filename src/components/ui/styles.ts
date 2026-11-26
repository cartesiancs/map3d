import { css, keyframes } from "@emotion/react";

export const UI = {
  surface: "#ececef",
  surfaceHover: "#e2e2e6",
  text: "#3a3a3f",
  icon: "#5b5d63",
  placeholder: "#9d9da3",
  handle: "#b4b4ba",
  accent: "#3d83f7",
  accentHover: "#2f74e6",
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
  boxShadow: "0 8px 30px rgba(0, 0, 0, 0.06)",
});
