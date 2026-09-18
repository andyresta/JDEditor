import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** Where the pointer is, in physical pixels from this window's corner. */
interface HaloAt {
  x: number;
  y: number;
  down: boolean;
}

/** How wide the ring is, in CSS pixels, and how far a click's pulse
 * spreads before it fades. Large enough to find on a busy screen, small
 * enough not to cover what is being pointed at. */
const RING = 46;
const PULSE = 3.1;
const PULSE_MS = 480;

/**
 * The ring around the mouse, in its own transparent window over whatever
 * is being recorded. Chosen by window label — see `App.tsx`.
 *
 * Written straight to the DOM rather than through React state: this moves
 * sixty times a second, and re-rendering a component that often to shift
 * one circle is the kind of thing that shows up in the recording as
 * stutter. The position comes from the app, which is already reading the
 * pointer for the recording's own trail — a window that ignores the
 * pointer cannot ask where it is itself.
 */
export function CursorHalo() {
  const ring = useRef<HTMLDivElement | null>(null);
  const pulse = useRef<HTMLDivElement | null>(null);
  const wasDown = useRef(false);

  useEffect(() => {
    const pending = listen<HaloAt>("cursor-at", (event) => {
      const ratio = window.devicePixelRatio || 1;
      const x = event.payload.x / ratio;
      const y = event.payload.y / ratio;

      const halo = ring.current;
      if (halo) {
        halo.style.transform = `translate3d(${x - RING / 2}px, ${y - RING / 2}px, 0)`;
      }

      // A press: one pulse, started where the press happened. Restarted
      // by taking the animation off and putting it back, since the same
      // element serves every click.
      if (event.payload.down && !wasDown.current) {
        const mark = pulse.current;
        if (mark) {
          mark.style.transform = `translate3d(${x - RING / 2}px, ${y - RING / 2}px, 0)`;
          mark.classList.remove("is-pulsing");
          // Reading the layout is what makes the restart take effect.
          void mark.offsetWidth;
          mark.classList.add("is-pulsing");
        }
      }
      wasDown.current = event.payload.down;
    });
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div
      className="cursor-halo-window"
      style={
        {
          ["--halo-size" as string]: `${RING}px`,
          ["--halo-pulse" as string]: `${PULSE}`,
          ["--halo-pulse-ms" as string]: `${PULSE_MS}ms`,
        } as React.CSSProperties
      }
    >
      <div className="cursor-halo-pulse" ref={pulse} />
      <div className="cursor-halo-ring" ref={ring} />
    </div>
  );
}
