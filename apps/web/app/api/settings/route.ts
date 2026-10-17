import { SettingsPatchSchema } from '@aidocs/contracts';
import { getSettings, getStorageState, saveSettings, setDefaultModelRef, setStorageRoot } from '@aidocs/api';
import { json, readSchema, route } from '../_lib/http';

export const dynamic = 'force-dynamic';

export const GET = route(async () => json({ settings: getSettings(), storage: getStorageState() }));

export const PUT = route(async (request) => {
  const patch = await readSchema(request, SettingsPatchSchema);
  if (patch.storageRoot !== undefined) setStorageRoot(patch.storageRoot);
  if (patch.defaultModel !== undefined) setDefaultModelRef(patch.defaultModel);
  const { storageRoot: _storageRoot, defaultModel: _defaultModel, ...rest } = patch;
  if (Object.keys(rest).length > 0) saveSettings(rest);
  return json({ settings: getSettings(), storage: getStorageState() });
});
