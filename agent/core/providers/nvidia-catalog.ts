import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelInfo } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(__dirname, '../../../config/model-catalog/nvidia.json');

let cachedCatalog: Map<string, Partial<ModelInfo>> | null = null;

function normalizeAlias(value: string) {
  return String(value || '').trim().replace(/_/g, '.').toLowerCase();
}

function sanitizeCatalogModel(model: any): Partial<ModelInfo> {
  const out: Partial<ModelInfo> = {};
  if (typeof model?.label === 'string' && model.label.trim()) out.label = model.label.trim();
  if (typeof model?.description === 'string' && model.description.trim()) out.description = model.description.trim();
  if (typeof model?.catalogUrl === 'string' && model.catalogUrl.trim()) out.catalogUrl = model.catalogUrl.trim();
  if (typeof model?.publisher === 'string' && model.publisher.trim()) out.publisher = model.publisher.trim();
  if (Number.isFinite(Number(model?.contextWindow)) && Number(model.contextWindow) > 0) out.contextWindow = Number(model.contextWindow);
  if (Array.isArray(model?.inputModalities)) out.inputModalities = model.inputModalities;
  if (Array.isArray(model?.outputModalities)) out.outputModalities = model.outputModalities;
  if (Array.isArray(model?.supportedGenerationMethods)) out.supportedGenerationMethods = model.supportedGenerationMethods;
  if (Array.isArray(model?.supportedMessageRoles)) out.supportedMessageRoles = model.supportedMessageRoles;
  if (Array.isArray(model?.supportedMessageTypes)) out.supportedMessageTypes = model.supportedMessageTypes;
  if (Array.isArray(model?.supportedParameters)) out.supportedParameters = model.supportedParameters;
  return out;
}

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = new Map();
  if (!fs.existsSync(CATALOG_PATH)) return cachedCatalog;

  const payload = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const models = payload?.models && typeof payload.models === 'object' ? payload.models : {};
  for (const model of Object.values(models) as any[]) {
    const metadata = sanitizeCatalogModel(model);
    const aliases = [model?.id, ...(Array.isArray(model?.aliases) ? model.aliases : [])];
    for (const alias of aliases) {
      if (typeof alias === 'string' && alias.trim()) {
        cachedCatalog.set(normalizeAlias(alias), metadata);
      }
    }
  }
  return cachedCatalog;
}

export function getNvidiaCatalogModelMetadata(modelId: string): Partial<ModelInfo> {
  return loadCatalog().get(normalizeAlias(modelId)) || {};
}
