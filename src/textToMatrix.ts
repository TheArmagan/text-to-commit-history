// Renders text into the 7-row matrix used by the commit calendar.
// Port of the original text_to_matrix.py (itself based on
// https://gist.github.com/dbader/5488053), with freetype swapped for
// opentype.js plus a small monochrome rasterizer.

import { fileURLToPath } from 'node:url';

import { parse, type Font as OpenTypeFont, type Glyph as OpenTypeGlyph } from 'opentype.js';

export const MAX_MATRIX_HEIGHT = 7;
export const ARIAL_FONT_FILE_NAME = 'Arial.ttf';
// The Python original rendered at 9px through FreeType, whose hinting snaps
// the cap height up to a full 7 pixels. opentype.js does no hinting, so 9px
// here would leave capitals one row short of the calendar. 10px lands on the
// same 7 rows.
export const FONT_SIZE = 10;

// The range getArialFontMatrix searches for a size that fits the calendar.
const MAX_FONT_SIZE = 24;
const MIN_FONT_SIZE = 6;

/** Samples per pixel axis when measuring how much of a pixel a glyph covers. */
const SUPERSAMPLE = 4;

/** How much of a pixel a glyph must cover for that pixel to be turned on. */
const COVERAGE_THRESHOLD = 0.4;

/** Line segments per curve when flattening the glyph outline. */
const CURVE_SEGMENTS = 8;

interface Point {
  x: number;
  y: number;
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RasterizedGlyph {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Vertical distance from the baseline to the bitmap's top-most scanline. */
  top: number;
}

/**
 * A 2D bitmap image represented as a list of byte values. Each byte indicates
 * the state of a single pixel in the bitmap. A value of 0 indicates that the
 * pixel is off and any other value indicates that it is on.
 */
export class Bitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, pixels?: Uint8Array) {
    this.width = Math.floor(width + 0.5);
    this.height = Math.floor(height + 0.5);
    this.pixels = pixels ?? new Uint8Array(this.width * this.height);
  }

  /** Return a string representation of the bitmap's pixels. */
  toString(): string {
    let rows = '';
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        rows += this.pixels[y * this.width + x] ? '#' : '.';
      }
      rows += '\n';
    }
    return rows;
  }

  /** Copy all pixels from src into this bitmap. */
  bitblt(src: Bitmap, x: number, y: number): void {
    let srcpixel = 0;
    let dstpixel = Math.trunc(y * this.width + x);
    const rowOffset = this.width - src.width;

    for (let sy = 0; sy < src.height; sy++) {
      for (let sx = 0; sx < src.width; sx++) {
        // OR the destination pixel with the source pixel because glyph bitmaps
        // may overlap if character kerning is applied, e.g. in the string
        // "AVA" the "A" and "V" glyphs must be rendered with overlapping
        // bounding boxes.
        if (dstpixel >= 0 && dstpixel < this.pixels.length) {
          this.pixels[dstpixel] = this.pixels[dstpixel]! || src.pixels[srcpixel]!;
        }
        srcpixel += 1;
        dstpixel += 1;
      }
      dstpixel += rowOffset;
    }
  }

  /** The box the lit pixels occupy, or null when nothing was drawn. */
  inkBounds(): { top: number; left: number; width: number; height: number } | null {
    let minRow = this.height;
    let maxRow = -1;
    let minCol = this.width;
    let maxCol = -1;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.pixels[y * this.width + x]) {
          minRow = Math.min(minRow, y);
          maxRow = Math.max(maxRow, y);
          minCol = Math.min(minCol, x);
          maxCol = Math.max(maxCol, x);
        }
      }
    }

    if (maxRow < 0) {
      return null;
    }

    return {
      top: minRow,
      left: minCol,
      width: maxCol - minCol + 1,
      height: maxRow - minRow + 1,
    };
  }

  /**
   * Return the drawing as calendar rows: the text cropped to its own ink and
   * centred in the seven rows of a week, so it does not sit against the top of
   * the calendar with blank rows underneath.
   */
  getMatrix(): number[][] {
    const ink = this.inkBounds();
    const matrix: number[][] = [];

    if (ink === null) {
      for (let y = 0; y < MAX_MATRIX_HEIGHT; y++) {
        matrix.push(new Array<number>(Math.max(this.width, 1)).fill(1));
      }
      return matrix;
    }

    const height = Math.min(ink.height, MAX_MATRIX_HEIGHT);
    const top = Math.floor((MAX_MATRIX_HEIGHT - height) / 2);

    for (let y = 0; y < MAX_MATRIX_HEIGHT; y++) {
      const source = y - top + ink.top;
      const row: number[] = [];

      for (let x = 0; x < ink.width; x++) {
        const lit =
          y >= top && y < top + height && this.pixels[source * this.width + ink.left + x];
        row.push(lit ? 4 : 1);
      }

      matrix.push(row);
    }

    return matrix;
  }
}

