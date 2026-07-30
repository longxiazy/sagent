import { extractScreenshots, splitAssistantContent } from '../utils/markdown.js';
import { parseTaskAttachments } from '../utils/attachments.js';
import { MarkdownBlock } from './markdown/MarkdownBlock.jsx';
import { ThinkBlock } from './markdown/ThinkBlock.jsx';
import { ScreenshotImages } from './ScreenshotImages.jsx';
import { MessageAttachments } from './MessageAttachments.jsx';

// 用户消息直接原样展示；助手消息则需要经过：
// 1. 提取截图
// 2. 拆分 think 片段
// 3. 再按 markdown 渲染
// 这样能兼容普通回答、带思考的回答、以及带桌面截图的 Agent 结果。
export function MessageContent({ role, content, showCursor, projectId = null }) {
  if (role === 'user') {
    // 发给模型的任务文本里带一段 [附件] 块，展示时把它换成缩略图：
    // 那段文本是给模型看的，用户看到的应该是自己发出的图。
    const { text, attachments } = parseTaskAttachments(content);
    return (
      <>
        {text && <span>{text}</span>}
        <MessageAttachments attachments={attachments} projectId={projectId} />
      </>
    );
  }

  const { cleaned, screenshots } = extractScreenshots(content);
  const displayContent = cleaned || content;

  const segments = splitAssistantContent(displayContent);
  const hasThink = segments.some(segment => segment.type === 'think');

  const textBlock = !hasThink
    ? <MarkdownBlock content={displayContent} showCursor={showCursor} />
    : (
      <div className="assistant-sections">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          if (segment.type === 'think') {
            return <ThinkBlock key={`think-${index}`} content={segment.content} closed={segment.closed} showCursor={showCursor && isLast} />;
          }
          return (
            <div key={`markdown-${index}`} className="assistant-answer">
              <MarkdownBlock content={segment.content} showCursor={showCursor && isLast} />
            </div>
          );
        })}
      </div>
    );

  return (
    <>
      {textBlock}
      <ScreenshotImages urls={screenshots} />
    </>
  );
}
