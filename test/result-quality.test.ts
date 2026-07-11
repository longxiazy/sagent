import { describe, expect, it } from 'vitest';
import { assessResultQuality } from '../agent/core/result-quality.ts';

describe('result quality assessment', () => {
  it('treats WAF and captcha pages as failed steps', () => {
    const quality = assessResultQuality({
      task: '搜索杭州必去的十大景点及门票价格',
      steps: [
        {
          step: 1,
          rationale: 'fetch',
          action: { tool: 'browser', type: 'http_fetch', url: 'https://example.com', extractLinks: false },
          result: '您的请求已中断 Web应用防护服务检测您当前访问存在Web安全风险',
        },
        {
          step: 2,
          rationale: 'read',
          action: { tool: 'browser', type: 'get_page_content' },
          result: '百度安全验证 请完成下方验证后继续操作 拖动左侧滑块使图片为正',
        },
      ],
      answer: 'done',
    });

    expect(quality.status).toBe('done_degraded');
    expect(quality.failure_steps).toEqual([1, 2]);
  });

  it('prefers structured resultStatus over failure keywords for new traces', () => {
    const quality = assessResultQuality({
      task: '检查代码问题',
      steps: [
        {
          step: 1,
          rationale: 'search',
          action: { tool: 'fs', type: 'search_files', query: 'error', path: '.', include: '*', maxResults: 20 },
          result: '未找到明显问题',
          resultStatus: 'success',
        },
        {
          step: 2,
          rationale: 'run',
          action: { tool: 'terminal', type: 'run_safe', command: 'pwd', cwd: '', timeoutMs: 8000 },
          result: 'command exited without details',
          resultStatus: 'failed',
          resultError: 'exit code 1',
        },
      ],
      answer: '完成',
    });

    expect(quality.status).toBe('done_degraded');
    expect(quality.failure_steps).toEqual([2]);
  });

  it('uses nested action arguments URL when checking official sources', () => {
    const quality = assessResultQuality({
      task: '查询医保政策',
      steps: [
        {
          step: 1,
          rationale: 'navigate',
          action: {
            tool: 'chrome',
            type: 'chrome_call_tool',
            toolName: 'navigate_page',
            arguments: { url: 'https://www.gov.cn/zhengce/example.html' },
            refreshTools: false,
          },
          result: '这里是政策正文，包含足够多的可用内容用于判断来源有效。这里继续补充政策适用范围、办理条件、材料要求、办理流程、办理时限、责任部门和注意事项，确保内容长度超过最低可用阈值。',
        },
      ],
      answer: '已根据官方页面回答',
    });

    expect(quality.unverified).toBe(false);
    expect(quality.official_source_steps).toEqual([1]);
  });
});
