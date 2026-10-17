import { getType, listMcpServers, listSkills, resolveStorageRoot, type TypeDetail } from '@aidocs/api';
import { MissingType } from './missing-type';
import { TypeEditor } from './type-editor';

export const dynamic = 'force-dynamic';

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default async function TypePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await params;
  const name = decodeSegment(raw.name);
  // 从工作台「编辑类型」进来会带 ?doc=group/name：注入预览的 cwd 段用那篇文档的目录，
  // 同时作为「回到文档」的直达地址（不依赖浏览器历史）。
  const docParam = (await searchParams).doc;
  const doc = typeof docParam === 'string' && docParam ? docParam : undefined;

  let detail: TypeDetail;
  try {
    detail = getType(resolveStorageRoot(), name);
  } catch (error) {
    // 类型被删/改名后，文档里的 type 字段会变成死链。不再抛 404，
    // 而是给出来路（回去继续创作）与一键创建同名类型的出口。
    return <MissingType name={name} {...(doc ? { doc } : {})} reason={(error as Error).message} />;
  }

  const skills = listSkills();
  const mcp = listMcpServers();
  return (
    <TypeEditor
      name={detail.manifest.name}
      prompt={detail.prompt}
      manifest={detail.manifest}
      skills={skills.map((s) => ({ name: s.name, description: s.description, origin: s.origin, enabled: s.enabled }))}
      mcp={mcp.map((m) => ({ name: m.name, transport: m.transport, enabled: m.enabled }))}
      {...(doc ? { doc } : {})}
    />
  );
}
