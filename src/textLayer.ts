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

export function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  text: TextStyle,
  layout: ClipLayout,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);

  const lines = text.content.split("\n");
  const fontSize = Math.max(1, text.size * height);
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
