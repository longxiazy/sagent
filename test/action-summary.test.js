import { describe, expect, it } from 'vitest';
import { actionTitle, summarizeAction } from '../client/src/components/agent/action-summary.js';

describe('agent action summary', () => {
  it('uses the human-readable rationale as the trace title', () => {
    const action = {
      tool: 'fs',
      type: 'read_file',
      path: '/Users/admin/Documents/wechat/package.json',
    };

    expect(summarizeAction(action, '读取 package.json 文件以获取依赖信息'))
      .toBe('读取 package.json 文件以获取依赖信息');
  });

  it('uses a natural-language fallback without exposing the tool identifier', () => {
    const action = { tool: 'fs', type: 'read_file', path: '/tmp/project/package.json' };

    expect(summarizeAction(action)).toBe('读取 package.json');
    expect(summarizeAction(action)).not.toContain('fs.read_file');
    expect(actionTitle(action)).toBe('fs.read_file');
  });
});
