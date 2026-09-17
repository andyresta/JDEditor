import type { ClipLayout, TextStyle } from "./types";

/** Draws a title onto a full frame.
 *
 * The same function paints the preview and the frame that is handed to the
 * renderer, so what is exported is not merely similar to what was on
 * screen — it is the identical drawing at a different size. Everything is
 * measured against the frame's height, which is what makes that true.
 *
 * The canvas covers the whole frame rather than just the words, so the
 * export can lay it over the picture at full size with no position
 * arithmetic on the other side to get wrong.
 */
export const TEXT_FONT_STACK =
  '"Segoe UI", -apple-system, system-ui, "Helvetica Neue", Arial, sans-serif';

/** How much of the line height is left as breathing room inside the panel
 * behind the words. */
const PANEL_PAD_X = 0.42;
const PANEL_PAD_Y = 0.2;
const LINE_SPACING = 1.25;

/** Everything that both drawing a title and drawing a ring round it need
 * to know.
 *
 * One function, so the two cannot drift: the box the editor puts round the
 * words is worked out by the same arithmetic that puts the words there,
 * not by a second guess at it. Leaves the context's font set, ready to be
 * drawn with. */
interface TitleMetrics {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  blockHeight: number;
  widest: number;
  centreX: number;
  centreY: number;
}

function measureTitle(
  ctx: CanvasRenderingContext2D,
  text: TextStyle,
  layout: ClipLayout,
  width: number,
  height: number,
): TitleMetrics {

  const lines = text.content.split("\n");
  // Measured against the frame's height, then by whatever the layout says:
  // the size in the Text panel is the title's own, and dragging a corner
  // on the stage scales it from there. Both ends draw with this function,
  // so the words come out the same size in the file as on screen.
  const fontSize = Math.max(1, text.size * height * (layout.scale || 1));
  const font = `${text.bold ? 700 : 500} ${fontSize}px ${TEXT_FONT_STACK}`;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lineHeight = fontSize * LINE_SPACING;
  const widest = lines.reduce(
    (most, line) => Math.max(most, ctx.measureText(line).width),
    0,
  );
  const blockHeight = lineHeight * lines.length;

  // The layout gives where the middle of the title sits, as a fraction of
  // the frame from its centre.
  const centreX = (0.5 + layout.x) * width;
  const centreY = (0.5 + layout.y) * height;

  return { lines, fontSize, lineHeight, blockHeight, widest, centreX, centreY };
}

export function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  text: TextStyle,
  layout: ClipLayout,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const { lines, fontSize, lineHeight, blockHeight, widest, centreX, centreY } =
    measureTitle(ctx, text, layout, width, height);

  if (text.background) {
    const padX = fontSize * PANEL_PAD_X;
    const padY = fontSize * PANEL_PAD_Y;
    const panelWidth = widest + padX * 2;
    const panelHeight = blockHeight + padY * 2;
    const radius = Math.min(fontSize * 0.35, panelHeight / 2);
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = text.background;
    ctx.beginPath();
    ctx.roundRect(
      centreX - panelWidth / 2,
      centreY - panelHeight / 2,
      panelWidth,
      panelHeight,
      radius,
    );
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = text.color;
  lines.forEach((line, index) => {
    // Laid out from the middle of the block so the whole title is centred
    // on the layout's point however many lines it runs to.
    const y = centreY - blockHeight / 2 + lineHeight * (index + 0.5);
    ctx.fillText(line, centreX, y);
  });
}

/** A canvas kept aside for measuring — text cannot be measured without
 * one. Never drawn to, never shown. */
let scratch: CanvasRenderingContext2D | null | undefined;
function measuringContext(): CanvasRenderingContext2D | null {
  if (scratch === undefined) {
    scratch = document.createElement("canvas").getContext("2d");
  }
  return scratch;
}

/** The box the words fill, in pixels of the frame they are drawn on.
 *
 * What the editor draws its ring and handles around. A title's drawing
 * covers the whole frame — it has to, so that the renderer can lay it over
 * the picture with no arithmetic of its own — but nearly all of it is
 * empty, and a ring round the empty part says nothing about what is being
 * held. Null when there is nothing to measure. */
export function textBounds(
  text: TextStyle,
  layout: ClipLayout,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const ctx = measuringContext();
  if (!ctx || width <= 0 || height <= 0) return null;
  const m = measureTitle(ctx, text, layout, width, height);
  if (m.widest <= 0 || m.blockHeight <= 0) return null;
  // The panel behind the words, where there is one, is part of what is
  // seen, so it is part of what is ringed.
  const padX = text.background ? m.fontSize * PANEL_PAD_X : 0;
  const padY = text.background ? m.fontSize * PANEL_PAD_Y : 0;
  const boxWidth = m.widest + padX * 2;
  const boxHeight = m.blockHeight + padY * 2;
  return {
    x: m.centreX - boxWidth / 2,
    y: m.centreY - boxHeight / 2,
    width: boxWidth,
    height: boxHeight,
  };
}