class Glyph {
  readonly bitmap: Bitmap;
  readonly top: number;
  readonly descent: number;
  readonly ascent: number;
  readonly advanceWidth: number;

  constructor(pixels: Uint8Array, width: number, height: number, top: number, advanceWidth: number) {
    this.bitmap = new Bitmap(width, height, pixels);

    // The glyph bitmap's top-side bearing, i.e. the vertical distance from the
    // baseline to the bitmap's top-most scanline.
    this.top = top;

    // Ascent and descent determine how many pixels the glyph extends above or
    // below the baseline.
    this.descent = Math.max(0, this.height - this.top);
    this.ascent = Math.max(0, Math.max(this.top, this.height) - this.descent);

    // The advance width determines where to place the next character
    // horizontally, that is, how many pixels we move to the right to draw the
    // next glyph.
    this.advanceWidth = advanceWidth;
  }

  get width(): number {
    return this.bitmap.width;
  }

  get height(): number {
    return this.bitmap.height;
  }
}

/** Flatten a glyph outline into closed polygons, in pixel coordinates. */
function flattenPath(glyph: OpenTypeGlyph, fontSize: number): Point[][] {
  const contours: Point[][] = [];
  let current: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };

  const finish = (): void => {
    if (current.length > 1) {
      contours.push(current);
    }
    current = [];
  };

  for (const command of glyph.getPath(0, 0, fontSize).commands) {
    switch (command.type) {
      case 'M':
        finish();
        cursor = { x: command.x!, y: command.y! };
        current.push(cursor);
        break;
      case 'L':
        cursor = { x: command.x!, y: command.y! };
        current.push(cursor);
        break;
      case 'Q':
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS;
          const u = 1 - t;
          current.push({
            x: u * u * cursor.x + 2 * u * t * command.x1! + t * t * command.x!,
            y: u * u * cursor.y + 2 * u * t * command.y1! + t * t * command.y!,
          });
        }
        cursor = { x: command.x!, y: command.y! };
        break;
      case 'C':
        for (let i = 1; i <= CURVE_SEGMENTS; i++) {
          const t = i / CURVE_SEGMENTS;
          const u = 1 - t;
          current.push({
            x:
              u * u * u * cursor.x +
              3 * u * u * t * command.x1! +
              3 * u * t * t * command.x2! +
              t * t * t * command.x!,
            y:
              u * u * u * cursor.y +
              3 * u * u * t * command.y1! +
              3 * u * t * t * command.y2! +
              t * t * t * command.y!,
          });
        }
        cursor = { x: command.x!, y: command.y! };
        break;
      case 'Z':
        finish();
        break;
    }
  }
  finish();

  return contours;
}

/**
 * Rasterize a glyph outline into a monochrome bitmap, the way FreeType's
 * FT_LOAD_TARGET_MONO does: a pixel is on once the outline covers enough of
 * it. Filling uses the non-zero winding rule.
 */
