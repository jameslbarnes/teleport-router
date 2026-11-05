/**
 * TinyCloud-backed group stores. The Router signs in to TinyCloud with its own
 * key and acts on each group only through the grant (delegation) that group's
 * owner gave it: scoped to `groups/<id>/` in the owner's space, revocable by the
 * owner at any time. Loaded lazily, only when TINYCLOUD_GROUPS=tinycloud.
 */
import { TinyCloudNode, deserializeDelegation } from '@tinycloud/node-sdk';
import { GroupStoreRevokedError, groupStoreFromAccess, isRevokedGrant, type DelegatedKv, type GroupStore, type GroupStoreResolver } from './group-store.js';

export interface TinyCloudRouterConfig {
  privateKey: string; // the Router's own TinyCloud key (0x-prefixed hex)
  host: string;
}

/** What a serialized grant says, checked before a group is created with it. */
export interface GrantSummary {
  delegateDID: string;
  spaceId: string;
  path: string;
  actions: string[];
  expiry?: Date;
  delegatorDID?: string;
  host?: string;
}

export function inspectGrant(wire: string): GrantSummary {
  const d = deserializeDelegation(wire) as unknown as GrantSummary & { expiry?: Date | string };
  return {
    delegateDID: d.delegateDID,
    spaceId: d.spaceId,
    path: d.path,
    actions: d.actions ?? [],
    expiry: d.expiry ? new Date(d.expiry) : undefined,
    delegatorDID: d.delegatorDID,
    host: d.host,
  };
}

export function tinyCloudGroups(config: TinyCloudRouterConfig) {
  let signingIn: Promise<TinyCloudNode> | null = null;
  const signedIn = () => (signingIn ??= (async () => {
    const node = new TinyCloudNode({ privateKey: config.privateKey, host: config.host, autoCreateSpace: false, enablePublicSpace: false });
    await node.signIn();
    return node;
  })().catch(err => { signingIn = null; throw err; }));

  const storeByGrant = new Map<string, GroupStore>();

  const accessFor = async (wire: string): Promise<GroupStore> => {
    const cached = storeByGrant.get(wire);
    if (cached) return cached;
    const node = await signedIn();
    let access: unknown;
    try {
      const delegation = deserializeDelegation(wire);
      if (delegation.host && new URL(delegation.host).origin !== new URL(config.host).origin)
        throw new Error('The TinyCloud grant uses a different host.');
      access = await node.useDelegation({...delegation,host:config.host});
    } catch (err) {
      if (isRevokedGrant((err as Error)?.message)) throw new GroupStoreRevokedError();
      throw err;
    }
    const store = groupStoreFromAccess(access as DelegatedKv);
    storeByGrant.set(wire, store);
    return store;
  };

  return {
    resolver: (async (channel) => {
      if (!channel.store.delegation) throw new Error(`Group #${channel.id} has no TinyCloud grant.`);
      return accessFor(channel.store.delegation);
    }) as GroupStoreResolver,
    accessFor,
    routerDid: async () => (await signedIn()).did as string,
    host: config.host,
    inspectGrant,
  };
}
