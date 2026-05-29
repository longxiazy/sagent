// 调用后端 /api/uploads,把文件 base64 化后上传,返回服务端存档绝对路径。
// 单文件入口:把 File 对象转 base64,POST 给服务端,服务端落盘后返回 path。
// 失败时抛错,由调用方在 UI 上标记 chip 为 error。

export async function uploadAttachment(file) {
  const buf = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);

  const body = {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    data: base64,
    // kind 留给后端推断(image/ 前缀 → image,其余 → file)。
    // 前端这里不主动传,以便将来扩展时由后端一处统一规则。
  };

  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `上传失败 HTTP ${res.status}`);
  }
  return {
    path: json.path,
    kind: json.kind,
    mime: json.mime,
    name: json.name,
    size: json.size,
  };
}

// 浏览器内 ArrayBuffer → base64。
// FileReader.readAsDataURL 也行,但要切掉前缀;这里直接走 btoa 更稳。
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000; // 防止 String.fromCharCode 栈溢出
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
