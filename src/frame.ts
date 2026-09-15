import { shapeRatio } from "./types";
import type {
  BackdropCategory,
  BackdropKind,
  EditorSettings,
  FrameShape,
} from "./types";

/** The frame the editor's numbers are quoted against.
 *
 * Padding and corner radius are chosen on sliders that read in pixels, but
 * a pixel means nothing on its own: the preview is whatever size the
 * window leaves it, and the export is 720p or 1080p or the size of the
 * footage. So a slider's number is read as pixels on a frame this wide and
 * scaled from there, which makes the same setting mean the same picture
 * everywhere.
 */
export const REFERENCE_WIDTH = 1280;

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameGeometry {
  /** The whole picture, backdrop included. */
  width: number;
  height: number;
  /** The inset on each side, in this frame's pixels. */
  pad: number;
  /** Corner radius for a clip, in this frame's pixels. */
  radius: number;
  /** Where the footage goes: the largest frame-shaped box that fits
   * inside the padding, centred. A clip's layout is fractions of this. */
  stage: StageRect;
}

/** Works out the stage for a frame of a given size.
 *
 * The stage keeps the frame's own shape rather than taking whatever is
 * left after an equal inset on all four sides. Insetting a 16:9 frame by
 * the same amount everywhere leaves a box that is no longer 16:9, and
 * footage stretched to its width then stood taller than the box — which
 * the preview quietly answered with black bars down both sides.
 */
export function frameGeometry(
  width: number,
  height: number,
  settings: Pick<EditorSettings, "padding" | "rounded">,
): FrameGeometry {
  const relative = width / REFERENCE_WIDTH;
  // Never so much padding that there is no picture left.
  const pad = Math.max(
    0,
    Math.min(settings.padding * relative, Math.min(width, height) / 2 - 1),
  );
  const radius = Math.max(0, settings.rounded * relative);

  const shape = width / height;
  const stageWidth = Math.min(width - pad * 2, (height - pad * 2) * shape);
  const stageHeight = stageWidth / shape;
  return {
    width,
    height,
    pad,
    radius,
    stage: {
      x: (width - stageWidth) / 2,
      y: (height - stageHeight) / 2,
      width: stageWidth,
      height: stageHeight,
    },
  };
}

/** The largest frame-shaped box that fits in the space available. */
export function fitFrame(
  areaWidth: number,
  areaHeight: number,
  shape: FrameShape | number = 16 / 9,
): { width: number; height: number } {
  const ratio = typeof shape === "number" ? shape : shapeRatio(shape);
  const width = Math.max(0, Math.min(areaWidth, areaHeight * ratio));
  return { width, height: width / ratio };
}

/* ------------------------------------------------------------- backdrops */

/** 7 colour pairs per category. */
export const PALETTES: Record<BackdropCategory, [string, string][]> = {
  macOS: [
    ["#6d8bff", "#c86dd7"],
    ["#ff9a8b", "#ff6a88"],
    ["#43cea2", "#185a9d"],
    ["#fbc2eb", "#a6c1ee"],
    ["#f6d365", "#fda085"],
    ["#5ee7df", "#b490ca"],
    ["#30cfd0", "#330867"],
  ],
  Dark: [
    ["#232526", "#414345"],
    ["#0f2027", "#2c5364"],
    ["#1c1c24", "#3a3a52"],
    ["#111827", "#374151"],
    ["#141e30", "#243b55"],
    ["#16222a", "#3a6073"],
    ["#000000", "#434343"],
  ],
  Blue: [
    ["#2193b0", "#6dd5ed"],
    ["#1e3c72", "#2a5298"],
    ["#396cd8", "#89c6ff"],
    ["#0093e9", "#80d0c7"],
    ["#4facfe", "#00f2fe"],
    ["#13547a", "#80d0c7"],
    ["#2563eb", "#1e40af"],
  ],
  Cities: [
    ["#f5af19", "#f12711"],
    ["#3a1c71", "#ffaf7b"],
    ["#485563", "#29323c"],
    ["#7f7fd5", "#91eae4"],
    ["#c31432", "#240b36"],
    ["#eacda3", "#d6ae7b"],
    ["#42275a", "#734b6d"],
  ],
  Purple: [
    ["#8e2de2", "#4a00e0"],
    ["#a18cd1", "#fbc2eb"],
    ["#6a11cb", "#2575fc"],
    ["#c471f5", "#fa71cd"],
    ["#7028e4", "#e5b2ca"],
    ["#654ea3", "#eaafc8"],
    ["#5f2c82", "#49a09d"],
  ],
  Orange: [
    ["#ff7e5f", "#feb47b"],
    ["#f83600", "#f9d423"],
    ["#ffb75e", "#ed8f03"],
    ["#ff512f", "#f09819"],
    ["#fc4a1a", "#f7b733"],
    ["#e65c00", "#f9d423"],
    ["#cb2d3e", "#ef473a"],
  ],
};

