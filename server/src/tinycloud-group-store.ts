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
}

export function inspectGrant(wire: string): GrantSummary {
  const d = deserializeDelegation(wire) as unknown as GrantSummary & { expiry?: Date | string };
  return {
    delegateDID: d.delegateDID,
    spaceId: d.spaceId,
    path: d.path,
    actions: d.actions ?? [],
    expiry: d.expiry ? new Date(d.expiry) : undefined,
  };
}

export function tinyCloudGroups(config: TinyCloudRouterConfig) {
  let signingIn: Promise<TinyCloudNode> | null = null;
  const signedIn = () => (signingIn ??= (async () => {
    const node = new TinyCloudNode({ privateKey: config.privateKey, host: config.host, autoCreateSpace: false });
    await node.signIn();
    return node;
  })().catch(err => { signingIn = null; throw err; }));

  const storeByGrant = new Map<string, GroupStore>();

  const resolver: GroupStoreResolver = async (channel) => {
    const wire = channel.store.delegation;
    if (!wire) throw new Error(`Group #${channel.id} has no TinyCloud grant.`);
    const cached = storeByGrant.get(wire);
    if (cached) return cached;
    const node = await signedIn();
    let access: unknown;
    try {
      access = await node.useDelegation(deserializeDelegation(wire));
    } catch (err) {
      if (isRevokedGrant((err as Error)?.message)) throw new GroupStoreRevokedError();
      throw err;
    }
    const store = groupStoreFromAccess(access as DelegatedKv);
    storeByGrant.set(wire, store);
    return store;
  };

  return {
    resolver,
    routerDid: async () => (await signedIn()).did as string,
    host: config.host,
    inspectGrant,
  };
}
