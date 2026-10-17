import { ModelInfoSchema } from '@aidocs/contracts';
import { deleteModel, saveModel } from '@aidocs/api';
import { json, readKey, readSchema, route, type RouteContext } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

/** 手动新增/编辑单个模型：同 id 整条替换，允许清空能力字段 */
export const PUT = route<RouteContext<{ id: string }>>(async (request, context) => {
  const { id } = await context.params;
  const model = await readSchema(request, ModelInfoSchema);
  return json(saveModel(id, model));
});

/** 删除单个已录入模型；modelId 走 query，兼容含 / 的模型 ID */
export const DELETE = route<RouteContext<{ id: string }>>(async (request, context) => {
  const { id } = await context.params;
  return json(deleteModel(id, await readKey(request, 'modelId')));
});
