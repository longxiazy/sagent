import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSearchAction } from '../agent/tools/search/execute.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchHtml(html: string, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status: ok ? 200 : 503,
    statusText: ok ? 'OK' : 'Service Unavailable',
    text: async () => html,
  })));
}

describe('search tool', () => {
  it('returns structured failure when DuckDuckGo shows a challenge page', async () => {
    stubFetchHtml('<form class="challenge-form"></form>');

    const result: any = await executeSearchAction({ type: 'web_search', query: 'A股收盘行情' });

    expect(result).toMatchObject({
      resultStatus: 'failed',
      resultError: 'DuckDuckGo 触发反爬验证',
    });
    expect(result.result).toContain('web_search 失败');
  });

  it('keeps successful search results as plain content', async () => {
    stubFetchHtml(`
      <a class="result-link" href="https://example.com/a">Example A</a>
      <td class="result-snippet">Snippet A</td>
    `);

    const result = await executeSearchAction({ type: 'web_search', query: 'Example' });

    expect(result).toContain('web_search 结果');
    expect(result).toContain('Example A');
  });
});
