// A browser report of displaying a notice, not a proof of human attention.
window.showRouterSharingNotice = async function (receipt, key) {
    if (!receipt) return;
    const card = document.createElement('aside');
    card.setAttribute('role', 'status');
    // Colours, type and the Close button come from /router.css, which every page that shows this card loads.
    // The system colours after each comma only apply if a page forgets it, so the card never turns see-through.
    card.className = 'r-card';
    card.style.cssText = 'position:fixed;z-index:1000;bottom:var(--s-4,16px);left:50%;transform:translateX(-50%);width:min(560px,calc(100% - 32px));max-height:70vh;overflow:auto;box-sizing:border-box;background:var(--surface,Canvas);color:var(--fg,CanvasText);border:1px solid var(--border-strong,GrayText);border-radius:var(--r-md,8px);padding:var(--s-5,24px);font-family:var(--font-ui,system-ui);font-size:var(--t-sm,0.875rem);line-height:1.5';
    const title = document.createElement('strong'); title.textContent = 'Saved to Router';
    title.style.cssText = 'display:block;font-size:var(--t-base,1rem);font-weight:600';
    const audience = document.createElement('p'); audience.textContent = 'Audience: ' + receipt.audience;
    audience.style.cssText = 'margin:var(--s-1,4px) 0 0;color:var(--fg-muted,GrayText);overflow-wrap:anywhere';
    const text = document.createElement('p'); text.textContent = receipt.content;
    text.style.cssText = 'margin:var(--s-3,12px) 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-read,serif);font-size:var(--t-base,1rem);line-height:1.6';
    const status = document.createElement('p'); status.style.cssText = 'margin:0;color:var(--fg-muted,GrayText)';
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:var(--s-4,16px);margin-top:var(--s-4,16px)';
    const link = document.createElement('a'); link.href = receipt.review_url; link.textContent = 'Review or delete';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'r-btn r-btn--small'; close.textContent = 'Close'; close.onclick = () => card.remove();
    actions.append(link, close);
    card.append(title, audience, text, status, actions); document.body.append(card);
    const showStatus = () => { status.textContent = receipt.state === 'held' ? 'Held for review.'
        : receipt.state === 'awaiting_notice' ? `Private for now. The ${receipt.delay_after_notice_ms / 60000}-minute publication countdown starts after this notice is recorded.`
        : receipt.publish_at ? 'Scheduled to publish ' + new Date(receipt.publish_at).toLocaleString(undefined, { timeZoneName: 'short' }) + '.' : 'Published.'; };
    showStatus();
    if (!receipt.notice_id || receipt.notification_evidence) return;
    // Do not record merely fetching an image/page, nor rendering into a hidden tab.
    if (document.visibilityState !== 'visible') await new Promise(resolve => {
        const changed = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', changed); resolve(); } };
        document.addEventListener('visibilitychange', changed);
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!card.isConnected || document.visibilityState !== 'visible') return;
    try {
        const response = await fetch(`/api/entries/${encodeURIComponent(receipt.entry_id)}/notice`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
            body: JSON.stringify({ notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256,
                evidence_kind: 'client_reported', conversation_ref: 'router-page:' + location.pathname + ':' + receipt.notice_id }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Delivery could not be recorded.');
        receipt = result.receipt; showStatus();
    } catch (error) { status.textContent = 'Saved privately. ' + error.message + ' Open Review or delete to inspect it.'; }
};
