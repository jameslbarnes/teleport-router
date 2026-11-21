/** The owner's session and the permission given to the reader must name the same TinyCloud space. */
export function traceReadSession(space, entryId, origin) {
  const spacePrefix = space.split(':').slice(5).join(':');
  if (!spacePrefix || !/^[\w-]{1,160}$/.test(entryId)) throw Error('Invalid trace storage location.');
  return {
    spacePrefix,
    manifest: {
      name: 'Router', app_id: new URL(origin).hostname.split('.').reverse().join('.'),
      defaults: false, prefix: '', space: spacePrefix, includePublicSpace: false, expiry: '2d',
      permissions: [{ service: 'tinycloud.kv', space, path: 'router/traces/' + entryId + '/', actions: ['get'] }],
    },
  };
}

/** A trace app's run takes a grant of at most 15 minutes; a reader grant made before apps lasted 24 hours. */
export async function grantTraceRead(owner, readerDid, session, expiryMs = 86400000) {
  const { delegation } = await owner.delegateTo(readerDid, session.manifest.permissions, {
    expiry: expiryMs, requireActivation: true,
  });
  return delegation;
}
