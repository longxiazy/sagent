import { describe, expect, it, vi } from 'vitest';
import { distillFetchContent } from '../agent/tools/browser/distill.ts';

function mockClient(content: string) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } }, create };
}

const LONG = '相关正文。'.repeat(400); // ~2000 字符,超过默认阈值

describe('distillFetchContent', () => {
  it('提炼长正文:调用模型、返回更短文本', async () => {
    const { client, create } = mockClient('要点:今日汇率 7.1。 https://www.pbc.gov.cn/rate');
    const out = await distillFetchContent({
      text: `${LONG}\n来源 https://www.pbc.gov.cn/rate`,
      url: 'https://www.pbc.gov.cn/rate',
      task: '查询今日汇率',
      client,
      model: 'nvidia/cheap',
    });
    expect(create).toHaveBeenCalledOnce();
    expect(out.length).toBeLessThan(LONG.length);
    expect(out).toContain('7.1');
  });

  it('把 task 注入进提炼 prompt', async () => {
    const { client, create } = mockClient('要点');
    await distillFetchContent({ text: LONG, task: '查询今日汇率', client, model: 'nvidia/cheap' });
    const prompt = create.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('任务:查询今日汇率');
    expect(prompt).toContain(LONG.slice(0, 50));
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
