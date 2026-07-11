/**
 * Codegraph Query Tool — 让 Agent 查询项目代码知识图谱
 *
 * 读取 {dataDir}/codegraph.json,按关键词静态匹配模块,返回路径/职责/导出/依赖文本,
 * 帮 Agent 在不逐个 read_file 探索的情况下快速定位相关代码。
 * 图谱由用户在记忆面板「Code Graph」点「重新索引」生成;未索引时引导用户去生成。
 *
 * 入参 dataDir 来自 desktop/agent.ts state.dataDir(按项目隔离;无项目为全局 data 目录)。
 */

import { loadCodegraph, queryCodegraph } from '../../core/codegraph.ts';
import type { ActionForTool } from '../../core/contracts.ts';

export async function executeCodegraphQueryAction(
  action: ActionForTool<'codegraph'>,
  { dataDir, signal }: { dataDir?: string | null; signal?: AbortSignal } = {},
): Promise<string> {
  const query = typeof action?.query === 'string' ? action.query.trim() : '';
  if (!query) return 'codegraph_query 失败:query 为空';
  if (!dataDir) return 'codegraph_query 失败:当前会话没有项目数据目录,无法读取代码图谱';

  const graph = await loadCodegraph(dataDir, signal);
  if (!graph) {
    return '该项目尚未建立代码图谱(codegraph)。请在左侧记忆面板的「Code Graph」标签页点「重新索引」生成后再查询;在此之前可用 list_dir / search_files 直接探索目录。';
  }

  const results = queryCodegraph(graph, query);
  if (results.length === 0) {
    return `codegraph_query 未找到与 "${query}" 相关的模块(项目 ${graph.project} 共 ${graph.modules.length} 个模块)。可换关键词,或用 search_files 直接搜内容。`;
  }

  const lines = results.map((m, i) => {
    const head = `${i + 1}. ${m.path}`;
    const desc = m.description ? `   职责: ${m.description}` : '';
    const exp = m.exports.length ? `   导出: ${m.exports.slice(0, 8).join(', ')}` : '';
    const dep = m.dependsOn.length ? `   依赖: ${m.dependsOn.slice(0, 6).join(', ')}` : '';
    return [head, desc, exp, dep].filter(Boolean).join('\n');
  });

  return `codegraph 匹配 "${query}"(项目 ${graph.project} / ${graph.modules.length} 个模块,命中 ${results.length} 个):\n${lines.join('\n\n')}`;
}
