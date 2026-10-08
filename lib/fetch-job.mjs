import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateImageUrl } from "./image-url.mjs";

const MAX_BYTES = 25 * 1024 * 1024;
const POST_TIMEOUT_MS = 180_000;
const GET_TIMEOUT_MS = 60_000;

function explain(error) {
  const code = error?.cause?.code || error?.code;
  const message = error?.message || String(error);
  return code && !String(message).includes(code) ? `${message} (${code})` : message;
}

function extensionFor(bytes) {
  if (bytes.subarray(0, 4).toString("hex") === "89504e47") return "png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF") return "webp";
  return "jpg";
}

async function request(url, options) {
  let undici = null;
  try {
    undici = await import("undici");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  if (!undici) {
    const response = await fetch(url, options);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error("响应超过 25MB");
    return { ok: response.ok, status: response.status, bytes };
  }
  const agent = new undici.Agent();
  try {
    const response = await undici.fetch(url, { ...options, dispatcher: agent });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error("响应超过 25MB");
    return { ok: response.ok, status: response.status, bytes };
  } finally {
    await agent.close?.();
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

async function readApi(url, options) {
  const response = await request(url, options);
  const payload = parseJson(response.bytes);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || "";
    throw new Error(detail ? `生图接口 ${response.status}：${detail}` : `生图接口 ${response.status}`);
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  if (data.length === 0) throw new Error("生图接口没有返回图片");
  return data;
}

async function downloadUrl(raw, baseUrl) {
  const { located, original } = locateImageUrl(raw, baseUrl);
  let lastError = null;
  for (const candidate of located === original ? [located] : [located, original]) {
    try {
      const response = await request(candidate, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) });
      if (!response.ok) {
        lastError = new Error(`下载图片失败：HTTP ${response.status}`);
        continue;
      }
      if (response.bytes.length < 32) throw new Error("下载到的图片是空的");
      return response.bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`图片网址下载失败：${explain(lastError)}`);
}

function bytesFromItem(item) {
  const encoded = [item?.b64_json, item?.b64, item?.base64, item?.image_base64]
    .find((value) => typeof value === "string" && value.trim());
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 32 || bytes.length > MAX_BYTES) throw new Error("接口返回的图片数据不可用");
  return bytes;
}

function webpSize(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (tag === "VP8X" && size >= 10 && start + 10 <= bytes.length) {
      const width = 1 + (bytes[start + 4] | (bytes[start + 5] << 8) | (bytes[start + 6] << 16));
      const height = 1 + (bytes[start + 7] | (bytes[start + 8] << 8) | (bytes[start + 9] << 16));
      return { width, height, format: "webp" };
    }
    if (tag === "VP8 " && size >= 10 && start + 10 <= bytes.length && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      return { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff, format: "webp" };
    }
    if (tag === "VP8L" && size >= 5 && start + 5 <= bytes.length && bytes[start] === 0x2f) {
      const bits = bytes.readUInt32LE(start + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
    }
    if (size > bytes.length) break;
    offset = start + size + (size % 2);
  }
  return null;
}

export function readImageSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(i + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5), format: "jpeg" };
      }
      i += 2 + length;
    }
    return null;
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return webpSize(bytes);
  return null;
}

