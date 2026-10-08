const DALLE_SIZES = {
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
};

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > max) return "";
  return trimmed;
}

function firstText(max, ...values) {
  for (const value of values) {
    const found = text(value, max);
    if (found) return found;
  }
  return "";
}

function imageRefs(params) {
  const raw = params.image ?? params.referenceImages;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, 16);
}

const LONG_EDGE = { "1k": 1024, "2k": 2048, "4k": 3840 };
const FIXED_SIZE = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };

function parseRatio(ratio) {
  const match = String(ratio || "").trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return width / height;
}

export function pixelsFor(resolution, ratio) {
  const step = String(resolution || "").trim().toLowerCase().match(/^([124])\s*k$/);
  if (!step) return "";
  const target = LONG_EDGE[`${step[1]}k`];
  const value = parseRatio(ratio) || 1;
  let best = null;
  for (let width = 16; width <= 3840; width += 16) {
    const rounded = Math.max(16, Math.round(width / value / 16) * 16);
    for (const height of [rounded - 16, rounded, rounded + 16]) {
      if (height < 16 || height > 3840 || height % 16 !== 0) continue;
      const longEdge = Math.max(width, height);
      const shortEdge = Math.min(width, height);
      if (longEdge / shortEdge > 3) continue;
      const pixels = width * height;
      if (pixels < 655360 || pixels > 8294400) continue;
      const ratioError = Math.abs(Math.log(width / height / value));
      const longEdgeError = step[1] === "4" ? Math.max(0, target - longEdge) : Math.abs(longEdge - target);
      const pixelScore = step[1] === "4" ? -pixels : Math.abs(pixels - target * target);
      const candidate = { width, height, longEdgeError, ratioError, pixelScore };
      if (!best
        || candidate.longEdgeError < best.longEdgeError
        || (candidate.longEdgeError === best.longEdgeError && candidate.ratioError < best.ratioError)
        || (candidate.longEdgeError === best.longEdgeError && candidate.ratioError === best.ratioError && candidate.pixelScore < best.pixelScore)) {
        best = candidate;
      }
    }
  }
  return best ? `${best.width}x${best.height}` : "";
}

function pickSize(model, params, resolved) {
  const explicit = firstText(32, params.size, resolved.size);
  const resolution = firstText(16, params.resolution, resolved.resolution);
  const ratio = firstText(16, params.ratio, params.aspect_ratio, params.aspectRatio, resolved.ratio, resolved.aspect_ratio, resolved.aspectRatio);
  if (/^\d{2,5}x\d{2,5}$/i.test(explicit)) return explicit.toLowerCase();
  if (explicit.toLowerCase() === "auto") return "auto";
  const token = /^(?:auto|[124]k)$/i.test(explicit) ? explicit : resolution;
  if (/^[124]k$/i.test(token)) return pixelsFor(token, ratio || "3:2");
  const name = model.toLowerCase();
  if (name.startsWith("gpt-image-2") && ratio) return pixelsFor("2K", ratio);
  if (!name.startsWith("gpt-image-2") && !name.startsWith("dall-e")) return FIXED_SIZE[ratio] || "";
  return "";
}

function dalleSize(params, resolved) {
  const explicit = firstText(32, params.size, resolved.size);
  if (Object.values(DALLE_SIZES).includes(explicit)) return explicit;
  const ratio = firstText(16, params.aspect_ratio, params.aspectRatio, params.ratio, resolved.aspect_ratio, resolved.aspectRatio, resolved.ratio);
  return DALLE_RATIO_SIZE(ratio);
}

const SAVED_KEYS = ["ratio", "resolution", "quality", "format", "background", "output_compression", "moderation", "style", "size"];

function fieldMissing(value) {
  return value == null || value === "";
}

export function requestMode(params) {
  const source = asObject(params);
  const images = imageRefs(source);
  const requested = firstText(40, source.mode, asObject(source.resolvedParameters).mode).toLowerCase();
  if (images.length > 0 || requested === "image2image" || requested === "edit") return "image2image";
  return "text2image";
}

