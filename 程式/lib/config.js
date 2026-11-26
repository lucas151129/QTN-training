// 配置读取：config.json（若有）+ 环境变量覆盖
// 设计意图：把「AI 供应商」抽成可替换的一层，换模型只改配置，不改代码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  port: 8787,
  siteName: '小學科學科 · AI 批改作業平臺',
  dataDir: 'data',
  ai: {
    mode: 'auto',                       // auto | live | mock（auto：有 key 就真调，没有就本地模拟）
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',             // 文本模型
    visionModel: '',                    // 视觉模型（留空则图文题会自动标记「需老师覆核」）
    timeoutMs: 120000,
    maxTokens: 2500,
    temperature: 0.1,
    maxImagesPerSubmission: 6,
    maxImageBytes: 4 * 1024 * 1024
  }
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let cfg = structuredClone(DEFAULTS);
  if (fs.existsSync(file)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      console.warn('[config] config.json 解析失败，改用默认配置：' + e.message);
    }
  }

  const env = process.env;
  // 模板里的占位文字不能被当成真的 key，否则会误判成「已配置」而一直报错
  if (/貼上|填入|your[_-]?key|xxx/i.test(cfg.ai.apiKey)) cfg.ai.apiKey = '';
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.DATA_DIR) cfg.dataDir = env.DATA_DIR;
  if (env.SITE_NAME) cfg.siteName = env.SITE_NAME;
  if (env.AI_API_KEY) cfg.ai.apiKey = env.AI_API_KEY;
  if (env.AI_BASE_URL) cfg.ai.baseUrl = env.AI_BASE_URL;
  if (env.AI_MODEL) cfg.ai.model = env.AI_MODEL;
  if (env.AI_VISION_MODEL) cfg.ai.visionModel = env.AI_VISION_MODEL;
  if (env.AI_MODE) cfg.ai.mode = env.AI_MODE;

  // 计算实际生效模式，并在启动时打印一次，避免「以为是 AI，其实是模拟」
  const hasKey = Boolean(cfg.ai.apiKey);
  cfg.ai.effectiveMode = cfg.ai.mode === 'mock' ? 'mock' : (hasKey ? 'live' : 'mock');
  cfg.ai.modelLabel = cfg.ai.effectiveMode === 'live' ? cfg.ai.model : '本地模拟（未配置 API Key）';
  cfg.dataPath = path.isAbsolute(cfg.dataDir) ? cfg.dataDir : path.join(ROOT, cfg.dataDir);
  cfg.uploadPath = path.join(cfg.dataPath, 'uploads');
  cfg.dbPath = path.join(cfg.dataPath, 'app.db');
  return cfg;
}
