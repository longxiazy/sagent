import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handle = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={(e) => { e.stopPropagation(); handle(); }} title="复制">
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
