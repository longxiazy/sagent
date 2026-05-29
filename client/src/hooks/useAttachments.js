import { useCallback, useRef, useState } from 'react';
import { uploadAttachment } from '../api/uploads.js';

// 管理输入栏的附件列表。
//   attachments: [{ id, kind, name, mime, size, previewUrl, path, status, error }]
//
// kind 由后端推断(image/ → image,其它 → file);前端在 chip 上分两种渲染。
// status:
//   uploading — 已加入列表,正在调 /api/uploads
//   ready     — 上传成功,有 path 可拼到任务文本
//   error     — 上传失败,保留 chip 让用户能看到原因
//
// 这个 hook 故意不限制类型,onPickFiles 接什么文件都生成 chip;
// 后端 /api/uploads 会按 mime 推 kind。如果以后要加 PDF/音频,前端只要把 AttachButton 的 accept 改宽即可。
export function useAttachments() {
  const [attachments, setAttachments] = useState([]);
  const idRef = useRef(0);

  const update = (id, patch) => {
    setAttachments(prev => prev.map(a => (a.id === id ? { ...a, ...patch } : a)));
  };

  const addFiles = useCallback(async files => {
    for (const file of files) {
      idRef.current += 1;
      const id = `att-${Date.now()}-${idRef.current}`;
      const isImage = (file.type || '').startsWith('image/');
      let previewUrl = '';
      if (isImage) {
        previewUrl = await readAsDataUrl(file).catch(() => '');
      }
      const pending = {
        id,
        kind: isImage ? 'image' : 'file',
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        previewUrl,
        path: '',
        status: 'uploading',
      };
      setAttachments(prev => [...prev, pending]);

      try {
        const result = await uploadAttachment(file);
        update(id, {
          status: 'ready',
          path: result.path,
          kind: result.kind || pending.kind,
          mime: result.mime || pending.mime,
          size: result.size ?? pending.size,
          name: result.name || pending.name,
        });
      } catch (err) {
        update(id, { status: 'error', error: err?.message || '上传失败' });
      }
    }
  }, []);

  const removeAttachment = useCallback(id => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  // 提交任务时由 App.jsx 调用:把 ready 附件转成结构化数组,送回给 caller。
  // 这里不直接拼字符串,把"如何描述给 LLM"的策略留给 App.jsx,保留扩展余地。
  const consumeReady = useCallback(() => {
    const ready = attachments.filter(a => a.status === 'ready' && a.path);
    return ready.map(a => ({
      kind: a.kind,
      path: a.path,
      mime: a.mime,
      name: a.name,
      size: a.size,
    }));
  }, [attachments]);

  const uploading = attachments.some(a => a.status === 'uploading');
  const hasReady = attachments.some(a => a.status === 'ready');

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    consumeReady,
    uploading,
    hasReady,
  };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
