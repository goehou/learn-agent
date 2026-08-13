// 模型配置：从环境变量映射或 .env 文件读取 OpenAI 兼容设置，并一次性校验缺失字段。
import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// 从环境变量或 .env 文件读取模型配置；一次性汇报全部缺失字段。
// 基础模型配置；后续章节可显式要求备用模型。
const requiredFields = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[], options?: ErrorOptions) {
    super(`Missing required settings: ${missingFields.join(", ")}`, options);
    this.missingFields = Object.freeze([...missingFields]);
  }
}

export interface OpenAISettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel?: string;
}

export function settingsFromMapping(
  mapping: Readonly<Record<string, string | undefined>>,
  requireFallback = false,
): OpenAISettings {
  const fields = requireFallback ? [...requiredFields, "OPENAI_FALLBACK_MODEL"] : requiredFields;
  // 先收集全部缺失字段，避免用户修复一个字段后才发现下一个字段。
  const missing = fields.filter((field) => {
    const value = mapping[field];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ConfigurationError(missing);
  }

  const baseUrl = mapping.OPENAI_BASE_URL;
  const apiKey = mapping.OPENAI_API_KEY;
  const model = mapping.OPENAI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    throw new Error("validated OpenAI settings are incomplete");
  }
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl.trim());
  } catch (error) {
    throw new ConfigurationError(["OPENAI_BASE_URL"], { cause: error });
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  // SDK 会附加 Chat Completions 路径；传入完整 endpoint 会导致请求路径重复。
  const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/chat/completions")) {
    throw new ConfigurationError(["OPENAI_BASE_URL"]);
  }
  const fallbackModel = mapping.OPENAI_FALLBACK_MODEL;
  // 返回冻结快照，防止配置在运行中被调用方重写。
  return Object.freeze({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    ...(fallbackModel === undefined || fallbackModel.trim().length === 0
      ? {}
      : { fallbackModel: fallbackModel.trim() }),
  });
}

export function settingsFromEnvFile(path: string, requireFallback = false): OpenAISettings {
  return settingsFromMapping(parse(readFileSync(path)), requireFallback);
}
