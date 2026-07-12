import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelInfo } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.resolve(__dirname, '../../../config/model-catalog/gemini-overrides.json');

let cachedOverrides: Map<string, Partial<ModelInfo>> | null = null;

function normalizeModelId(value: string) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeOverride(model: any): Partial<ModelInfo> {
  const out: Partial<ModelInfo> = {};
  if (Array.isArray(model?.aliases)) out.aliases = model.aliases.filter((item: any) => typeof item === 'string' && item.trim());
  if (typeof model?.label === 'string' && model.label.trim()) out.label = model.label.trim();
  if (typeof model?.description === 'string' && model.description.trim()) out.description = model.description.trim();
  if (typeof model?.catalogUrl === 'string' && model.catalogUrl.trim()) out.catalogUrl = model.catalogUrl.trim();
  if (typeof model?.publisher === 'string' && model.publisher.trim()) out.publisher = model.publisher.trim();
  if (typeof model?.updated === 'string' && model.updated.trim()) out.updated = model.updated.trim();
  if (Number.isFinite(Number(model?.contextWindow)) && Number(model.contextWindow) > 0) out.contextWindow = Number(model.contextWindow);
  if (Array.isArray(model?.inputModalities)) out.inputModalities = model.inputModalities;
  if (Array.isArray(model?.outputModalities)) out.outputModalities = model.outputModalities;
  if (Array.isArray(model?.supportedGenerationMethods)) out.supportedGenerationMethods = model.supportedGenerationMethods;
  if (Array.isArray(model?.supportedMessageRoles)) out.supportedMessageRoles = model.supportedMessageRoles;
  if (Array.isArray(model?.supportedMessageTypes)) out.supportedMessageTypes = model.supportedMessageTypes;
  if (Array.isArray(model?.supportedParameters)) out.supportedParameters = model.supportedParameters;
  if (typeof model?.agentCompatible === 'boolean') out.agentCompatible = model.agentCompatible;
  return out;
}

function loadOverrides() {
  if (cachedOverrides) return cachedOverrides;
  cachedOverrides = new Map();
  if (!fs.existsSync(OVERRIDES_PATH)) return cachedOverrides;

  const payload = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  const models = payload?.models && typeof payload.models === 'object' ? payload.models : {};
  for (const [id, model] of Object.entries(models) as Array<[string, any]>) {
    const metadata = sanitizeOverride(model);
    const aliases = [id, ...(Array.isArray(model?.aliases) ? model.aliases : [])];
    for (const alias of aliases) {
      if (typeof alias === 'string' && alias.trim()) {
        cachedOverrides.set(normalizeModelId(alias), metadata);
      }
    }
  }
  return cachedOverrides;
}

export function getGeminiCatalogModelMetadata(modelId: string): Partial<ModelInfo> {
  return loadOverrides().get(normalizeModelId(modelId)) || {};
}
