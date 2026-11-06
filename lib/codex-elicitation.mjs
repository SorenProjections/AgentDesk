export function elicitationResponse(params, input) {
  if (!['accept', 'decline', 'cancel'].includes(input.decision)) throw new Error('确认结果无效。');
  if (input.decision !== 'accept') return { action: input.decision, content: null, _meta: null };
  if (params.mode === 'url') return { action: 'accept', content: null, _meta: null };
  const schema = params.requestedSchema;
  if (!schema || schema.type !== 'object' || !schema.properties) throw new Error('此确认表单需要在原客户端处理，请交回 Codex。');
  const content = input.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('请填写确认表单。');
  const fields = Object.entries(schema.properties);
  const values = {};
  for (const [key, field] of fields) {
    const value = Object.hasOwn(content, key) ? content[key] : undefined;
    if (value === undefined) {
      if (schema.required?.includes(key)) throw new Error(`请填写：${field.title || key}`);
      continue;
    }
    const label = field.title || key;
    let valid = false;
    if (field.type === 'string') {
      valid = typeof value === 'string' && value.length >= (field.minLength || 0) && value.length <= (field.maxLength ?? 100000);
      const options = field.enum || field.oneOf?.map(option => option.const);
      if (options) valid &&= options.includes(value);
    } else if (field.type === 'boolean') valid = typeof value === 'boolean';
    else if (['number', 'integer'].includes(field.type)) valid = typeof value === 'number' && Number.isFinite(value) && (field.type !== 'integer' || Number.isInteger(value)) && value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
    else if (field.type === 'array') {
      const options = field.items?.enum || field.items?.anyOf?.map(option => option.const);
      valid = Array.isArray(value) && !!options && value.every(item => typeof item === 'string' && options.includes(item)) && new Set(value).size === value.length && value.length >= (field.minItems || 0) && value.length <= (field.maxItems ?? Infinity);
    }
    if (!valid) throw new Error(`请检查：${label}`);
    Object.defineProperty(values, key, { value, enumerable: true });
  }
  return { action: 'accept', content: values, _meta: null };
}
