import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api";
import type { Rect } from "../types";

interface Point {
  x: number;
  y: number;
}

/** Rendered instead of the main app when this window's label is "area-selector". */
export function AreaSelectorOverlay() {
  const [origin, setOrigin] = useState<Point | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    getCurrentWindow()
      .outerPosition()
      .then((pos) => setOrigin({ x: pos.x, y: pos.y }));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelled.current = true;
        api.submitAreaSelection(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selection = start && current ? toRect(start, current) : null;

  function toRect(a: Point, b: Point) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    setStart({ x: e.clientX, y: e.clientY });
    setCurrent({ x: e.clientX, y: e.clientY });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (start) setCurrent({ x: e.clientX, y: e.clientY });
  }

  async function handleMouseUp() {
    if (!selection || !origin) return;
    if (selection.width < 10 || selection.height < 10) {
      setStart(null);
      setCurrent(null);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const rect: Rect = {
      x: Math.round(origin.x + selection.x * dpr),
      y: Math.round(origin.y + selection.y * dpr),
      width: Math.round(selection.width * dpr),
      height: Math.round(selection.height * dpr),
    };
    await api.submitAreaSelection(rect);
  }

  return (
    <div
      className="area-selector"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div className="area-selector-hint">
        Drag to select a recording area &middot; Esc to cancel
      </div>
      {selection && (
        <div
          className="area-selector-box"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        >
          <span className="area-selector-size">
            {selection.width} &times; {selection.height}
          </span>
        </div>
      )}
    </div>
  );
}
