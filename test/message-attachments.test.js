import { describe, expect, it } from 'vitest';
import { parseTaskAttachments, buildUploadUrl } from '../client/src/utils/attachments.js';

// 与 App.jsx 的 buildTaskWithAttachments 保持一致的构造方式，
// 中英文模板对括号前是否留空格的处理不同，两种都要覆盖。
function zhTask(text, ...paths) {
  const lines = ['[附件]', ...paths.map(p => `- 图片: ${p}(请用 image_analyze 工具分析)`)];
  return text ? `${text}\n\n${lines.join('\n')}` : lines.join('\n');
}

function enTask(text, ...paths) {
  const lines = ['[Attachments]', ...paths.map(p => `- Image: ${p} (analyze with the image_analyze tool)`)];
  return text ? `${text}\n\n${lines.join('\n')}` : lines.join('\n');
}

const IMAGE = '@uploads/2026-07-30/1785413794376-53bde5-origin_202607261135018316.jpg';

describe('parseTaskAttachments', () => {
  it('strips the attachment block from a Chinese task', () => {
    const { text, attachments } = parseTaskAttachments(zhTask('把图片转成文字', IMAGE));

    expect(text).toBe('把图片转成文字');
    expect(attachments).toEqual([{
      path: IMAGE,
      date: '2026-07-30',
      file: '1785413794376-53bde5-origin_202607261135018316.jpg',
      name: 'origin_202607261135018316.jpg',
    }]);
  });

  it('strips the attachment block from an English task', () => {
    const { text, attachments } = parseTaskAttachments(enTask('Convert to text', IMAGE));

    expect(text).toBe('Convert to text');
    expect(attachments.map(a => a.name)).toEqual(['origin_202607261135018316.jpg']);
  });

  it('keeps every image when several are attached', () => {
    const second = '@uploads/2026-07-30/1785413794377-aabbcc-second.png';
    const { text, attachments } = parseTaskAttachments(zhTask('比较这两张图', IMAGE, second));

    expect(text).toBe('比较这两张图');
    expect(attachments.map(a => a.name)).toEqual(['origin_202607261135018316.jpg', 'second.png']);
  });

  it('deduplicates the same path attached twice', () => {
    const { attachments } = parseTaskAttachments(zhTask('看图', IMAGE, IMAGE));
    expect(attachments).toHaveLength(1);
  });

  it('drops the block header when the task carries attachments only', () => {
    const { text, attachments } = parseTaskAttachments(zhTask('', IMAGE));

    expect(text).toBe('');
    expect(attachments).toHaveLength(1);
  });

  it('leaves an upload path mentioned inside prose untouched', () => {
    const prose = `为什么 ${IMAGE} 这个文件读不出来？`;
    const { text, attachments } = parseTaskAttachments(prose);

    expect(text).toBe(prose);
    expect(attachments).toEqual([]);
  });

  it('returns the original text when there is no attachment', () => {
    const { text, attachments } = parseTaskAttachments('你好，帮我写个函数');

    expect(text).toBe('你好，帮我写个函数');
    expect(attachments).toEqual([]);
  });

  it('also recognises non-image attachment lines', () => {
    const doc = '@uploads/2026-07-30/1785413794376-53bde5-report.pdf';
    const { text, attachments } = parseTaskAttachments(`看下\n\n[附件]\n- 文件: ${doc}(application/pdf)`);

    expect(text).toBe('看下');
    expect(attachments.map(a => a.name)).toEqual(['report.pdf']);
  });

  it('tolerates non-string input', () => {
    expect(parseTaskAttachments(null)).toEqual({ text: '', attachments: [] });
    expect(parseTaskAttachments(undefined)).toEqual({ text: '', attachments: [] });
  });
});

describe('buildUploadUrl', () => {
  it('maps a virtual path onto the read endpoint and scopes it to the project', () => {
    expect(buildUploadUrl(IMAGE, 'proj_abc'))
      .toBe('/api/uploads/2026-07-30/1785413794376-53bde5-origin_202607261135018316.jpg?projectId=proj_abc');
  });

  it('omits the project query when the session has no project', () => {
    expect(buildUploadUrl(IMAGE, null))
      .toBe('/api/uploads/2026-07-30/1785413794376-53bde5-origin_202607261135018316.jpg');
  });

  it('returns null for anything that is not an upload path', () => {
    expect(buildUploadUrl('/etc/passwd', null)).toBeNull();
    expect(buildUploadUrl('', null)).toBeNull();
  });
});
