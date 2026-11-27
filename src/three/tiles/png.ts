// PNG → its stored pixel bytes, decoded here (inflate + row filters), without a canvas.
//
// Elevation tiles are data, not pictures: h = R·256 + G + B/256 − 32768, so a change of 1 in R moves the
// ground by 256 m. Reading pixels back from a canvas (drawImage + getImageData) does not promise the stored
// bytes: the browser may alter what a canvas read returns (anti-fingerprinting noise, color handling), and a
// few altered pixels become spikes and pits across the terrain. Decoding the file itself always gives the
// exact values.
//
// Supported: what the elevation tiles use and the common data PNG variants, 8-bit RGB or RGBA, not interlaced.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export type DecodedPng = { width: number; height: number; channels: 3 | 4; data: Uint8Array };

export async function decodePng(buf: ArrayBuffer): Promise<DecodedPng> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG file");

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let idatSize = 0;
  let ended = false;
  for (let pos = 8; pos + 12 <= bytes.length; ) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = pos + 8;
    if (body + length + 4 > bytes.length) throw new Error(`PNG ${type} chunk cut short`);
    if (type === "IHDR") {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      bitDepth = bytes[body + 8];
      colorType = bytes[body + 9];
      interlace = bytes[body + 12];
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(body, body + length));
      idatSize += length;
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    pos = body + length + 4; // + CRC
  }
  if (!ended) throw new Error("PNG file cut short (no IEND)");
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`PNG format not supported: bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}`);
  }
  const channels = colorType === 2 ? 3 : 4;

  // the IDAT chunks together are one zlib stream ("deflate" in DecompressionStream terms)
  const zlib = new Uint8Array(idatSize);
  let o = 0;
  for (const part of idat) {
    zlib.set(part, o);
    o += part.length;
  }
  const raw = new Uint8Array(await new Response(new Blob([zlib]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error(`PNG image data too short: ${raw.length} bytes for ${width}×${height}`);
  const data = new Uint8Array(stride * height);
  // each row: one filter byte, then the filtered bytes; a, b, c = left, above, above-left (same channel)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[row + i - channels] : 0;
      const b = y > 0 ? data[up + i] : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = (a + b) >> 1;
          break;
        case 4: {
          const c = i >= channels && y > 0 ? data[up + i - channels] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`PNG row ${y}: unknown filter ${filter}`);
      }
      data[row + i] = (raw[src + i] + predictor) & 255;
    }
  }
  return { width, height, channels, data };
}