export function paletteOf(
  category: BackdropCategory,
  swatch: number,
): [string, string] {
  return PALETTES[category][swatch] ?? PALETTES[category][0];
}

/** A hex colour as its four parts: #rgb, #rrggbb or #rrggbbaa. */
function parseColour(colour: string): [number, number, number, number] {
  const hex = colour.replace("#", "");
  const wide =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const value = parseInt(wide.slice(0, 6), 16);
  const alpha = wide.length >= 8 ? parseInt(wide.slice(6, 8), 16) / 255 : 1;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

function rgba(colour: string, alpha?: number): string {
  const [r, g, b, a] = parseColour(colour);
  return `rgba(${r}, ${g}, ${b}, ${alpha ?? a})`;
}

/** A straight gradient across the frame at a CSS angle: 0 points up and
 * the angle turns clockwise, the same convention linear-gradient uses, so
 * the numbers here can be read straight off the design. */
function linear(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  degrees: number,
  stops: [number, string][],
): void {
  const angle = (degrees * Math.PI) / 180;
  const dx = Math.sin(angle);
  const dy = -Math.cos(angle);
  // The gradient runs corner to corner: long enough that the first and
  // last stops land exactly on the frame's edges, which is what makes a
  // diagonal gradient reach the corners rather than stopping short.
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  const gradient = ctx.createLinearGradient(
    width / 2 - (dx * length) / 2,
    height / 2 - (dy * length) / 2,
    width / 2 + (dx * length) / 2,
    height / 2 + (dy * length) / 2,
  );
  for (const [at, colour] of stops) gradient.addColorStop(at, colour);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/** The angle of "to bottom right" for a frame of this shape.
 *
 * Not 135 degrees unless the frame is square: the gradient runs square on
 * to the diagonal joining the other two corners, so a wide frame tips it
 * towards straight down. On a 16:9 frame it comes out at about 151. */
function toBottomRight(width: number, height: number): number {
  return 180 - (Math.atan2(height, width) * 180) / Math.PI;
}

/** A soft oval of colour fading out to nothing, the way a radial-gradient
 * with a separate width and height draws it.
 *
 * It fades to the same colour at zero opacity rather than to transparent
 * black, so the edge stays clean instead of dirtying into grey. */
function oval(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  colour: string,
  radiusX: number,
  radiusY: number,
  centreX: number,
  centreY: number,
  fadesBy: number,
): void {
  const cx = centreX * width;
  const cy = centreY * height;
  const rx = Math.max(1, radiusX * width);
  const ry = Math.max(1, radiusY * height);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, rgba(colour));
  gradient.addColorStop(Math.min(0.999, fadesBy), rgba(colour, 0));
  gradient.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = gradient;
  // The frame, in the stretched coordinates the oval is drawn in.
  ctx.fillRect(-cx / rx, -cy / ry, width / rx, height / ry);
  ctx.restore();
}

/** Paints the chosen backdrop over a whole frame.
 *
 * This is the one place a backdrop is drawn. The preview shows what this
 * function paints and the export writes what this function paints, so the
 * background behind the footage is not merely similar in the finished
 * file — it is the same picture at a different size.
 */
export function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  settings: Pick<EditorSettings, "backdropKind" | "category" | "swatch">,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const [a, b] = paletteOf(settings.category, settings.swatch);

  switch (settings.backdropKind) {
    case "Desktop":
      linear(ctx, width, height, 160, [
        [0, "#dfe6f2"],
        [0.5, "#b9c6dd"],
        [1, "#8fa2c4"],
      ]);
      return;
    case "Wallpaper":
      linear(ctx, width, height, 135, [
        [0, a],
        [1, b],
      ]);
      return;
    case "Image":
      linear(ctx, width, height, 160, [
        [0, b],
        [1, a],
      ]);
      // Painted back to front. Stacked layers are listed top-first in the
      // design this is taken from, so the order here is its reverse: the
      // first-listed oval is the one that ends up over the others.
      oval(ctx, width, height, `${a}bb`, 0.8, 0.8, 0.5, 0.9, 0.7);
      oval(ctx, width, height, b, 0.7, 0.8, 0.8, 0.3, 0.7);
      oval(ctx, width, height, a, 0.6, 0.7, 0.2, 0.2, 0.65);
      return;
    case "Color":
      ctx.fillStyle = rgba(a);
      ctx.fillRect(0, 0, width, height);
      return;
    case "Gradient":
      linear(ctx, width, height, toBottomRight(width, height), [
        [0, a],
        [0.55, b],
        [1, a],
      ]);
      return;
    case "None":
      return;
  }
}

/** Whether this setting paints anything at all. "None" leaves the frame
 * bare, which is black in the finished file. */
export function hasBackdrop(kind: BackdropKind): boolean {
  return kind !== "None";
}
