const FLEX_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
const FIXED_RATIOS = ["1:1", "3:2", "2:3"];
const DALLE_RATIOS = ["1:1", "16:9", "9:16"];

function choice(values, fallback, title) {
  return { type: "string", enum: [...values], default: fallback, title };
}

function mode(id, label, properties, defaults, referenceImages) {
  return {
    id,
    label,
    parameterSchema: { type: "object", properties },
    defaults,
    inputLimits: { referenceImages },
  };
}

function flexibleProperties() {
  return {
    ratio: choice(FLEX_RATIOS, "3:2", "比例"),
    resolution: choice(["1K", "2K", "4K"], "2K", "分辨率"),
    quality: choice(["auto", "low", "medium", "high"], "auto", "画质"),
    format: choice(["jpeg", "png", "webp"], "jpeg", "格式"),
    background: choice(["auto", "opaque", "transparent"], "auto", "背景"),
    output_compression: { type: "integer", minimum: 0, maximum: 100, title: "压缩" },
    moderation: choice(["auto", "low"], "auto", "审核"),
  };
}

function classicProperties() {
  return {
    ratio: choice(FIXED_RATIOS, "3:2", "比例"),
    size: choice(["auto", "1024x1024", "1536x1024", "1024x1536"], "1536x1024", "尺寸"),
    resolution: choice(["1K"], "1K", "分辨率"),
    quality: choice(["auto", "low", "medium", "high"], "auto", "画质"),
    format: choice(["jpeg", "png", "webp"], "jpeg", "格式"),
    background: choice(["auto", "opaque", "transparent"], "auto", "背景"),
    output_compression: { type: "integer", minimum: 0, maximum: 100, title: "压缩" },
    moderation: choice(["auto", "low"], "auto", "审核"),
  };
}

function dalleProperties() {
  return {
    ratio: choice(DALLE_RATIOS, "16:9", "比例"),
    size: choice(["1024x1024", "1792x1024", "1024x1792"], "1792x1024", "尺寸"),
    quality: choice(["standard", "hd"], "standard", "画质"),
    style: choice(["vivid", "natural"], "vivid", "风格"),
  };
}

function plain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function hasParameterSchema(model) {
  if (model?.parameterSchema?.properties) return true;
  return Array.isArray(model?.modes) && model.modes.some((item) => item?.parameterSchema?.properties);
}

export function isOpenAiImageModel(model) {
  const protocol = String(model?.protocolId || model?.protocol_id || "");
  if (protocol === "openai-images") return true;
  if (protocol && protocol !== "openai-images") return false;
  const id = String(model?.id || "").toLowerCase();
  return id.startsWith("gpt-image") || id.startsWith("dall-e");
}

export function needsOpenAiSchema(model) {
  return isOpenAiImageModel(model) && !hasParameterSchema(model);
}

function schemaFor(id) {
  const name = String(id || "").toLowerCase();
  if (name.startsWith("dall-e")) {
    const properties = dalleProperties();
    return {
      inputs: ["text"],
      outputs: ["image"],
      supportsEdit: false,
      ratios: DALLE_RATIOS,
      resolutions: ["1K"],
      modes: [mode("text2image", "文生图", properties, { ratio: "16:9", size: "1792x1024" }, { min: 0, max: 0 })],
    };
  }
  if (name.startsWith("gpt-image-1")) {
    const properties = classicProperties();
    const defaults = { ratio: "3:2", resolution: "1K" };
    return {
      inputs: ["text", "image"],
      outputs: ["image"],
      supportsEdit: true,
      ratios: FIXED_RATIOS,
      resolutions: ["1K"],
      modes: [
        mode("text2image", "文生图", properties, defaults, { min: 0, max: 0 }),
        mode("image2image", "改图", properties, defaults, { min: 1 }),
      ],
    };
  }
  const properties = flexibleProperties();
  const defaults = { ratio: "3:2", resolution: "2K" };
  return {
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    ratios: FLEX_RATIOS,
    resolutions: ["1K", "2K", "4K"],
    modes: [
      mode("text2image", "文生图", properties, defaults, { min: 0, max: 0 }),
      mode("image2image", "改图", properties, defaults, { min: 1 }),
    ],
  };
}

function schemaHasCount(model) {
  const schemas = [];
  if (model?.parameterSchema) schemas.push(model.parameterSchema);
  if (Array.isArray(model?.modes)) {
    for (const item of model.modes) {
      if (item?.parameterSchema) schemas.push(item.parameterSchema);
    }
  }
  return schemas.some((schema) => schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, "n"));
}

export function decorateImageModel(model, force = false) {
  const copy = plain(model) || {};
  if (!force && !needsOpenAiSchema(copy)) return copy;
  const schema = schemaFor(copy.id);
  return {
    ...copy,
    id: copy.id,
    displayName: copy.displayName || copy.name || copy.id,
    protocolId: "openai-images",
    ...schema,
  };
}

export function catalogPatch(model) {
  if (!isOpenAiImageModel(model)) return null;
  if (!needsOpenAiSchema(model) && !schemaHasCount(model)) return null;
  const decorated = decorateImageModel(model, true);
  return {
    displayName: decorated.displayName,
    protocolId: "openai-images",
    inputs: decorated.inputs,
    outputs: decorated.outputs,
    modes: decorated.modes,
  };
}

export function capabilitySnapshot(provider) {
  const models = (Array.isArray(provider?.models) ? provider.models : []).map((model) => decorateImageModel(model));
  const requested = typeof provider?.defaultModelId === "string" ? provider.defaultModelId.trim() : "";
  const defaultModelId = requested && models.some((model) => model.id === requested) ? requested : "";
  return {
    media: {
      image_generation: {
        ...(defaultModelId ? { defaultModelId } : {}),
        models,
      },
    },
  };
}