export function expectedSize(sent) {
  const raw = typeof sent?.size === "string" ? sent.size.trim() : "";
  const match = /^(\d+)x(\d+)$/i.exec(raw);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  const format = typeof sent?.format === "string" ? sent.format.toLowerCase() : "";
  const normalized = format === "jpg" ? "jpeg" : format;
  if ((!width || !height) && !normalized) return null;
  return {
    width: width || null,
    height: height || null,
    format: normalized,
  };
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

export function deliveryWarning(host, expected, actual) {
  if (!expected) return null;
  const where = host ? `中转 ${host}` : "中转";
  const askedSize = expected.width && expected.height ? `${expected.width}×${expected.height}` : "";
  const askedFormat = expected.format || "";
  if (!actual) {
    const asked = [askedSize, askedFormat].filter(Boolean).join(" ");
    return `${where} 交回了图，但读不出宽高。送出的是 ${asked}，尺寸和格式没能核对。`;
  }
  const sizeOff = Boolean(askedSize) && (actual.width !== expected.width || actual.height !== expected.height);
  const formatOff = Boolean(askedFormat) && actual.format !== askedFormat;
  if (!sizeOff && !formatOff) return null;
  const asked = askedFormat && askedSize ? `${askedSize} ${askedFormat}` : (askedSize || askedFormat);
  const got = `${actual.width}×${actual.height} ${actual.format}`;
  if (sizeOff && formatOff) {
    return `${where} 没按请求交图：送出 ${asked}，交回 ${got}。尺寸和格式都改了。`;
  }
  if (formatOff) return `${where} 换了格式：送出 ${askedFormat}，交回 ${got}。`;
  return `${where} 没按尺寸交图：送出 ${asked}，交回 ${got}。像素是中转改的。`;
}

function classifyImages(images) {
  const remote = [];
  const local = [];
  for (const item of images) {
    if (/^https?:\/\//i.test(item) || /^file-[A-Za-z0-9_-]+/.test(item)) remote.push(item);
    else local.push(item);
  }
  if (remote.length > 0 && local.length > 0) throw new Error("参考图不能同时使用网址和本地文件");
  return { remote, local };
}

async function writeResult(resultPath, result) {
  await mkdir(path.dirname(resultPath), { recursive: true });
  const temporary = `${resultPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), "utf8");
  await rename(temporary, resultPath);
}

async function main() {
  const jobPath = process.argv[2];
  const resultPath = process.argv[3];
  if (!jobPath || !resultPath) {
    process.exitCode = 2;
    return;
  }
  try {
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    await unlink(jobPath).catch(() => {});
    const baseUrl = String(job.baseUrl || "").replace(/\/+$/, "");
    const headers = { ...(job.headers || {}) };
    if (job.apiKey) headers.authorization = `Bearer ${job.apiKey}`;
    const images = Array.isArray(job.images) ? job.images : [];
    const { remote, local } = classifyImages(images);
    const endpoint = images.length > 0 ? `${baseUrl}/images/edits` : `${baseUrl}/images/generations`;
    let data;
    if (local.length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(job.body || {})) {
        if (value != null) form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      for (const filePath of local) {
        const bytes = await readFile(filePath);
        const ext = extensionFor(bytes);
        const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        form.append("image[]", new Blob([bytes], { type }), path.basename(filePath));
      }
      data = await readApi(endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    } else {
      const body = remote.length > 0
        ? {
          ...job.body,
          images: remote.map((item) => /^file-/.test(item) ? { file_id: item } : { image_url: item }),
        }
        : job.body;
      data = await readApi(endpoint, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    }
    await mkdir(job.outDir, { recursive: true });
    const files = [];
    const warnings = [];
    const expected = expectedSize(job.sent);
    const host = hostOf(baseUrl);
    try {
      for (let index = 0; index < data.length; index += 1) {
        const item = data[index] || {};
        const bytes = bytesFromItem(item) || (typeof item.url === "string" ? await downloadUrl(item.url, baseUrl) : null);
        if (!bytes) throw new Error("生图接口没有给出图片数据，也没有给出网址");
        if (expected) {
          const warning = deliveryWarning(host, expected, readImageSize(bytes));
          if (warning) warnings.push(warning);
        }
        const name = `${job.id}-${index + 1}.${extensionFor(bytes)}`;
        if (!/^[a-f0-9]+-\d+\.(jpg|png|webp)$/.test(name)) throw new Error("生成的文件名不合法");
        await writeFile(path.join(job.outDir, name), bytes);
        files.push(name);
      }
    } catch (error) {
      for (const name of files) await unlink(path.join(job.outDir, name)).catch(() => {});
      throw error;
    }
    await writeResult(resultPath, {
      ok: true,
      files,
      sent: job.sent || null,
      ...warnings.length > 0 ? { warning: warnings.join("\n") } : {},
    });
  } catch (error) {
    await unlink(jobPath).catch(() => {});
    await writeResult(resultPath, { ok: false, error: explain(error) }).catch(() => {});
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
