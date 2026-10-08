import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { applyPriority, buildImageRequest, headerMap, requestMode, savedDefaults } from "./lib/image-url.mjs";
import { catalogPatch } from "./lib/image-params.mjs";

export const name = "image-url-fix";

const SCRIPT = fileURLToPath(new URL("./lib/fetch-job.mjs", import.meta.url));
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 20_000;
const SAFE_EXT = /^\.[a-z0-9]{1,8}$/;

function sessionPathOf(ctx) {
  const task = ctx?.task;
  const candidates = [task?.sessionPath, task?.sessionRef?.sessionPath, ctx?.sessionPath];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function bannerText(warning) {
  const body = warning.trim().replace(/\s+/g, " ");
  if (body.length <= 200) return body;
  return `${body.slice(0, 199)}…`;
}

async function markDrift(sdk, ctx, warning) {
  const body = bannerText(warning);
  await sdk.logger.warn(body).catch(() => {});
  const sessionPath = sessionPathOf(ctx);
  if (sessionPath && typeof sdk.inputBanner?.set === "function") {
    try {
      await sdk.inputBanner.set({
        sessionPath,
        bannerId: "image-drift",
        text: body,
        buttons: [],
      });
      return sessionPath;
    } catch (error) {
      await sdk.logger.warn(`输入框上的差异没挂上：${error?.message || error}`).catch(() => {});
    }
  }
  try {
    await sdk.notifications.show({ title: "如实生图", body });
  } catch (error) {
    await sdk.logger.warn(`尺寸或格式提醒没有弹出：${error?.message || error}`).catch(() => {});
  }
  return "";
}

async function attachParameterSchemas(sdk) {
  let listed;
  try {
    listed = await sdk.bus.request("provider:media-providers", { capability: "image_generation" });
  } catch (error) {
    await sdk.logger.warn(`读不到图片模型目录，参数面板先不补：${error?.message || error}`);
    return;
  }
  const providers = listed?.providers && typeof listed.providers === "object" ? listed.providers : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      const patch = catalogPatch(model);
      const modelId = typeof model?.id === "string" ? model.id.trim() : "";
      if (!patch || !modelId) continue;
      try {
        await sdk.media.updateModel(providerId, "image_generation", modelId, patch);
        await sdk.logger.info(`已把「${modelId}」的图片参数写进设置`);
      } catch (error) {
        await sdk.logger.warn(`「${providerId}/${modelId}」的参数没有写进设置：${error?.message || error}`);
      }
    }
  }
}

