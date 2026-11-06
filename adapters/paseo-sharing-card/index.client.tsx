import type { PluginClientContext } from '@getpaseo/plugin/client';
import { SharingCard } from './client/card';
import { cardSchema } from './shared/card';

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: 'router-sharing-card', version: 1, schema: cardSchema, Component: SharingCard });
  return () => {};
}
