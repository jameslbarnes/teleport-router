import type { PluginServerContext, PluginHandlerContext } from '@getpaseo/plugin/server';
import { CardSession } from './server/session';
import { showCardRpc, addPostRpc, refreshCardRpc, renderedRpc, deleteRpc, type Card } from './shared/card';

export default function contribute(server: PluginServerContext) {
  const session = new CardSession();
  const show = async (agentId: string, card: Card, { paseo }: PluginHandlerContext) => {
    // Reusing a single conversation row leaves new posts above later chat turns.
    // A new entry gets a new row at the bottom; status changes update its own row.
    for (const receipt of card.receipts) {
      await paseo.agents.ref(agentId).timeline.append({
        type: 'plugin', id: `router-sharing-card:${receipt.entry_id}`, kind: 'router-sharing-card', version: 1,
        data: { ...card, receipts: [receipt] },
      });
    }
    return card;
  };
  server.handle(showCardRpc, async (input, context) => show(input.agent_id, await session.read(input.agent_id), context));
  server.handle(addPostRpc, async (input, context) => show(input.agent_id, await session.add(input.agent_id, input.entry_id), context));
  server.handle(refreshCardRpc, async (input, context) => show(input.agent_id, await session.refresh(input.agent_id), context));
  server.handle(renderedRpc, async (input, context) => show(input.agent_id,
    await session.rendered(input.agent_id, input.entry_id, input.notice_id, input.notice_sha256), context));
  server.handle(deleteRpc, async (input, context) => show(input.agent_id, await session.delete(input.agent_id, input.entry_id), context));
  return () => {};
}
