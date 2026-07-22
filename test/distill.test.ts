import { describe, expect, it, vi } from 'vitest';
import { distillFetchContent } from '../agent/tools/browser/distill.ts';

function mockClient(content: string) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } }, create };
}

const LONG = '相关正文。'.repeat(400); // ~2000 字符,超过默认阈值

describe('distillFetchContent', () => {
  it('提炼长正文:调用模型、步骤结果只返回 Distill 摘要', async () => {
    const { client, create } = mockClient('要点:今日汇率 7.1。 https://www.pbc.gov.cn/rate');
    const out = await distillFetchContent({
      text: `${LONG}\n来源 https://www.pbc.gov.cn/rate`,
      url: 'https://www.pbc.gov.cn/rate',
      task: '查询今日汇率',
      client,
      model: 'nvidia/cheap',
    });
    expect(create).toHaveBeenCalledOnce();
    expect(out).not.toContain(LONG);
    expect(out).toContain('7.1');
    expect(out.length).toBeLessThan(LONG.length);
  });

  it('把 task 注入进提炼 prompt', async () => {
    const { client, create } = mockClient('要点');
    await distillFetchContent({
      text: LONG,
      url: 'https://example.com/rate',
      task: '查询今日汇率',
      client,
      model: 'nvidia/cheap',
    });
    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('<用户任务>\n查询今日汇率\n</用户任务>');
    expect(prompt).toContain('来源页面：https://example.com/rate');
    expect(prompt).toContain(LONG.slice(0, 50));
  });

  it('约束 Distill 只提取当前网页证据,不代替 Agent 完成多来源任务', async () => {
    const { client, create } = mockClient('要点');
    await distillFetchContent({
      text: LONG,
      url: 'https://lmmarketcap.com/zh/new-ai-models',
      task: '围绕最新 AI 模型发布，找出五个信息源并评级',
      client,
      model: 'nvidia/cheap',
    });
    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('当前输入只代表一个网页来源');
    expect(prompt).toContain('不要在本次输出中完成整个任务');
    expect(prompt).toContain('不要把正文里的模型、厂商、人物、栏目或数据条目重新解释成多个“信息源”');
    expect(prompt).toContain('禁止输出分析过程');
    expect(prompt).toContain('Thinking Process');
    expect(prompt).toContain('控制在 8 个要点以内');
  });

  it('保留所有来源 URL:提炼结果丢了 URL 时补回', async () => {
    // 模型输出不含任何 URL
    const { client } = mockClient('要点:汇率 7.1,无链接');
    const out = await distillFetchContent({
      text: `${LONG}\nhttps://www.pbc.gov.cn/rate 和 https://www.safe.gov.cn/data`,
      url: 'https://www.pbc.gov.cn/rate',
      client,
      model: 'nvidia/cheap',
    });
    expect(out).toContain('https://www.pbc.gov.cn/rate');
    expect(out).toContain('https://www.safe.gov.cn/data');
  });

  it('提炼结果已含 URL 时不重复补', async () => {
    const { client } = mockClient('要点 https://www.pbc.gov.cn/rate');
    const out = await distillFetchContent({
      text: `${LONG}\nhttps://www.pbc.gov.cn/rate`,
      url: 'https://www.pbc.gov.cn/rate',
      client,
      model: 'nvidia/cheap',
    });
    expect(out).not.toContain('来源:');
    expect((out.match(/pbc\.gov\.cn/g) || []).length).toBe(1);
  });

  it('短正文直接返回,不调用模型', async () => {
    const { client, create } = mockClient('不该被调用');
    const short = '很短的正文';
    const out = await distillFetchContent({ text: short, client, model: 'nvidia/cheap' });
    expect(out).toBe(short);
    expect(create).not.toHaveBeenCalled();
  });

  it('正文达到 120 字符时触发提炼', async () => {
    const { client, create } = mockClient('要点');
    await distillFetchContent({ text: 'x'.repeat(120), client, model: 'nvidia/cheap' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('未配置 client/model 时原样返回', async () => {
    expect(await distillFetchContent({ text: LONG, model: 'nvidia/cheap' })).toBe(LONG);
    const { client } = mockClient('x');
    expect(await distillFetchContent({ text: LONG, client })).toBe(LONG);
  });

  it('模型抛错时回退原文,不抛出', async () => {
    const create = vi.fn().mockRejectedValue(new Error('502 upstream'));
    const client = { chat: { completions: { create } } };
    const out = await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(out).toBe(LONG);
  });

  it('空输出回退原文', async () => {
    const { client } = mockClient('   ');
    const out = await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(out).toBe(LONG);
  });

  it('原样保留成对 <think>…</think>', async () => {
    const { client } = mockClient('<think>让我想想该提哪些</think>要点:汇率 7.1');
    const out = await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(out).not.toContain(LONG);
    expect(out).toContain('要点:汇率 7.1');
    expect(out).toContain('<think>让我想想该提哪些</think>');
  });

  it('原样保留被截断的未闭合 <think>', async () => {
    const { client } = mockClient('要点:汇率 7.1\n<think>接着我再想想有没有别的');
    const out = await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(out).not.toContain(LONG);
    expect(out).toContain('要点:汇率 7.1');
    expect(out).toContain('<think>接着我再想想有没有别的');
  });

  it('原样保留裸露思考链(Thinking Process:)', async () => {
    const { client } = mockClient('Thinking Process: 1. Analyze the Request. The prompt is ambiguous...');
    const out = await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(out).not.toContain(LONG);
    expect(out).toContain('Thinking Process: 1. Analyze the Request. The prompt is ambiguous...');
  });

  it('原样保留整段未闭合 <think>', async () => {
    const { client } = mockClient('<think>1. 分析请求 2. 该提哪些要点呢(输出被截断');
    const out = await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(out).not.toContain(LONG);
    expect(out).toContain('<think>1. 分析请求 2. 该提哪些要点呢(输出被截断');
  });

  it('max_tokens 留足空间容纳推理+正文', async () => {
    const { client, create } = mockClient('要点');
    await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap' });
    expect(create.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(800);
  });

  it('取消信号向上传播(不静默回退)', async () => {
    const ac = new AbortController();
    ac.abort();
    const create = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
    const client = { chat: { completions: { create } } };
    await expect(
      distillFetchContent({ text: LONG, client, model: 'nvidia/cheap', signal: ac.signal }),
    ).rejects.toThrow();
  });

  it('signal 透传给 create 的第二参数', async () => {
    const ac = new AbortController();
    const { client, create } = mockClient('要点');
    await distillFetchContent({ text: LONG, client, model: 'nvidia/cheap', signal: ac.signal });
    expect(create.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });
});
