/** A gain stage for the preview.
 *
 * A media element's own `volume` cannot go above 1 — the level the file was
 * recorded at — so a clip pushed above 0 dB needs Web Audio behind it.
 *
 * Routing an element through Web Audio is one-way and permanent: once it
 * has a source node, all of its sound goes through the graph and its own
 * `volume` no longer applies. So an element is only attached when
 * something actually asks it to be louder than recorded; every other clip
 * keeps using `volume`, the path that has always worked.
 *
 * The media is served over Tauri's asset protocol, which is a different
 * origin from the app. A cross-origin media element is normally "tainted",
 * and a tainted element played through Web Audio is silent — so every
 * element is marked `crossOrigin="anonymous"`. That is safe here because
 * the asset protocol answers with `Access-Control-Allow-Origin` set to the
 * window's own origin on every response (tauri's `src/protocol/asset.rs`),
 * so the check passes and the element is never tainted.
 */

interface Attached {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

let context: AudioContext | null = null;
/** Set once Web Audio has proved unavailable, so it isn't retried on
 * every animation frame. */
let unavailable = false;
const attached = new Map<HTMLMediaElement, Attached>();
/** Elements that could not be routed. An element may only ever have one
 * source node, so a failure is permanent — without this the attempt would
 * be repeated on every animation frame. */
const refused = new WeakSet<HTMLMediaElement>();

function ensureContext(): AudioContext | null {
  if (unavailable) return null;
  if (context) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    unavailable = true;
    return null;
  }
  try {
    context = new Ctor();
    return context;
  } catch {
    unavailable = true;
    return null;
  }
}

export const audioGraph = {
  /** Whether this element is already going through the graph, and so has
   * to keep being driven by it. */
  has(element: HTMLMediaElement): boolean {
    return attached.has(element);
  },

  /** The element's gain control, building the graph the first time. Null
   * when Web Audio isn't available, which leaves the caller to fall back
   * to the element's own volume. */
  attach(element: HTMLMediaElement): GainNode | null {
    const existing = attached.get(element);
    if (existing) return existing.gain;

    if (refused.has(element)) return null;
    const ctx = ensureContext();
    if (!ctx) return null;
    try {
      const source = ctx.createMediaElementSource(element);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      attached.set(element, { source, gain });
      return gain;
    } catch {
      // An element that already has a source node, or one the browser
      // won't route. Either way, the caller's fallback still works.
      refused.add(element);
      return null;
    }
  },

  /** Lets go of an element that has left the stage for good.
   *
   * Only ever called for an element React has unmounted. Routing is
   * one-way — an element may have a source node only once, and tearing
   * that node down does not give the element its own output back — so
   * releasing one that is still on screen would leave it playing into a
   * disconnected graph, which is to say silent. */
  release(element: HTMLMediaElement): void {
    const found = attached.get(element);
    if (!found) return;
    try {
      found.source.disconnect();
      found.gain.disconnect();
    } catch {
      // Already torn down; nothing to do.
    }
    attached.delete(element);
  },

  /** Browsers start an audio context suspended until the page has been
   * interacted with, so this is called from the press that starts
   * playback. */
  resume(): void {
    if (context && context.state === "suspended") {
      void context.resume().catch(() => {});
    }
  },
};
