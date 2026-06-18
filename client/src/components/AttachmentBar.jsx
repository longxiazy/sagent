import { FileText, Image as ImageIcon, X, Loader2 } from 'lucide-react';
import { useT } from '../i18n/I18nProvider.jsx';

// 附件 chip 列表,放在 textarea 上方。
// 每个 attachment 形如:
//   { id, kind: 'image'|'file', name, mime, size, previewUrl?, path?, status: 'uploading'|'ready'|'error', error? }
// previewUrl 是前端本地的 data URL,只用于显示缩略图。
// path 是上传成功后服务端返回的绝对路径,会拼到任务文本里。
// 设计上 kind 字段独立可扩展;目前 image 显示缩略,其它显示文件 icon。
export function AttachmentBar({ attachments, onRemove }) {
  const t = useT();
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="attachment-bar">
      {attachments.map(att => {
        const isImage = att.kind === 'image' && att.previewUrl;
        return (
          <div
            key={att.id}
            className={`attachment-chip ${att.status} ${isImage ? 'is-image' : 'is-file'}`}
            title={att.error || att.name}
          >
            <div className="attachment-thumb">
              {isImage ? (
                <img src={att.previewUrl} alt={att.name} />
              ) : (
                <FileText size={20} />
              )}
              {att.status === 'uploading' && (
                <div className="attachment-overlay">
                  <Loader2 size={16} className="attachment-spin" />
                </div>
              )}
              {att.status === 'error' && (
                <div className="attachment-overlay error">!</div>
              )}
            </div>
            <div className="attachment-meta">
              <span className="attachment-name">
                {isImage ? null : <ImageIcon size={12} style={{ display: 'none' }} />}
                {att.name}
              </span>
              <span className="attachment-sub">
                {att.status === 'uploading' && t('attachBtn.uploading')}
                {att.status === 'ready' && formatSize(att.size)}
                {att.status === 'error' && (att.error || t('attachBar.failed'))}
              </span>
            </div>
            <button
              type="button"
              className="attachment-remove"
              onClick={() => onRemove(att.id)}
              title={t('attachBar.remove')}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
