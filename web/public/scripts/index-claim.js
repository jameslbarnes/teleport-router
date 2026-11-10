
        // Claim handle dialog. showModal, hideModal, showSignedIn and renderSignedIn live in index-main.js.
        let claimCheckTimeout;

        // One place sets the look of a status line: '' (plain), 'error' or 'success'.
        function setClaimStatus(el, text, kind = '') {
            el.textContent = text;
            el.classList.toggle('r-status--error', kind === 'error');
            el.classList.toggle('r-status--ok', kind === 'success');
        }

        function openClaimModal() {
            showModal('claim-modal', 'claim-handle-input');
        }

        function closeClaimModal() {
            hideModal('claim-modal');
            document.getElementById('claim-handle-input').value = '';
            document.getElementById('claim-display-name').value = '';
            document.getElementById('claim-bio').value = '';
            document.getElementById('claim-handle-status').textContent = '';
            document.getElementById('claim-status').style.display = 'none';
        }

        async function checkClaimHandle() {
            clearTimeout(claimCheckTimeout);
            const input = document.getElementById('claim-handle-input');
            const status = document.getElementById('claim-handle-status');
            const btn = document.getElementById('claim-submit');
            let handle = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '');

            input.value = handle;

            if (handle.length < 3) {
                setClaimStatus(status, handle.length > 0 ? 'A handle needs at least 3 characters.' : '');
                btn.disabled = true;
                return;
            }

            if (!/^[a-z]/.test(handle)) {
                setClaimStatus(status, 'A handle must start with a letter.', 'error');
                btn.disabled = true;
                return;
            }

            setClaimStatus(status, 'Checking…');

            claimCheckTimeout = setTimeout(async () => {
                try {
                    const res = await fetch(`/api/identity/check/${handle}`);
                    const data = await res.json();

                    if (data.available) {
                        setClaimStatus(status, `@${handle} is available.`, 'success');
                        btn.disabled = false;
                    } else {
                        setClaimStatus(status, `@${handle} is taken. Try another.`, 'error');
                        btn.disabled = true;
                    }
                } catch (err) {
                    setClaimStatus(status, 'Could not check that handle. Check your connection and try again.', 'error');
                    btn.disabled = true;
                }
            }, 300);
        }

        async function submitClaimHandle() {
            const handle = document.getElementById('claim-handle-input').value;
            const displayName = document.getElementById('claim-display-name').value;
            const bio = document.getElementById('claim-bio').value.trim();
            const status = document.getElementById('claim-status');
            const btn = document.getElementById('claim-submit');
            const effectiveKey = getEffectiveKey();

            if (!effectiveKey) {
                setClaimStatus(status, 'You are not signed in. Open Settings and enter your Router key.', 'error');
                status.style.display = 'block';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Claiming…';

            try {
                const res = await fetch('/api/identity/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        secret_key: effectiveKey,
                        handle: handle,
                        displayName: displayName || undefined,
                        bio: bio || undefined
                    })
                });

                const data = await res.json();

                if (res.ok) {
                    setClaimStatus(status, `You are now @${data.handle}.`, 'success');
                    status.style.display = 'block';

                    // Update sidebar
                    showSignedIn(renderSignedIn(data.handle));

                    setTimeout(() => closeClaimModal(), 1500);
                } else {
                    setClaimStatus(status, data.error || 'Could not claim that handle. Try again.', 'error');
                    status.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Claim handle';
                }
            } catch (err) {
                setClaimStatus(status, 'Could not reach Router. Check your connection and try again.', 'error');
                status.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Claim handle';
            }
        }
    
