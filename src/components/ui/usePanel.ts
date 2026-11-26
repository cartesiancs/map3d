import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

/**
 * The last non-null value. A panel that fades out keeps showing what it showed (the building, the edit)
 * instead of flashing its empty state while it disappears.
 */
export function useLastValue<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value); // adjusting state while rendering (React docs pattern)
  return value ?? last;
}

/** true while open and for `ms` after closing (so the content stays mounted during the fade-out) */
export function usePresence(open: boolean, ms = 250): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return open || mounted;
}

const CLOSE_DISTANCE = 90; // px
const CLOSE_VELOCITY = 0.6; // px / ms, a quick flick closes from a shorter drag

/**
 * Drag a panel down to close it (bottom sheet gesture; also works with a mouse). Touch and pen can drag from
 * anywhere in the element the handlers are spread on; a mouse only from an element marked `data-drag-handle`,
 * so text stays selectable. A drag cancels the click that would follow it.
 */
export function useSwipeDown<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const drag = useRef<{ id: number; y0: number; dy: number; lastY: number; lastT: number; v: number } | null>(null);
  const dragged = useRef(false);

  const move = (dy: number, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? "" : "none";
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
  };

  const end = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    // the click that may follow this pointerup is swallowed if it was a drag; a touch drag fires none
    window.setTimeout(() => (dragged.current = false), 0);
    if (d.dy > CLOSE_DISTANCE || (d.v > CLOSE_VELOCITY && d.dy > 20)) {
      move(d.dy + 80, true); // keep going down while it fades out
      onClose();
      window.setTimeout(() => ref.current && (ref.current.style.transform = ""), 260);
    } else {
      move(0, true); // back up
    }
  };

  const handlers = {
    onPointerDown: (e: ReactPointerEvent) => {
      dragged.current = false;
      if (e.button !== 0) return;
      if (e.pointerType === "mouse" && !(e.target as HTMLElement).closest("[data-drag-handle]")) return;
      drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      d.dy = Math.max(0, e.clientY - d.y0);
      const dt = e.timeStamp - d.lastT;
      if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
      d.lastY = e.clientY;
      d.lastT = e.timeStamp;
      if (d.dy > 4) dragged.current = true;
      move(d.dy, false);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (e: React.MouseEvent) => {
      if (!dragged.current) return;
      dragged.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
  return { ref, handlers };
}