export function savedDefaults(preferences, providerId, modelId, mode) {
  const models = asObject(asObject(asObject(preferences?.imageGeneration).providerDefaults)[providerId]).models;
  const block = asObject(asObject(models)[modelId]);
  const modes = asObject(block.modes);
  const own = asObject(modes[mode]);
  const fallback = mode === "image2image" ? asObject(modes.text2image) : {};
  const out = {};
  for (const key of SAVED_KEYS) {
    if (!fieldMissing(own[key])) out[key] = own[key];
    else if (!fieldMissing(fallback[key])) out[key] = fallback[key];
  }
  return out;
}

function hostForcedAuto(params) {
  return asObject(asObject(params._imageRequest).sources).size === "automatic";
}

export function applyPriority(params, saved) {
  const source = { ...asObject(params) };
  const resolved = { ...asObject(source.resolvedParameters) };
  const settings = asObject(saved);
  for (const key of SAVED_KEYS) {
    if (fieldMissing(settings[key])) continue;
    const current = fieldMissing(source[key]) ? resolved[key] : source[key];
    if (!fieldMissing(current)) continue;
    source[key] = settings[key];
    resolved[key] = settings[key];
  }
  if (hostForcedAuto(source)) {
    const resolution = firstText(16, source.resolution, resolved.resolution);
    const ratio = firstText(16, source.ratio, resolved.ratio);
    if (resolution || ratio) {
      delete source.size;
      delete resolved.size;
    }
  }
  delete source.n;
  delete resolved.n;
  source.mode = requestMode(source);
  source.resolvedParameters = resolved;
  return source;
}

function DALLE_RATIO_SIZE(ratio) {
  return DALLE_SIZES[ratio] || "";
}

function copyOptional(body, params, resolved) {
  const quality = firstText(32, params.quality, resolved.quality);
  if (quality) body.quality = quality;
  const background = firstText(32, params.background, resolved.background);
  if (background) body.background = background;
  const moderation = firstText(32, params.moderation, resolved.moderation);
  if (moderation) body.moderation = moderation;
  const compression = params.output_compression ?? resolved.output_compression;
  if (typeof compression === "number" && Number.isFinite(compression)) body.output_compression = compression;
}

export function buildImageRequest(params) {
  const source = asObject(params);
  const resolved = asObject(source.resolvedParameters);
  const model = firstText(200, source.modelId, source.model, resolved.model);
  if (!model) throw new Error("生图请求里没有模型名");
  const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
  if (!prompt) throw new Error("生图请求里没有提示词");
  const dalle = model.toLowerCase().startsWith("dall-e");
  const body = { model, prompt, n: 1 };
  if (dalle) {
    body.response_format = "b64_json";
    body.n = 1;
    const size = dalleSize(source, resolved);
    if (size) body.size = size;
    const style = firstText(32, source.style, resolved.style);
    if (style) body.style = style;
  } else {
    const format = firstText(16, source.format, source.output_format, resolved.format, resolved.output_format) || "jpeg";
    body.output_format = format;
    const size = pickSize(model, source, resolved);
    if (size) body.size = size;
    copyOptional(body, source, resolved);
  }
  return { body, images: imageRefs(source) };
}

export function headerMap(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const name = text(item.name ?? item.key, 80);
      const headerValue = typeof item.value === "string" ? item.value : "";
      if (name && headerValue) out[name] = headerValue;
    }
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    const name = text(key, 80);
    if (name && typeof item === "string") out[name] = item;
  }
  return out;
}

export function locateImageUrl(raw, baseUrl) {
  let url = String(raw || "").trim();
  if (!url) throw new Error("图片网址是空的");
  if (url.startsWith("/")) url = `${String(baseUrl || "").replace(/\/+$/, "")}${url}`;
  let original = url;
  try {
    const parsed = new URL(url);
    original = parsed.href;
    if (/%2f/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/%2f/gi, "/");
      url = parsed.href;
    } else {
      url = parsed.href;
    }
  } catch {
    throw new Error("图片网址无法解析");
  }
  return { located: url, original };
}
