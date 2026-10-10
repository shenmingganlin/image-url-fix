const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3_840;
const MIN_PIXELS = 655_360;
const MAX_RATIO = 3;
const RESOLUTION_EDGE = Object.freeze({ "1k": 1024, "2k": 2048, "4k": 3840 });

function parseRatio(value) {
  const match = String(value ?? "").trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

function parseResolution(value) {
  const match = String(value ?? "").trim().toLowerCase().match(/^([124])\s*k$/);
  return match ? `${match[1]}k` : null;
}

export function expectedGptImage2Size({ ratio, resolution } = {}) {
  const ratioValue = parseRatio(ratio);
  const normalizedResolution = parseResolution(resolution);
  if (!ratioValue || !normalizedResolution) return null;

  const targetEdge = RESOLUTION_EDGE[normalizedResolution];
  let best = null;
  for (let width = 16; width <= MAX_EDGE; width += 16) {
    const heightNearRatio = Math.max(16, Math.round((width / ratioValue) / 16) * 16);
    for (const height of [heightNearRatio - 16, heightNearRatio, heightNearRatio + 16]) {
      if (height < 16 || height > MAX_EDGE || height % 16 !== 0) continue;
      if (Math.max(width, height) / Math.min(width, height) > MAX_RATIO) continue;
      const pixels = width * height;
      if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) continue;

      const longEdgeError = normalizedResolution === "4k"
        ? Math.max(0, targetEdge - Math.max(width, height))
        : Math.abs(Math.max(width, height) - targetEdge);
      const ratioError = Math.abs(Math.log((width / height) / ratioValue));
      const pixelScore = normalizedResolution === "4k"
        ? -pixels
        : Math.abs(pixels - targetEdge * targetEdge);
      const candidate = { width, height, longEdgeError, ratioError, pixelScore };
      if (!best
        || candidate.longEdgeError < best.longEdgeError
        || (candidate.longEdgeError === best.longEdgeError && candidate.ratioError < best.ratioError)
        || (candidate.longEdgeError === best.longEdgeError && candidate.ratioError === best.ratioError && candidate.pixelScore < best.pixelScore)) {
        best = candidate;
      }
    }
  }

  return best ? { width: best.width, height: best.height } : null;
}

export function sizeMismatchWarning(expected, actual) {
  if (!expected || !actual
    || !Number.isFinite(expected.width) || !Number.isFinite(expected.height)
    || !Number.isFinite(actual.width) || !Number.isFinite(actual.height)) return null;
  if (expected.width === actual.width && expected.height === actual.height) return null;
  return `没按尺寸交图：送出 ${expected.width}×${expected.height}，交回 ${actual.width}×${actual.height}。`;
}
