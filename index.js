import { defineApp } from "./sdk/app-contract/server-client.js";
import { expectedGptImage2Size, sizeMismatchWarning } from "./lib/expected-size.mjs";

export const name = "image-url-fix";

function bannerText(warning) {
  const body = warning.trim().replace(/\s+/g, " ");
  if (body.length <= 200) return body;
  return `${body.slice(0, 199)}…`;
}

function sessionPathOf(event, callbackSessionPath) {
  const task = event?.task;
  for (const value of [callbackSessionPath, task?.sessionPath, task?.sessionRef?.sessionPath]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function actualSizeOf(event, task) {
  const width = event?.imageWidth ?? task?.imageWidth;
  const height = event?.imageHeight ?? task?.imageHeight;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function requestedDimensions(task) {
  const params = task?.params;
  const resolved = params?.resolvedParameters;
  return {
    ratio: resolved?.ratio ?? params?.ratio,
    resolution: resolved?.resolution ?? params?.resolution,
  };
}

async function markDrift(sdk, sessionPath, warning) {
  const body = bannerText(warning);
  await sdk.logger.warn(body).catch(() => {});
  if (sessionPath && typeof sdk.inputBanner?.set === "function") {
    try {
      await sdk.inputBanner.set({ sessionPath, bannerId: "image-drift", text: body, buttons: [] });
      return true;
    } catch (error) {
      await sdk.logger.warn(`输入框上的差异没挂上：${error?.message || error}`).catch(() => {});
    }
  }
  try {
    await sdk.notifications.show({ title: "如实生图", body });
  } catch (error) {
    await sdk.logger.warn(`尺寸提醒没有弹出：${error?.message || error}`).catch(() => {});
  }
  return false;
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("如实生图已启动").catch(() => {});
  const bannerSessions = new Set();
  const seenTaskIds = new Set();

  try {
    await sdk.bus.subscribe(async (event, callbackSessionPath) => {
      await sdk.logger.info(JSON.stringify({
        type: event?.type ?? null,
        kind: event?.kind ?? null,
        hasTask: Boolean(event?.task),
        modelMatches: typeof event?.task?.modelId === "string" && event.task.modelId.startsWith("gpt-image-2"),
        imageWidthValid: Number.isFinite(event?.imageWidth) && event.imageWidth > 0,
        imageHeightValid: Number.isFinite(event?.imageHeight) && event.imageHeight > 0,
      })).catch(() => {});
      try {
        if (event?.type !== "media-gen:task-done") return;
        const task = event.task;
        if (!task || typeof task.modelId !== "string" || !task.modelId.startsWith("gpt-image-2")) return;
        if (task.protocolId && task.protocolId !== "openai-images") return;
        if ((event.kind ?? task.kind) != null && (event.kind ?? task.kind) !== "image") return;
        const taskId = task.taskId ?? task.id;
        if (taskId != null && seenTaskIds.has(taskId)) return;

        const { ratio, resolution } = requestedDimensions(task);
        let expected;
        try {
          expected = expectedGptImage2Size({ ratio, resolution });
        } catch (error) {
          await sdk.logger.warn(`gpt-image-2 尺寸参数无法核对：${error?.message || error}`).catch(() => {});
          return;
        }
        if (!expected) {
          await sdk.logger.warn("gpt-image-2 比例或分辨率缺失、为 auto 或无法解析，跳过尺寸核对").catch(() => {});
          return;
        }

        const actual = actualSizeOf(event, task);
        if (!actual) {
          await sdk.logger.warn(`gpt-image-2 尺寸核对跳过：任务 ${String(taskId ?? "未知")} 没有可用的实交边长`).catch(() => {});
          if (taskId != null) seenTaskIds.add(taskId);
          return;
        }
        if (taskId != null) seenTaskIds.add(taskId);

        const sessionPath = sessionPathOf(event, callbackSessionPath);
        const warning = sizeMismatchWarning(expected, actual);
        if (warning) {
          const bannerSet = await markDrift(sdk, sessionPath, warning);
          if (bannerSet) bannerSessions.add(sessionPath);
          return;
        }

        await sdk.logger.info(`gpt-image-2 尺寸核对通过：${expected.width}×${expected.height}`).catch(() => {});
        if (sessionPath && bannerSessions.has(sessionPath)) {
          try {
            await sdk.inputBanner.dismiss({ sessionPath, bannerId: "image-drift" });
            bannerSessions.delete(sessionPath);
          } catch (error) {
            await sdk.logger.warn(`输入框上的差异没撤下：${error?.message || error}`).catch(() => {});
          }
        }
      } catch (error) {
        await sdk.logger.warn(`图片尺寸核对失败：${error?.message || error}`).catch(() => {});
      }
    }, { types: ["media-gen:task-done"] });
    await sdk.logger.info("media-gen:task-done 订阅已挂上").catch(() => {});
  } catch (error) {
    await sdk.logger.warn(`media-gen:task-done 订阅没挂上：${error?.message || error}`).catch(() => {});
  }
});
