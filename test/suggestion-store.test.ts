import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSuggestionDefaults } from '../helpers/suggestion-defaults.ts';
import { createSuggestionStore } from '../helpers/suggestion-store.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagent-suggestions-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('suggestion defaults', () => {
  it('falls back to the localized category structure when runtime data is missing', () => {
    expect(parseSuggestionDefaults(undefined, 'zh').agent.map(category => category.id)).toEqual([
      'life', 'work', 'dev', 'sys',
    ]);
    expect(parseSuggestionDefaults(undefined, 'en').agent.map(category => category.label)).toEqual([
      'Daily life', 'Work & office', 'Dev helpers', 'System',
    ]);
  });

  it('loads defaults without adding usage history', async () => {
    await fs.writeFile(path.join(tmpDir, 'suggestions.json'), JSON.stringify({
      defaults: { zh: { agent: [{ id: 'dev', label: '开发辅助', items: [
        { title: '失败诊断', text: '运行测试并定位根因' },
      ] }] } },
    }));

    await expect(createSuggestionStore(tmpDir).get('zh')).resolves.toEqual({
      agent: [{ id: 'dev', label: '开发辅助', items: [
        { title: '失败诊断', text: '运行测试并定位根因' },
      ] }],
    });
  });

  it('sanitizes runtime suggestion data', () => {
    expect(parseSuggestionDefaults({
      agent: [{ id: 'life', label: '生活查询', items: [
        { title: ' 天气决策 ', text: ' 核对两个天气来源 ' },
        { title: '', text: 'invalid' },
      ] }],
    }, 'zh')).toEqual({
      agent: [{ id: 'life', label: '生活查询', items: [
        { title: '天气决策', text: '核对两个天气来源' },
      ] }],
    });
  });
});
