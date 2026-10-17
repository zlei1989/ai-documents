import { describe, expect, it } from 'vitest';
import { formatJson, parseJsonObject } from '../app/workspace/[group]/[name]/_archify-editor/model';

describe('Archify JSON 编辑', () => {
  it('格式化保留全部字段并缩进', () => {
    const ir = {
      schema_version: 2,
      diagram_type: 'architecture',
      components: [{ id: 'a', label: 'A', custom: { nested: true } }],
    };
    const text = formatJson(ir);
    expect(text).toContain('\n  "schema_version": 2');
    expect(parseJsonObject(text)).toEqual(ir);
  });

  it('拒绝非对象 IR', () => {
    expect(() => parseJsonObject('[]')).toThrow('IR 必须是 JSON 对象');
    expect(() => parseJsonObject('null')).toThrow('IR 必须是 JSON 对象');
  });

  it('语法错误带 JSON 定位提示', () => {
    expect(() => parseJsonObject('{ "a": }')).toThrow(/^JSON 语法错误：/);
  });
});
