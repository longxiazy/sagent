import { useRef } from 'react';
import { Paperclip } from 'lucide-react';

// 输入栏左侧的"+ 附件"按钮。隐藏的 input[type=file] 通过 ref 触发。
// accept 默认是图片,以后可以扩展更多类型;multiple=true 一次性多选。
// 状态:uploading 时禁用并显示 loading 文字。
export function AttachButton({
  onPickFiles,
  uploading = false,
  disabled = false,
  accept = 'image/*',
  multiple = true,
  label = '添加附件',
}) {
  const inputRef = useRef(null);

  const handleClick = () => {
    if (disabled || uploading) return;
    inputRef.current?.click();
  };

  const handleChange = event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    onPickFiles(files);
  };

  return (
    <>
      <button
        type="button"
        className={`attach-btn ${uploading ? 'is-uploading' : ''}`}
        onClick={handleClick}
        disabled={disabled || uploading}
        title={uploading ? '上传中…' : label}
      >
        <Paperclip size={14} />
        <span>{uploading ? '上传中…' : '附件'}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={handleChange}
      />
    </>
  );
}
