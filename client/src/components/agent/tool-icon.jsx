import { Globe, FolderOpen, Terminal, Monitor, Code, Search, Eye, Download, Bot, Cog, Wrench } from 'lucide-react';

// agent 工具 → 图标：让动作摘要一眼看出这步用的是哪类工具。
// 图标保持中性色（时间线圆点已承载动作语义色），只作快速扫读的视觉锚点。
const TOOL_ICONS = {
  browser: Globe,
  chrome: Globe,
  fs: FolderOpen,
  terminal: Terminal,
  macos: Monitor,
  ide: Code,
  mcp: Wrench,
  search: Search,
  vision: Eye,
  spawn: Bot,
  fetch: Download,
  core: Cog,
};

export function ToolIcon({ tool, ...props }) {
  const Icon = TOOL_ICONS[tool] || Wrench;
  return <Icon {...props} />;
}