function rasterizeGlyph(glyph: OpenTypeGlyph, fontSize: number): RasterizedGlyph {
  const contours = flattenPath(glyph, fontSize);

  if (contours.length === 0) {
    // Whitespace and other blank glyphs have no outline at all.
    return { pixels: new Uint8Array(0), width: 0, height: 0, top: 0 };
  }

  const edges: Edge[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const from = contour[i]!;
      const to = contour[(i + 1) % contour.length]!;
      if (from.y !== to.y) {
        edges.push({ x0: from.x, y0: from.y, x1: to.x, y1: to.y });
      }
      minX = Math.min(minX, from.x);
      minY = Math.min(minY, from.y);
      maxX = Math.max(maxX, from.x);
      maxY = Math.max(maxY, from.y);
    }
  }

  const left = Math.floor(minX);
  const topEdge = Math.floor(minY);
  const width = Math.max(1, Math.ceil(maxX) - left);
  const height = Math.max(1, Math.ceil(maxY) - topEdge);

  const coverage = new Float32Array(width * height);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const crossings: { x: number; direction: number }[] = [];

  for (let sy = 0; sy < height * SUPERSAMPLE; sy++) {
    const y = topEdge + (sy + 0.5) / SUPERSAMPLE;

    crossings.length = 0;
    for (const edge of edges) {
      const goesDown = edge.y0 < edge.y1;
      const yTop = goesDown ? edge.y0 : edge.y1;
      const yBottom = goesDown ? edge.y1 : edge.y0;
      if (y < yTop || y >= yBottom) {
        continue;
      }
      const t = (y - edge.y0) / (edge.y1 - edge.y0);
      crossings.push({ x: edge.x0 + t * (edge.x1 - edge.x0), direction: goesDown ? 1 : -1 });
    }
    if (crossings.length === 0) {
      continue;
    }
    crossings.sort((a, b) => a.x - b.x);

    const row = Math.floor(sy / SUPERSAMPLE) * width;
    let index = 0;
    let winding = 0;
    for (let sx = 0; sx < width * SUPERSAMPLE; sx++) {
      const x = left + (sx + 0.5) / SUPERSAMPLE;
      while (index < crossings.length && crossings[index]!.x <= x) {
        winding += crossings[index]!.direction;
        index += 1;
      }
      if (winding !== 0) {
        coverage[row + Math.floor(sx / SUPERSAMPLE)]! += 1;
      }
    }
  }

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = coverage[i]! / samples >= COVERAGE_THRESHOLD ? 1 : 0;
  }

  // FreeType hands back a bitmap cropped tightly around the lit pixels, and
  // the rest of the code counts on that, so crop ours the same way.
  let minRow = height;
  let maxRow = -1;
  let minCol = width;
  let maxCol = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        minRow = Math.min(minRow, y);
        maxRow = Math.max(maxRow, y);
        minCol = Math.min(minCol, x);
        maxCol = Math.max(maxCol, x);
      }
    }
  }

  if (maxRow < 0) {
    return { pixels: new Uint8Array(0), width: 0, height: 0, top: 0 };
  }

  const croppedWidth = maxCol - minCol + 1;
  const croppedHeight = maxRow - minRow + 1;
  const pixels = new Uint8Array(croppedWidth * croppedHeight);
  for (let y = 0; y < croppedHeight; y++) {
    for (let x = 0; x < croppedWidth; x++) {
      pixels[y * croppedWidth + x] = mask[(y + minRow) * width + (x + minCol)]!;
    }
  }

  return { pixels, width: croppedWidth, height: croppedHeight, top: -(topEdge + minRow) };
}

export class Font {
  private readonly font: OpenTypeFont;
  private readonly size: number;

  constructor(font: OpenTypeFont, size: number) {
    this.font = font;
    this.size = size;
  }

  static async load(filename: string, size: number): Promise<Font> {
    const data = await Bun.file(filename).arrayBuffer();
    return new Font(parse(data), size);
  }

  /** The same font at another pixel size, without parsing the file again. */
  withSize(size: number): Font {
    return new Font(this.font, size);
  }

  private glyphForCharacter(char: string): Glyph {
    const otGlyph = this.font.charToGlyph(char);
    const scale = this.size / this.font.unitsPerEm;
    const { pixels, width, height, top } = rasterizeGlyph(otGlyph, this.size);
    return new Glyph(pixels, width, height, top, (otGlyph.advanceWidth ?? 0) * scale);
  }

