// Right-click menu of the 3D view, styled after the shadcn/ui Context Menu (Radix primitive + Emotion, no
// Tailwind). Space.tsx decides when a right click opens it (a short click, not a rotate drag) and what was hit;
// the menu is then opened at that point through a synthetic contextmenu event on an invisible trigger.

import { css } from "@emotion/react";
import { useEffect, useRef } from "react";
import * as Menu from "@radix-ui/react-context-menu";
import { Copy, Crosshair, ExternalLink, LogIn, Ruler } from "lucide-react";
import { MenuTarget, pendingFor, useContribStore } from "@/state/contribStore";
import { useAuthStore } from "@/state/authStore";
import { useViewStore } from "@/state/viewStore";
import { refOf } from "@/api/contributions";
import { tileManager } from "@/three/Space";
import { englishName } from "@/utils/english";
import { UI, iconSize } from "./styles";

const MENU = { bg: UI.menu, border: UI.menuBorder, highlight: UI.menuHover, muted: UI.muted };

const content = css({
  minWidth: 224,
  padding: 4,
  backgroundColor: MENU.bg,
  color: UI.text,
  border: `1px solid ${MENU.border}`,
  borderRadius: 8,
  boxShadow: `0 4px 6px -1px ${UI.shadowStrong}, 0 2px 4px -2px ${UI.shadowStrong}`,
  fontSize: 14,
  zIndex: 60,
  outline: "none",
  transformOrigin: "var(--radix-context-menu-content-transform-origin)",
  animation: "map3d-menu-in .1s ease-out",
  "@keyframes map3d-menu-in": { from: { opacity: 0, transform: "scale(.96)" }, to: { opacity: 1, transform: "none" } },
});

const item = css({
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 4,
  cursor: "default",
  userSelect: "none",
  outline: "none",
  lineHeight: "20px",
  "&[data-highlighted]": { backgroundColor: MENU.highlight },
  "&[data-disabled]": { opacity: 0.5, pointerEvents: "none" },
  svg: { color: MENU.muted },
});

const label = css({ padding: "6px 8px", fontSize: 14, fontWeight: 600, lineHeight: "20px" });
const sub = css({ display: "block", fontSize: 12, fontWeight: 400, color: MENU.muted, marginTop: 1 });
const separator = css({ height: 1, margin: "4px -4px", backgroundColor: MENU.border });
const badge = css({
  display: "inline-block",
  marginLeft: 6,
  padding: "1px 6px",
  borderRadius: 9,
  fontSize: 11,
  fontWeight: 600,
  backgroundColor: UI.pendingBg,
  color: UI.pendingFg,
  verticalAlign: "1px",
});
const shortcut = css({ marginLeft: "auto", paddingLeft: 16, fontSize: 12, letterSpacing: "0.1em", color: MENU.muted });

const coords = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

function copy(text: string) {
  const notify = useAuthStore.getState().notify;
  navigator.clipboard?.writeText(text).then(
    () => notify("Coordinates copied"),
    () => notify(text),
  );
}

function BuildingItems({ target }: { target: Extract<MenuTarget, { kind: "building" }> }) {
  const status = useAuthStore((s) => s.status);
  const signIn = useAuthStore((s) => s.signIn);
  const mine = useContribStore((s) => s.mine);
  const pending = pendingFor(mine, refOf(target.id));
  const name = englishName(target.tags);
  const signedIn = status === "signedIn";

  const setHeight = () => {
    const info = tileManager.describe(target.key, target.index);
    if (!info) return;
    useViewStore.getState().select({ key: target.key, index: target.index, id: target.id, tags: target.tags });
    useContribStore.getState().startHeightEdit({ ...target, height: info.height });
  };

  return (
    <>
      <Menu.Label css={label}>
        {name ?? "Building"}
        {pending && <span css={badge}>Pending review</span>}
        <span css={sub}>{target.id < 0 ? "Added on map3d" : `OSM way ${target.id}`}</span>
      </Menu.Label>
      <Menu.Separator css={separator} />
      <Menu.Item css={item} disabled={!signedIn} onSelect={setHeight}>
        <Ruler css={iconSize(16)} />
        {pending ? "Edit my proposal…" : "Set height…"}
        <span css={shortcut}>H</span>
      </Menu.Item>
      <Menu.Item css={item} onSelect={() => copy(coords(target.lat, target.lng))}>
        <Copy css={iconSize(16)} /> Copy coordinates
      </Menu.Item>
      {target.id > 0 && (
        <Menu.Item css={item} onSelect={() => window.open(`https://www.openstreetmap.org/way/${target.id}`, "_blank", "noopener,noreferrer")}>
          <ExternalLink css={iconSize(16)} /> View on OpenStreetMap
        </Menu.Item>
      )}
      {status === "signedOut" && (
        <>
          <Menu.Separator css={separator} />
          <Menu.Item css={item} onSelect={signIn}>
            <LogIn css={iconSize(16)} /> Sign in with GitHub to contribute
          </Menu.Item>
        </>
      )}
    </>
  );
}

function GroundItems({ target }: { target: Extract<MenuTarget, { kind: "ground" }> }) {
  return (
    <>
      <Menu.Label css={label}>
        Ground
        <span css={sub}>{coords(target.lat, target.lng)}</span>
      </Menu.Label>
      <Menu.Separator css={separator} />
      <Menu.Item css={item} onSelect={() => copy(coords(target.lat, target.lng))}>
        <Copy css={iconSize(16)} /> Copy coordinates
      </Menu.Item>
      <Menu.Item css={item} onSelect={() => useViewStore.getState().flyTo(target.x, target.z, target.distance)}>
        <Crosshair css={iconSize(16)} /> Center view here
      </Menu.Item>
    </>
  );
}

export function MapContextMenu() {
  const menu = useContribStore((s) => s.menu);
  const closeMenu = useContribStore((s) => s.closeMenu);
  const trigger = useRef<HTMLSpanElement>(null);

  // open (or move) the menu at the clicked point
  useEffect(() => {
    if (!menu || !trigger.current) return;
    trigger.current.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: menu.x, clientY: menu.y }));
  }, [menu?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // H: Set height on the right-clicked building while the menu is open (shadcn-style shortcut hint)
  useEffect(() => {
    if (menu?.target.kind !== "building") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "h" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (useAuthStore.getState().status !== "signedIn") return;
      const target = menu.target as Extract<MenuTarget, { kind: "building" }>;
      const info = tileManager.describe(target.key, target.index);
      if (!info) return;
      e.preventDefault();
      useViewStore.getState().select({ key: target.key, index: target.index, id: target.id, tags: target.tags });
      useContribStore.getState().startHeightEdit({ ...target, height: info.height });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  return (
    <Menu.Root onOpenChange={(open) => !open && closeMenu()}>
      <Menu.Trigger asChild>
        <span ref={trigger} aria-hidden css={css({ position: "fixed", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" })} />
      </Menu.Trigger>
      <Menu.Portal>
        {menu && (
          <Menu.Content css={content} collisionPadding={8} onCloseAutoFocus={(e) => e.preventDefault()}>
            {menu.target.kind === "building" ? <BuildingItems target={menu.target} /> : <GroundItems target={menu.target} />}
          </Menu.Content>
        )}
      </Menu.Portal>
    </Menu.Root>
  );
}
