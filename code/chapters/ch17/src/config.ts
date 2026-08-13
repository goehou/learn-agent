// 运行配置：从 .env 或显式映射读取 OpenAI 参数，并在创建网络客户端前集中完成缺失字段、URL 协议和 fallback 校验。
import { readFileSync } from "node:fs";

import { parse } from "dotenv";

// 三个字段是网络客户端创建前的硬性前置条件，缺失时不会生成半成品客户端。
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
