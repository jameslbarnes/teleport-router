> Archived 2026-11-10. This is a historical design note and no longer describes how Router works. The current description is [DOCS.md](../../DOCS.md).

# Groups on TinyCloud

A group is an invite-only channel whose posts live in the group owner's [TinyCloud](https://tinycloud.xyz) space, not in the Router's database. The owner grants the Router a scoped, revocable permission on one folder of their space. The Router reads and writes posts only through that grant and keeps no copies, so the owner can withdraw the group from the Router at any time without asking us.

Status: prototype on branch `groups-on-tinycloud`, checked end to end against TinyCloud's hosted node (`node scripts/tinycloud-groups-e2e.mjs`, all checks passing, 2026-11-02). Not deployed.

## How it works

- A post addressed to the group (`to: ["#<group>"]`) waits in the Router's TEE memory like any other post, visible only to its author. When it publishes, it is written to `groups/<group>/posts/<entryId>` in the owner's space, never to the Router's database. So it can't appear in the public feed, search or author pages.
- Members read the group through the Router's normal channel endpoints. Each view reads through the owner's grant.
- If the owner revokes the grant, the TinyCloud node refuses the Router's next request. The group feed returns `410` ("The group owner has revoked the Router's access to this group's posts.") and single posts read as not found. The owner keeps everything in their own space.
- The Router checks a grant before accepting it. It must be issued to this Router's TinyCloud identity, cover exactly `groups/<group>/`, include `get`, `put`, `list` and `del`, and be unexpired.

## Running it

```sh
TINYCLOUD_GROUPS=tinycloud            # or "memory" for tests and local runs
TINYCLOUD_ROUTER_KEY=0x…              # the Router's own TinyCloud key
TINYCLOUD_HOST=https://tee.node.tinycloud.xyz   # default
```

`GET /api/tinycloud/router` returns the Router's TinyCloud identity (`did`) and the actions a grant needs.

## Creating a group (owner)

```js
import { TinyCloudNode, serializeDelegation } from '@tinycloud/node-sdk';
const owner = new TinyCloudNode({ privateKey, host: 'https://tee.node.tinycloud.xyz', prefix: 'router-groups', autoCreateSpace: true });
await owner.signIn();
const grant = await owner.createDelegation({
  delegateDID: routerDid, path: 'groups/<group>/',
  actions: ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'],
  expiryMs: 30 * 24 * 3600 * 1000,
  includePublicSpace: false,   // otherwise the SDK also grants get/put on your whole public space
});
// POST /api/channels  { secret_key, id: '<group>', name, storage: 'tinycloud', tinycloud_delegation: serializeDelegation(grant) }
// Later, to withdraw the group from the Router: await owner.revokeDelegation(grant.cid)
```

## Limits and next steps

- **One owner per group.** Members' posts go into the owner's space, so members can delete their posts only through the Router. Next step: each author keeps their own posts in their own space, with the Router and the group granted read access, so every author can revoke independently.
- **The Router's TinyCloud key** comes from an environment variable. In the TEE deployment it should be derived from the dstack KMS, so the Router's TinyCloud identity is bound to the attested build.
- **"Keeps no copies"** is a property of this code. It becomes checkable once the attested build ships.
- **Revocation can't recall what members already read.**
- **TinyCloud specifics** (verified 2026-11-02, `@tinycloud/node-sdk` 3.9.1):
  - The node reports revoked grants only in the error message, so the Router matches on it.
  - The free plan is 100 MiB per account, and deleted data still counts against it.
  - A space's usage and plan can be read by anyone at `api.account.tinycloud.xyz/api/quota/<spaceId>`.
- `LISTEN_HOST` (optional) binds the server to one interface for local demos.
