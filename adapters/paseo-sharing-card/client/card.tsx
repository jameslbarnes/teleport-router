import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { type PluginTimelineItemProps, useRpc } from '@getpaseo/plugin/client';
import { deleteRpc, refreshCardRpc, renderedRpc, statusText, type Card, type Receipt } from '../shared/card';

type Props = PluginTimelineItemProps<Card>;

export function SharingCard({ item, agentId, theme }: Props) {
  const [card, setCard] = useState(item.data);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const refresh = useRpc(refreshCardRpc);
  // RPCs return the whole conversation; this timeline row owns one post.
  const scoped = (next: Card) => ({ ...next, receipts: next.receipts.filter(receipt =>
    item.data.receipts.some(own => own.entry_id === receipt.entry_id)) });
  useEffect(() => { setCard(current => item.data.updated_at >= current.updated_at ? item.data : current); }, [item.data]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (card.receipts.some(receipt => receipt.state === 'pending' && receipt.publish_at !== null && receipt.publish_at <= Date.now())) {
        void refresh({ agent_id: agentId }).then(next => setCard(scoped(next))).catch(() => setError('Could not check Router. Try Refresh.'));
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [card.receipts, agentId, refresh]);
  const update = (next: Card) => setCard(current => next.updated_at >= current.updated_at ? scoped(next) : current);
  const colors = theme.colors;
  const active = card.receipts.filter(receipt => receipt.state !== 'removed').length;
  const visible = expanded ? card.receipts : card.receipts.slice(-2);
  return (
    <View testID="router-sharing-card" style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surface1, padding: 16, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: '600' }}>Router · this conversation</Text>
        {card.test ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>TEST</Text> : null}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{card.test ? 'Disposable posts on the test Router.' : 'Posts shared from this conversation. Each audience is shown below.'}</Text>
      {visible.map(receipt => <Post key={receipt.entry_id} receipt={receipt} agentId={agentId} theme={theme} update={update} />)}
      {card.receipts.length > 2 ? <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}>
        <Text style={{ color: colors.accent }}>{expanded ? 'Show fewer posts' : `Show all ${card.receipts.length} posts`}</Text>
      </Pressable> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{active ? `${active} ${active === 1 ? 'post' : 'posts'} · exact text above` : card.receipts.length ? 'All posts deleted' : 'No posts shared yet'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh sharing card" onPress={() => {
          setError(''); void refresh({ agent_id: agentId }).then(update).catch(() => setError('Could not check Router. Try again.'));
        }} style={{ paddingVertical: 8, paddingHorizontal: 4 }}><Text style={{ color: colors.accent, fontSize: 13 }}>Refresh</Text></Pressable>
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text> : null}
    </View>
  );
}

function Post({ receipt, agentId, theme, update }: { receipt: Receipt; agentId: string; theme: Props['theme']; update: (card: Card) => void }) {
  const record = useRpc(renderedRpc);
  const remove = useRpc(deleteRpc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [laidOut, setLaidOut] = useState(false);
  const attempted = useRef(false);
  const [retry, setRetry] = useState(0);
  const colors = theme.colors;
  useEffect(() => {
    if (!laidOut || !receipt.notification_required || !receipt.notice_id || !receipt.notice_sha256 || attempted.current) return;
    // A client report of layout, never independent proof of visibility or attention.
    // Collapsed posts are not mounted and cannot start their publication countdown.
    const timer = setTimeout(() => {
      attempted.current = true;
      void record({ agent_id: agentId, entry_id: receipt.entry_id, notice_id: receipt.notice_id!, notice_sha256: receipt.notice_sha256! })
        .then(update).catch(() => setError('Could not record this notice. Try again below.'));
    }, 150);
    return () => clearTimeout(timer);
  }, [laidOut, receipt, record, agentId, update, retry]);
  return (
    <View onLayout={() => setLaidOut(true)} style={{ gap: 9, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.foreground, fontWeight: '600', fontSize: 13 }}>{receipt.audience}</Text>
      <Text selectable style={{ color: receipt.state === 'removed' ? colors.foregroundMuted : colors.foreground, fontSize: 15, lineHeight: 22 }}>{receipt.content}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: receipt.state === 'removed' ? colors.statusSuccess : colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{statusText(receipt)}</Text>
        {receipt.state !== 'removed' ? <Pressable accessibilityRole="button" accessibilityLabel="Delete post" disabled={busy} onPress={() => {
          setBusy(true); setError('');
          void remove({ agent_id: agentId, entry_id: receipt.entry_id }).then(update)
            .catch(() => setError('Could not delete. The post is still on Router.'))
            .finally(() => setBusy(false));
        }} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: colors.statusDanger, fontSize: 13, fontWeight: '500' }}>{busy ? 'Deleting…' : 'Delete post'}</Text>
        </Pressable> : null}
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      {error && receipt.notification_required && receipt.state !== 'removed' ? <Pressable accessibilityRole="button" onPress={() => {
        attempted.current = false; setError(''); setRetry(value => value + 1);
      }}><Text style={{ color: colors.accent }}>Retry notice</Text></Pressable> : null}
    </View>
  );
}
