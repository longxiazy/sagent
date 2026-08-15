/**
 * 判断模型是否具备图片输入能力。
 *
 * 与后端 agent/tools/vision/execute.ts 的 modelSupportsImageInput 保持同一口径：
 * 先看模态字段，字段缺失时才退回名称/描述关键词。两边判定必须一致，否则设置页里
 * 标成「生效中」的那一层，会和 run 里 vision 工具真正挑中的模型对不上。
 */

function lowerList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string').map(item => item.toLowerCase());
}

function findModel(modelId, models = []) {
  return models.find(item => (
    item?.id === modelId
    || (Array.isArray(item?.aliases) && item.aliases.includes(modelId))
  )) || null;
}

export function modelSupportsImageInput(modelId, models = []) {
  if (!modelId) return false;
  const info = findModel(modelId, models);
  const inputs = lowerList(info?.inputModalities || info?.input_modalities);
  const outputs = lowerList(info?.outputModalities || info?.output_modalities);

  // 只出图不出文的模型（如图像生成）不能用来回答问题。
  if (outputs.length > 0 && !outputs.includes('text')) return false;
  if (inputs.includes('image')) return true;
  if (inputs.length > 0) return false;

  const haystack = [modelId, info?.label, info?.description, info?.provider]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /^gemini-/i.test(modelId)
    || /\b(vision|vlm|multimodal|multi-modal|omni-modal)\b/i.test(haystack)
    || /image (understanding|input|analysis)|understands? images?|text\/img/i.test(haystack);
}
