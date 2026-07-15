import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'config/model-catalog/nvidia.json');
const BASE = 'https://build.nvidia.com';
const CONCURRENCY = 8;

function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function parseCatalogItems(markdown) {
  const items = [];
  const re = /^- \[([^\]]+)\]\(([^)]+)\) — (.*)$/gm;
  let match;
  while ((match = re.exec(markdown))) {
    items.push({
      title: normalizeWhitespace(match[1]),
      href: match[2],
      summary: normalizeWhitespace(match[3]),
    });
  }
  return items;
}

function parseNextPage(markdown) {
  const match = markdown.match(/Fetch \/models\.md\?page=(\d+) for the next/i);
  return match ? Number(match[1]) : null;
}

function canonicalId(frontmatter, item) {
  if (frontmatter.canonical) {
    const url = new URL(frontmatter.canonical);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts.at(-2)}/${parts.at(-1)}`;
  }
  if (frontmatter.publisher && frontmatter.title) return `${frontmatter.publisher}/${frontmatter.title}`;
  const href = item.href.replace(/\.md$/, '');
  const slug = href.split('/').filter(Boolean).at(-1);
  return slug ? `${frontmatter.publisher || 'unknown'}/${slug}` : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeIdAlias(value) {
  return String(value || '')
    .trim()
    .replace(/\.md$/, '')
    .replace(/_/g, '.')
    .toLowerCase();
}

function modelAliases(id, frontmatter, item) {
  const publisher = frontmatter.publisher || id?.split('/')[0];
  const hrefSlug = item.href.replace(/\.md$/, '').split('/').filter(Boolean).at(-1);
  const titleSlug = String(frontmatter.title || item.title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return unique([
    id,
    normalizeIdAlias(id),
    publisher && hrefSlug ? `${publisher}/${hrefSlug}` : null,
    publisher && hrefSlug ? normalizeIdAlias(`${publisher}/${hrefSlug}`) : null,
    publisher && titleSlug ? `${publisher}/${titleSlug}` : null,
    publisher && titleSlug ? normalizeIdAlias(`${publisher}/${titleSlug}`) : null,
  ]);
}

function parseTokenCount(value) {
  const text = String(value || '').toLowerCase();
  const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(m|million|k|thousand)?(?:[- ]?token| tokens)?/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] || '';
  if (unit === 'm' || unit === 'million') return Math.round(n * 1_000_000);
  if (unit === 'k' || unit === 'thousand') return Math.round(n * 1_000);
  return Math.round(n);
}

export function findContextWindow(markdown) {
  const candidates = [
    /\|\s*\*\*Context Length\*\*\s*\|\s*([^|\n]+)\|/i,
    /\*\*Context Length:\*\*\s*([^\n]+)/i,
    /Maximum context length(?: of| up to)?\s+([^.\n]+)/i,
    /Context length:\s*([^.\n]+)/i,
    /up to\s+(\d+(?:\.\d+)?\s*(?:m|million|k|thousand)?)[- ]?token context/i,
    /(\d+(?:\.\d+)?\s*(?:m|million|k|thousand))[- ]?token context/i,
  ];
  for (const re of candidates) {
    const match = markdown.match(re);
    const tokens = parseTokenCount(match?.[1]);
    if (tokens) return tokens;
  }
  return undefined;
}

function parseFieldList(markdown, labels) {
  for (const label of labels) {
    const patterns = [
      new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`, 'i'),
      new RegExp(`- \\*\\*${label}:\\*\\*\\s*([^\\n]+)`, 'i'),
      new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*([^|\\n]+)\\|`, 'i'),
    ];
    for (const re of patterns) {
      const match = markdown.match(re);
      if (!match) continue;
      return normalizeWhitespace(match[1])
        .split(/,|;| and |\+/i)
        .map(item => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function normalizeModality(value) {
  const text = String(value || '').toLowerCase();
  if (/image|img|visual|vision/.test(text)) return 'image';
  if (/video/.test(text)) return 'video';
  if (/audio|speech|voice/.test(text)) return 'audio';
  if (/text|string|sequence|language/.test(text)) return 'text';
  return text.replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeModalities(items) {
  const modalities = new Set();
  for (const item of items) {
    const modality = normalizeModality(item);
    if (modality) modalities.add(modality);
  }
  return [...modalities];
}

function capabilitiesFromMarkdown(markdown) {
  const capabilities = new Set(['chat.completions']);
  const params = new Set(['temperature', 'top_p', 'max_tokens', 'stream']);
  if (/tool calling|function\/tool calling|function calling|tool use|tool-call/i.test(markdown)) {
    capabilities.add('tool_calling');
    params.add('tools');
  }
  if (/structured json|json output|structured output/i.test(markdown)) {
    capabilities.add('json_output');
    params.add('response_format');
  }
  if (/reasoning_content|reasoning trace|reasoning mode|enable_thinking|thinking/i.test(markdown)) {
    capabilities.add('reasoning');
    params.add('chat_template_kwargs');
  }
  return { capabilities: [...capabilities], params: [...params] };
}

function parseDetail(markdown, item) {
  const frontmatter = parseFrontmatter(markdown);
  const id = canonicalId(frontmatter, item);
  if (!id) return null;

  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  const label = normalizeWhitespace(frontmatter.title || item.title || heading);
  const inputModalities = normalizeModalities(parseFieldList(markdown, [
    'Input Type\\(s\\)',
    'Input Types',
    'Input Type',
  ]));
  const outputModalities = normalizeModalities(parseFieldList(markdown, [
    'Output Type\\(s\\)',
    'Output Types',
    'Output Type',
  ]));
  const { capabilities, params } = capabilitiesFromMarkdown(markdown);
  for (const modality of [...inputModalities, ...outputModalities]) {
    if (['image', 'video', 'audio'].includes(modality) && !capabilities.includes(modality)) {
      capabilities.push(modality);
    }
  }
  const contextWindow = findContextWindow(markdown);

  return {
    id,
    aliases: modelAliases(id, frontmatter, item),
    label,
    publisher: frontmatter.publisher || id.split('/')[0],
    description: frontmatter.description || item.summary,
    catalogUrl: frontmatter.canonical || `${BASE}${item.href.replace(/\.md$/, '')}`,
    contextWindow,
    inputModalities: inputModalities.length ? inputModalities : undefined,
    outputModalities: outputModalities.length ? outputModalities : undefined,
    supportedGenerationMethods: capabilities,
    supportedMessageTypes: inputModalities.length ? inputModalities : undefined,
    supportedParameters: params,
    updated: frontmatter.updated,
  };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function collectCatalogItems() {
  const all = [];
  let page = 1;
  for (;;) {
    const url = page === 1 ? `${BASE}/models.md` : `${BASE}/models.md?page=${page}`;
    const markdown = await fetchText(url);
    all.push(...parseCatalogItems(markdown));
    const next = parseNextPage(markdown);
    if (!next || next <= page) break;
    page = next;
  }
  const byHref = new Map();
  for (const item of all) byHref.set(item.href, item);
  return [...byHref.values()];
}

async function mapConcurrent(items, mapper) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0))
      .map(([key, item]) => [key, stripUndefined(item)])
  );
}

async function main() {
  const items = await collectCatalogItems();
  const details = await mapConcurrent(items, async item => {
    try {
      const markdown = await fetchText(`${BASE}${item.href}`);
      return parseDetail(markdown, item);
    } catch (err) {
      return {
        id: null,
        error: err.message,
        title: item.title,
        href: item.href,
      };
    }
  });

  const models = {};
  const errors = [];
  for (const detail of details) {
    if (!detail?.id) {
      errors.push(detail);
      continue;
    }
    models[detail.id] = stripUndefined(detail);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      catalog: `${BASE}/models.md`,
      note: 'Generated by scripts/fetch-nvidia-model-catalog.mjs from public build.nvidia.com markdown pages.',
    },
    count: Object.keys(models).length,
    models,
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(ROOT, OUTPUT), count: payload.count, errors: errors.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
