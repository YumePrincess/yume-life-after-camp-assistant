const DEFAULT_PREFIX = 'lifeafter';

export function storagePrefix(env) {
  return String((env.STORAGE_PREFIX ?? DEFAULT_PREFIX) + "/chat")
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

export function storageObjectKey(env, logicalKey) {
  const key = String(logicalKey || '').replace(/^\/+/, '');
  const prefix = storagePrefix(env);
  return prefix ? `${prefix}/${key}` : key;
}

export function storageObjectCandidates(env, logicalKey) {
  const key = String(logicalKey || '').replace(/^\/+/, '');
  const currentKey = storageObjectKey(env, key);
  const candidates = [currentKey];
  return candidates;
}

export async function getStorageObject(env, logicalKey) {
  for (const key of storageObjectCandidates(env, logicalKey)) {
    const object = await env.FILES.get(key);
    if (object) return object;
  }
  return null;
}

export async function deleteStorageObject(env, logicalKey) {
  for (const key of storageObjectCandidates(env, logicalKey)) {
    if (!await env.FILES.get(key)) continue;
    await env.FILES.delete(key);
    return key;
  }
  return null;
}

export function storageListPrefix(env) {
  const prefix = storagePrefix(env);
  return prefix ? `${prefix}/` : '';
}

export function logicalStorageObjects(env, objects = []) {
  const prefix = storageListPrefix(env);
  return objects.flatMap((object) => {
    const key = String(object?.key || '');
    if (!key.startsWith(prefix)) return [];
    return [{ ...object, key: key.slice(prefix.length) }];
  });
}
