import { useState } from 'react';
import { FileText } from 'lucide-react';
import { buildUploadUrl } from '../utils/attachments.js';
import { useT } from '../i18n/I18nProvider.jsx';

// 聊天记录里用户消息的附件缩略图。
//
// 附件信息是从消息文本里解析出来的（见 utils/attachments.js），因为消息对象只
// 持久化 content 字符串，上传时的元数据在发送后就没有了。
//
// 视觉上沿用输入框上方 AttachmentBar 的 chip 类名，让「发送前」与「发送后」看起来
// 是同一个东西；点开大图复用 AgentPanel 已有的 lightbox 类名。lightbox 状态是
// AgentPanel 私有的，这里自己持有一份。
//
// projectId 应传会话自身的项目而非当前激活项目：附件按项目分目录存放，
// 切换项目后回看历史会话时，仍要按写入时的项目去取图。
export function MessageAttachments({ attachments, projectId }) {
  const t = useT();
  const [lightboxSrc, setLightboxSrc] = useState(null);
  // 图片取不回来时（文件已清理、跨项目等）退回文件图标，不留破图。
  const [failed, setFailed] = useState(() => new Set());

  if (!attachments || attachments.length === 0) return null;

  const markFailed = path => setFailed(prev => new Set(prev).add(path));

  return (
    <>
      <div className="attachment-bar message-attachments">
        {attachments.map(att => {
          const url = buildUploadUrl(att.path, projectId);
          const showImage = url && !failed.has(att.path);
          return (
            <div
              key={att.path}
              className={`attachment-chip ready ${showImage ? 'is-image' : 'is-file'}`}
              title={att.name}
            >
              <div className="attachment-thumb">
                {showImage ? (
                  <img
                    src={url}
                    alt={att.name}
                    className="clickable"
                    onClick={() => setLightboxSrc(url)}
                    onError={() => markFailed(att.path)}
                  />
                ) : (
                  <FileText size={20} />
                )}
              </div>
              <div className="attachment-meta">
                <span className="attachment-name">{att.name}</span>
                {!showImage && (
                  <span className="attachment-sub">{t('attachBar.unavailable')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {lightboxSrc && (
        <div className="screenshot-lightbox" onClick={() => setLightboxSrc(null)}>
          <img className="screenshot-lightbox-img" src={lightboxSrc} alt="" />
        </div>
      )}
    </>
  );
}
