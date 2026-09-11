import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import type { Rect } from "../types";

/** Which part of the region a drag is moving. */
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** How much of the screen the region covers before the user adjusts it. */
const DEFAULT_COVERAGE = 0.75;

/** Smallest region the user can shrink to, in CSS pixels. */
const MIN_SIZE = 80;

/** Space the toolbar needs below the region before it moves inside it. */
const TOOLBAR_ROOM = 60;

interface Point {
  x: number;
  y: number;
}

function clamp(region: Rect): Rect {
  const limitWidth = window.innerWidth;
  const limitHeight = window.innerHeight;

  const width = Math.min(Math.max(region.width, MIN_SIZE), limitWidth);
  const height = Math.min(Math.max(region.height, MIN_SIZE), limitHeight);
  return {
    x: Math.min(Math.max(0, region.x), limitWidth - width),
    y: Math.min(Math.max(0, region.y), limitHeight - height),
    width,
    height,
  };
}

/** Applies a drag of `dx`/`dy` on `handle` to the region it started from. */
function applyDrag(start: Rect, handle: Handle, dx: number, dy: number): Rect {
  if (handle === "move") {
    return clamp({ ...start, x: start.x + dx, y: start.y + dy });
  }

  let { x, y, width, height } = start;
  if (handle.includes("w")) {
    x = start.x + dx;
    width = start.width - dx;
  }
  if (handle.includes("e")) {
    width = start.width + dx;
  }
  if (handle.includes("n")) {
    y = start.y + dy;
    height = start.height - dy;
  }
  if (handle.includes("s")) {
    height = start.height + dy;
  }

  // Dragging an edge past its opposite side would otherwise invert the
  // region; pin it at the minimum instead.
  if (width < MIN_SIZE) {
    if (handle.includes("w")) x = start.x + start.width - MIN_SIZE;
    width = MIN_SIZE;
  }
  if (height < MIN_SIZE) {
    if (handle.includes("n")) y = start.y + start.height - MIN_SIZE;
    height = MIN_SIZE;
  }
  return clamp({ x, y, width, height });
}

/**
 * Rendered instead of the main app when this window's label is
 * "area-selector". The window itself covers the whole desktop, so the
 * region below is in CSS pixels of the screen and only needs the window's
 * own origin and the device pixel ratio to become a capture rectangle.
 */
export function AreaSelectorOverlay() {
  const [origin, setOrigin] = useState<Point | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  /** Where the toolbar has been nudged to, relative to where it sits by
   * default — it follows the region, but can be moved off it when it
   * covers something the user needs to see. */
  const [toolbarShift, setToolbarShift] = useState<Point>({ x: 0, y: 0 });
  const drag = useRef<
    | { kind: "region"; handle: Handle; from: Point; start: Rect }
    | { kind: "toolbar"; from: Point; start: Point }
    | null
  >(null);

  const submit = useCallback(
    (picked: Rect | null) => {
      if (!picked || !origin) {
        api.submitAreaSelection(null).catch(() => {});
        return;
      }
      // The region is in CSS pixels relative to this window; ffmpeg wants
      // physical pixels relative to the desktop.
      const ratio = window.devicePixelRatio || 1;
      api
        .submitAreaSelection({
          x: Math.round(origin.x + picked.x * ratio),
          y: Math.round(origin.y + picked.y * ratio),
          width: Math.round(picked.width * ratio),
          height: Math.round(picked.height * ratio),
        })
        .catch(() => {});
    },
    [origin],
  );

  // Start from a region covering most of the screen, centred, so there's
  // something to adjust rather than a blank screen to drag out from.
  useEffect(() => {
    const width = Math.round(window.innerWidth * DEFAULT_COVERAGE);
    const height = Math.round(window.innerHeight * DEFAULT_COVERAGE);
    setRegion({
      x: Math.round((window.innerWidth - width) / 2),
      y: Math.round((window.innerHeight - height) / 2),
      width,
      height,
    });

    getCurrentWindow()
      .outerPosition()
      .then((position) => setOrigin({ x: position.x, y: position.y }))
      .catch(() => {});
  }, []);

  // Dragging is tracked on the window so the pointer can leave the handle
  // it grabbed without the resize sticking.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const active = drag.current;
      if (!active) return;
      const dx = event.clientX - active.from.x;
      const dy = event.clientY - active.from.y;

      if (active.kind === "toolbar") {
        setToolbarShift({ x: active.start.x + dx, y: active.start.y + dy });
        return;
      }
      setRegion(applyDrag(active.start, active.handle, dx, dy));
    };
    const onUp = () => {
      drag.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Confirming starts the recording immediately, so Escape has to mean
      // "don't record anything" rather than "record everything".
      if (event.key === "Escape") api.cancelAreaSelection().catch(() => {});
      if (event.key === "Enter") submit(region);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [region, submit]);

  function startDrag(handle: Handle, event: React.MouseEvent) {
    if (!region) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      kind: "region",
      handle,
      from: { x: event.clientX, y: event.clientY },
      start: region,
    };
  }

  function startToolbarDrag(event: React.MouseEvent) {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button")) return;
    event.preventDefault();
    drag.current = {
      kind: "toolbar",
      from: { x: event.clientX, y: event.clientY },
      start: toolbarShift,
    };
  }

  if (!region) return null;

  const ratio = window.devicePixelRatio || 1;
  const toolbarBelow = region.y + region.height + TOOLBAR_ROOM <= window.innerHeight;

  return (
    <div className="area-selector">
      <div
        className="area-region"
        style={{
          left: region.x,
          top: region.y,
          width: region.width,
          height: region.height,
        }}
        onMouseDown={(event) => startDrag("move", event)}
      >
        {HANDLES.map((handle) => (
          <span
            key={handle}
            className={`area-handle area-handle-${handle}`}
            onMouseDown={(event) => startDrag(handle, event)}
          />
        ))}
      </div>

      <div
        className="area-toolbar"
        onMouseDown={startToolbarDrag}
        style={{
          left: region.x + region.width / 2 + toolbarShift.x,
          top:
            (toolbarBelow
              ? region.y + region.height + 12
              : region.y + region.height - TOOLBAR_ROOM + 4) + toolbarShift.y,
        }}
      >
        <span className="area-grip">⠿</span>
        <span className="area-size">
          {Math.round(region.width * ratio)} × {Math.round(region.height * ratio)}
        </span>
        {/* Until the window's own origin is known the region can't be
            turned into screen coordinates, and confirming would silently
            fall back to the entire screen. */}
        <button
          className="area-confirm"
          onClick={() => submit(region)}
          disabled={!origin}
        >
          Select area
        </button>
        <button className="area-cancel" onClick={() => submit(null)}>
          Entire screen
        </button>
        <button
          className="area-cancel"
          onClick={() => api.cancelAreaSelection().catch(() => {})}
        >
          Cancel
        </button>
      </div>

      <div className="area-hint">
        Drag the region or its handles to adjust &middot; Enter starts recording
        &middot; Esc cancels
      </div>
    </div>
  );
}
