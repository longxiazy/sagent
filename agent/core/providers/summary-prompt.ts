export function buildSummaryPrompt(text: string) {
  return `请用简洁的中文提炼以下 Agent 任务记录的关键信息。要求：
1. 相同或相似主题的任务合并为一条，不要重复
2. 每个任务一行，格式：任务→结果要点
3. 保留重要的事实、数据和结论
4. 去除冗余细节

${text}`;
}
