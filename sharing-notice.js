// A browser report of displaying a notice, not a proof of human attention.
window.showRouterSharingNotice = async function (receipt, key) {
    if (!receipt) return;
    const card = document.createElement('aside');
    card.setAttribute('role', 'status');
    card.style.cssText = 'position:fixed;z-index:1000;bottom:16px;left:50%;transform:translateX(-50%);width:min(560px,calc(100% - 32px));max-height:70vh;overflow:auto;box-sizing:border-box;background:#fff;color:#222;border:1px solid #bbb;border-radius:8px;padding:20px;box-shadow:0 4px 24px #0002;font:15px/1.5 system-ui';
    const title = document.createElement('strong'); title.textContent = 'Saved to Router';
    const audience = document.createElement('p'); audience.textContent = 'Audience: ' + receipt.audience;
    const text = document.createElement('p'); text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; text.textContent = receipt.content;
    const status = document.createElement('p');
    const link = document.createElement('a'); link.href = receipt.review_url; link.textContent = 'Review or delete';
    const close = document.createElement('button'); close.textContent = 'Close'; close.style.marginLeft = '24px'; close.onclick = () => card.remove();
    card.append(title, audience, text, status, link, close); document.body.append(card);
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