function providerIdOf(params) {
  const id = params?.credentialProviderId || params?.providerId;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

function modelIdOf(params) {
  const id = params?.modelId || params?.model;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

function preferencesPath(dataDir) {
  return path.join(path.dirname(path.dirname(dataDir)), "user", "preferences.json");
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Buffer.isBuffer(value.content)) return value.content.toString("utf8");
  if (value.content instanceof Uint8Array) return Buffer.from(value.content).toString("utf8");
  if (value.content && typeof value.content === "object" && typeof value.content.text === "string") return value.content.text;
  return "";
}

function jobId() {
  return randomBytes(8).toString("hex");
}

async function readResult(resultPath) {
  try {
    return JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function waitForResult(resultPath, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const result = await readResult(resultPath).catch(() => null);
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function childEnv() {
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  env.NO_PROXY = "*";
  env.NODE_USE_ENV_PROXY = "0";
  return env;
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isRemoteImage(item) {
  return /^https?:\/\//i.test(item) || /^file-[A-Za-z0-9_-]+/.test(item);
}

function stageError(error, filePath) {
  const message = error?.message || String(error);
  const name = path.basename(filePath);
  if (error?.code === "resource_access_denied" || /not permitted to app\/resources\.read/.test(message)) {
    return new Error(`参考图「${name}」在应用读不到的位置。请允许「如实生图」读取资源，再生成一次。`);
  }
  if (error?.code === "resource_not_found") return new Error(`找不到参考图「${name}」`);
  return new Error(`读不到参考图「${name}」：${message}`);
}

export default defineApp(async (sdk) => {
  const jobsDir = path.join(sdk.dataDir, "jobs");
  const generatedDir = path.join(sdk.dataDir, "generated");
  const refsDir = path.join(sdk.dataDir, "refs");
  const driftFile = path.join(sdk.dataDir, "drift-sessions.json");
  const driftSessions = new Set();
  let holdExact = false;

  async function loadDrift() {
    try {
      const parsed = JSON.parse(await readFile(driftFile, "utf8"));
      const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      for (const item of sessions) {
        if (typeof item === "string" && item.trim()) driftSessions.add(item);
      }
      holdExact = parsed?.hold === true && driftSessions.size > 0;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await sdk.logger.warn(`上次的尺寸差异没读出来：${error?.message || error}`).catch(() => {});
      }
    }
  }

  async function saveDrift() {
    if (driftSessions.size === 0) holdExact = false;
    if (driftSessions.size === 0) {
      await unlink(driftFile).catch(() => {});
      return;
    }
    await mkdir(sdk.dataDir, { recursive: true });
    await writeFile(driftFile, JSON.stringify({ sessions: [...driftSessions], hold: holdExact }), "utf8");
  }

  async function clearDrift(ctx) {
    const sessionPath = sessionPathOf(ctx);
    if (sessionPath && driftSessions.has(sessionPath)) {
      try {
        if (typeof sdk.inputBanner?.dismiss === "function") {
          await sdk.inputBanner.dismiss({ sessionPath, bannerId: "image-drift" });
        }
        driftSessions.delete(sessionPath);
        holdExact = false;
        await saveDrift();
      } catch (error) {
        await sdk.logger.warn(`输入框上的差异没撤下：${error?.message || error}`).catch(() => {});
      }
      return;
    }
    if (holdExact) {
      holdExact = false;
      await saveDrift();
    }
  }

  await loadDrift();

  function readableWithoutHost(filePath) {
    return isInside(sdk.dataDir, filePath) || isInside(APP_DIR, filePath);
  }

  async function forgetStaged(id) {
    const notePath = path.join(jobsDir, `${id}.staged.json`);
    try {
      const names = JSON.parse(await readFile(notePath, "utf8"));
      if (Array.isArray(names)) {
        for (const name of names) {
          if (typeof name !== "string" || !name.startsWith(`${id}-`) || name.includes("..") || name.includes("/") || name.includes("\\")) continue;
          const target = path.join(refsDir, name);
          if (!isInside(refsDir, target)) continue;
          await unlink(target).catch(() => {});
        }
      }
      await unlink(notePath).catch(() => {});
    } catch (error) {
      if (error?.code === "ENOENT") return;
      await sdk.logger.warn(`参考图副本没有清掉：${error?.message || error}`).catch(() => {});
    }
  }

  async function stageLocalImages(images, id) {
    const staged = [];
    const copies = [];
    let localIndex = 0;
    try {
      for (const item of images) {
        if (isRemoteImage(item)) {
          staged.push(item);
          continue;
        }
        if (!path.isAbsolute(item)) throw new Error("参考图必须是本地绝对路径");
        if (readableWithoutHost(item)) {
          staged.push(path.resolve(item));
          continue;
        }
        localIndex += 1;
        const info = await sdk.resources.stat({ kind: "local-file", path: item }).catch((error) => {
          throw stageError(error, item);
        });
        if (!info?.exists || info.isDirectory) throw new Error(`参考图「${path.basename(item)}」不是可读的文件`);
        const ext = path.extname(item).toLowerCase();
        const safeExt = SAFE_EXT.test(ext) ? ext : ".img";
        const name = `${id}-${localIndex}${safeExt}`;
        const dest = path.join(refsDir, name);
        await sdk.resources.copy(
          { kind: "local-file", path: item },
          { kind: "local-file", path: dest },
        ).catch((error) => {
          throw stageError(error, item);
        });
        copies.push(name);
        staged.push(dest);
      }
      if (copies.length > 0) {
        await mkdir(jobsDir, { recursive: true });
        await writeFile(path.join(jobsDir, `${id}.staged.json`), JSON.stringify(copies), "utf8");
      }
    } catch (error) {
      for (const name of copies) await unlink(path.join(refsDir, name)).catch(() => {});
      await unlink(path.join(jobsDir, `${id}.staged.json`)).catch(() => {});
      throw error;
    }
    return staged;
  }

  async function nodeExecutable() {
    let hit;
    try {
      hit = await sdk.process.resolveExecutable({ candidates: ["node.exe", "node"] });
    } catch (error) {
      throw new Error(`找不到可用的 node，或还没有允许这个应用启动子进程（app/process.spawn）。${error?.message || ""}`.trim());
    }
    if (!hit?.path) throw new Error("找不到 node.exe。这个修复需要一个不受宿主代理影响的 Node 来下载图片。");
    return hit.path;
  }

  let warnedPrefs = false;

  async function loadSaved(params) {
    const providerId = providerIdOf(params);
    const modelId = modelIdOf(params);
    if (!providerId || !modelId) return {};
    try {
      const raw = await sdk.resources.read({ kind: "local-file", path: preferencesPath(sdk.dataDir) });
      const text = extractText(raw);
      if (!text) throw new Error("设置文件是空的");
      return savedDefaults(JSON.parse(text), providerId, modelId, requestMode(params));
    } catch (error) {
      if (!warnedPrefs) {
        warnedPrefs = true;
        await sdk.logger.warn(`设置页的默认参数这次没读到，只使用请求里已经带上的参数：${error?.message || error}`).catch(() => {});
      }
      return {};
    }
  }

  async function submit(params) {
    const providerId = providerIdOf(params);
    if (!providerId) throw new Error("生图请求里没有供应商");
    const saved = await loadSaved(params);
    const prepared = applyPriority(params, saved);
    const credentials = await sdk.bus.request("provider:credentials", { providerId });
    if (credentials?.error) throw new Error(String(credentials.error));
    const baseUrl = typeof credentials?.baseUrl === "string" ? credentials.baseUrl.replace(/\/+$/, "") : "";
    const apiKey = typeof credentials?.apiKey === "string" ? credentials.apiKey : "";
    const headers = headerMap(credentials?.headers);
    if (!baseUrl) throw new Error(`供应商「${providerId}」没有接口地址`);
    if (!apiKey && Object.keys(headers).length === 0) throw new Error(`供应商「${providerId}」没有可用的密钥`);

    const request = buildImageRequest(prepared);
    const sent = {
      mode: prepared.mode,
      size: request.body.size || "",
      quality: request.body.quality || "",
      format: request.body.output_format || "",
      ratio: prepared.ratio || prepared.resolvedParameters?.ratio || "",
      resolution: prepared.resolution || prepared.resolvedParameters?.resolution || "",
      images: request.images.length,
    };
    await sdk.logger.info(`送出 ${sent.mode} size=${sent.size || "未写"} ratio=${sent.ratio || "未写"} resolution=${sent.resolution || "未写"} quality=${sent.quality || "未写"}`).catch(() => {});
    const exe = await nodeExecutable();
    const id = jobId();
    const jobPath = path.join(jobsDir, `${id}.job.json`);
    const resultPath = path.join(jobsDir, `${id}.result.json`);
    let images;
    try {
      images = await stageLocalImages(request.images, id);
      await mkdir(jobsDir, { recursive: true });
      await mkdir(generatedDir, { recursive: true });
      await writeFile(jobPath, JSON.stringify({
        id,
        baseUrl,
        apiKey,
        headers,
        body: request.body,
        sent,
        images,
        outDir: generatedDir,
      }), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      await forgetStaged(id);
      throw error;
    }

    let child;
    try {
      child = spawn(exe, [SCRIPT, jobPath, resultPath], {
        windowsHide: true,
        stdio: "ignore",
        env: childEnv(),
      });
    } catch (error) {
      await unlink(jobPath).catch(() => {});
      await forgetStaged(id);
      throw error;
    }
    child.on("error", (error) => {
      writeFile(resultPath, JSON.stringify({ ok: false, error: error?.message || String(error) }), "utf8").catch(() => {});
      unlink(jobPath).catch(() => {});
    });
    child.on("exit", (code) => {
      if (code === 0 || code === null) return;
      readResult(resultPath).then((existing) => {
        if (existing) return;
        return writeFile(resultPath, JSON.stringify({ ok: false, error: `下载进程退出 ${code}` }), "utf8");
      }).catch(() => {});
    });
    child.unref();

    const ready = await waitForResult(resultPath, WAIT_MS);
    if (ready?.ok === true && Array.isArray(ready.files) && ready.files.length > 0) {
      await forgetStaged(id);
      if (typeof ready.warning === "string" && ready.warning.trim()) return { taskId: id };
      if (holdExact) return { taskId: id };
      return { taskId: id, files: ready.files };
    }
    if (ready && ready.ok === false) {
      await forgetStaged(id);
      throw new Error(ready.error || "生图失败");
    }
    return { taskId: id };
  }

  async function query(taskId, ctx) {
    if (typeof taskId !== "string" || !/^[a-f0-9]{16}$/.test(taskId)) {
      return { status: "failed", failReason: "未知的生图任务" };
    }
    let result;
    try {
      result = await readResult(path.join(jobsDir, `${taskId}.result.json`));
    } catch {
      return { status: "failed", failReason: "读不到生图结果" };
    }
    if (!result) return { status: "running" };
    await forgetStaged(taskId);
    if (result.ok !== true || !Array.isArray(result.files) || result.files.length === 0) {
      return { status: "failed", failReason: result.error || "生图失败" };
    }
    if (result.files.some((name) => typeof name !== "string" || !/^[a-z0-9.-]+$/.test(name))) {
      return { status: "failed", failReason: "生成的文件名不合法" };
    }
    if (typeof result.warning === "string" && result.warning.trim()) {
      const sessionPath = await markDrift(sdk, ctx, result.warning);
      if (sessionPath) {
        driftSessions.add(sessionPath);
        holdExact = true;
        await saveDrift();
      }
    } else {
      await clearDrift(ctx);
    }
    return { status: "done", files: result.files };
  }

  await attachParameterSchemas(sdk);

  await sdk.media.registerAdapter({
    id: "image-url-fix",
    protocolId: "openai-images",
    name: "OpenAI image URL fix",
    types: ["image"],
    async checkAuth() {
      return { ok: true };
    },
    submit,
    query,
  });
  await sdk.logger.info("image-url-fix 已接管 openai-images");
});