  renderCharacter(char: string): Bitmap {
    return this.glyphForCharacter(char).bitmap;
  }

  /**
   * Return the horizontal kerning offset in pixels when rendering char after
   * previousChar. Use the resulting offset to adjust the glyph's drawing
   * position to reduce extra diagonal whitespace, for example in the string
   * "AV" the bitmaps for "A" and "V" may overlap slightly with some fonts. In
   * this case the glyph for "V" has a negative horizontal kerning offset as it
   * is moved slightly towards the "A".
   */
  private kerningOffset(previousChar: string | null, char: string): number {
    if (previousChar === null) {
      return 0;
    }
    const kerning = this.font.getKerningValue(
      this.font.charToGlyph(previousChar),
      this.font.charToGlyph(char),
    );
    return (kerning * this.size) / this.font.unitsPerEm;
  }

  /** Return [width, height, baseline] of text rendered in the current font. */
  textDimensions(text: string): [number, number, number] {
    let width = 0;
    let maxAscent = 0;
    let maxDescent = 0;
    let previousChar: string | null = null;

    // For each character in the text string we get the glyph and update the
    // overall dimensions of the resulting bitmap.
    for (const char of text) {
      const glyph = this.glyphForCharacter(char);
      maxAscent = Math.max(maxAscent, glyph.ascent);
      maxDescent = Math.max(maxDescent, glyph.descent);
      const kerningX = this.kerningOffset(previousChar, char);

      // With kerning, the advance width may be less than the width of the
      // glyph's bitmap. Make sure we compute the total width so that all of the
      // glyph's pixels fit into the returned dimensions.
      width += Math.max(glyph.advanceWidth + kerningX, glyph.width + kerningX);

      previousChar = char;
    }

    return [width, maxAscent + maxDescent, maxDescent];
  }

  /**
   * Render the given text into a Bitmap and return it. If width, height and
   * baseline are not specified they are computed using textDimensions.
   */
  renderText(text: string, width?: number, height?: number, baseline?: number): Bitmap {
    if (width === undefined || height === undefined || baseline === undefined) {
      [width, height, baseline] = this.textDimensions(text);
    }

    let x = 0;
    let previousChar: string | null = null;
    const outbuffer = new Bitmap(width, height);

    for (const char of text) {
      const glyph = this.glyphForCharacter(char);

      // Take kerning information into account before we render the glyph to
      // the output bitmap.
      x += this.kerningOffset(previousChar, char);

      // The vertical drawing position should place the glyph on the baseline
      // as intended.
      const y = height - glyph.ascent - baseline;

      outbuffer.bitblt(glyph.bitmap, x, y);

      x += glyph.advanceWidth;
      previousChar = char;
    }

    return outbuffer;
  }
}

/**
 * Renders text as calendar rows, at the largest size that still fits.
 *
 * A fixed size does not work: "sesx" is all x-height, so it draws five rows
 * tall and leaves two rows of the week empty, while anything with a descender
 * draws nine rows and loses its tails off the bottom. So try sizes from large
 * to small and keep the first that fits both the seven rows of a week and the
 * weeks available on the calendar.
 */
export async function getArialFontMatrix(text: string, maxColumns = 52): Promise<number[][]> {
  // Resolve the font next to the project, not next to the working directory.
  const path = fileURLToPath(new URL(`../${ARIAL_FONT_FILE_NAME}`, import.meta.url));
  const font = await Font.load(path, FONT_SIZE);

  let smallest: Bitmap | undefined;

  for (let size = MAX_FONT_SIZE; size >= MIN_FONT_SIZE; size--) {
    const bitmap = font.withSize(size).renderText(text);
    const ink = bitmap.inkBounds();

    if (ink === null) {
      throw new Error(`Nothing to draw for ${JSON.stringify(text)}`);
    }
    if (ink.height <= MAX_MATRIX_HEIGHT && ink.width <= maxColumns) {
      return bitmap.getMatrix();
    }
    smallest = bitmap;
  }

  // Too long to fit the calendar even at the smallest size. Draw it anyway,
  // clipped, rather than refusing: the caller reports the width it got.
  return smallest!.getMatrix();
}
