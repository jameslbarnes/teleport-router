(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('rules-form');
  const key = localStorage.getItem('router_key');
  const textFields = ['purpose', 'share', 'avoid', 'style', 'instructions'];
  let revision = 0;
  let guide;
  let reviewed = '';
  let dirty = false;
  const selected = name => form.elements.namedItem(name).value;
  const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); $('save-status').textContent = text; };
  function draft() {
    return { mode: selected('mode'), audience: selected('audience'), destinations: selected('audience') === 'selected' ? $('destinations').value.split(',').map(s => s.trim()).filter(Boolean) : [], ...Object.fromEntries(textFields.map(f => [f, $(f).value])) };
  }
  function summary(rules) {
    const mode = { automatic: 'Post automatically within these rules.', review: 'Show me the text and audience first. Wait for approval.', manual: 'Only post when I ask. Do not proactively suggest posting.' }[rules.mode];
    const audience = rules.audience === 'public' ? 'Public: anyone on the internet' : rules.audience === 'ask' ? 'Choose with me for each post' : rules.destinations.join(', ');
    return `${mode}\nAudience: ${audience}\n\n` + textFields.map((f, i) => rules[f] ? `${['What I want', 'What to share', 'What to leave out', 'How to write', 'In my own words'][i]}:\n${rules[f]}` : '').filter(Boolean).join('\n\n');
  }
  function changed() {
    dirty = true;
    $('destinations-wrap').hidden = selected('audience') !== 'selected';
    $('destinations').required = selected('audience') === 'selected';
    $('confirmed').checked = false;
    $('review').hidden = true;
    $('after-save').hidden = true;
    $('save-status').textContent = '';
    reviewed = '';
  }
  form.addEventListener('input', event => { if (event.target !== $('confirmed')) changed(); });
  async function request(body) {
    const res = await fetch('/api/posting-rules', { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Could not load your rules.'), { status: res.status });
    return data;
  }
  async function load() {
    $('editor').disabled = true;
    $('reload').hidden = true;
    try {
      const data = await request();
      revision = data.revision;
      guide = data;
      form.reset();
      if (data.rules) {
        form.elements.namedItem('mode').value = data.rules.mode;
        form.elements.namedItem('audience').value = data.rules.audience;
        $('destinations').value = data.rules.destinations.join(', ');
        textFields.forEach(f => { $(f).value = data.rules[f]; });
      }
      changed(); dirty = false;
      $('editor').disabled = false;
      $('coach').disabled = false;
      $('after-save').hidden = !data.rules;
      status(data.rules ? `Saved rules · revision ${revision}. Your wording is kept exactly as you wrote it.` : 'No rules saved yet. Choose what works for you below, or start with your agent.');
    } catch (err) {
      status(err.message, true);
      $('sign-in').hidden = err.status !== 401;
      $('reload').hidden = err.status === 401;
    }
  }
  $('reload').addEventListener('click', () => {
    if (!dirty || window.confirm('Loading replaces the draft on this page. Copy any edits you want to keep first. Load the saved rules?')) load();
  });
  $('preview').addEventListener('click', () => {
    // The approval checkbox is for saving, not for generating this local preview.
    $('confirmed').required = false;
    const valid = form.reportValidity();
    $('confirmed').required = true;
    if (!valid) return;
    const rules = draft();
    if (rules.audience === 'selected' && (!rules.destinations.length || rules.destinations.some(d => !/^[@#][a-z0-9][a-z0-9_-]{0,63}$/.test(d)))) { status('Use @handles or #groups, separated by commas.', true); return; }
    reviewed = JSON.stringify(rules);
    $('draft').textContent = summary(rules);
    const audience = rules.audience === 'public' ? 'the public notebook' : rules.audience === 'ask' ? 'the audience you choose together' : rules.destinations.join(', ');
    $('post-example').textContent = rules.mode === 'manual' ? `You explicitly ask to share an idea that fits your rules. The agent can draft it for ${audience}; it clarifies any missing audience before posting.` : rules.mode === 'review' ? `A useful discovery fits your rules. The agent shows a short draft for ${audience}, then waits for your approval.` : `A useful discovery fits your rules. ${rules.audience === 'ask' ? 'The agent asks who should receive it before posting.' : `The agent can post it to ${audience}.`}`;
    $('ask-example').textContent = rules.mode === 'manual' ? 'You ask to post something, but who should read it is unclear. The agent asks you before posting. Without your request, it stays quiet.' : 'A possible post may reveal something you meant to leave out. The agent does not publish it; it asks for clarification when useful.';
    $('review').hidden = false;
    status('Review the rules and examples. Nothing has been posted.');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const rules = draft();
    if (!reviewed || reviewed !== JSON.stringify(rules) || !$('confirmed').checked) { status('Review your current rules before saving.', true); return; }
    $('save').disabled = true;
    $('editor').disabled = true;
    try {
      const data = await request({ rules, expected_revision: revision, confirmed: true });
      revision = data.revision; guide = data; dirty = false;
      $('after-save').hidden = false;
      status(`Saved · revision ${revision}. Nothing was posted to the notebook.`);
    } catch (err) {
      status(err.message + (err.status === 409 ? ' Your draft is still here. Copy it before loading the saved version.' : ''), true);
      if (err.status === 409) $('reload').hidden = false;
    } finally { $('save').disabled = false; $('editor').disabled = false; }
  });
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); status('Copied. Paste it into your agent’s conversation.'); }
    catch { status('Select and copy the text below.'); $('copy-output').textContent = text; $('copy-output').hidden = false; $('copy-output').focus(); }
  }
  $('coach').addEventListener('click', () => copy(guide.coach + (dirty ? '\n\nHere is my unfinished draft. Help me fill gaps and correct it:\n' + JSON.stringify(draft(), null, 2) : '')));
  $('copy-install').addEventListener('click', () => copy(guide.installation));
  $('copy-check').addEventListener('click', () => copy('Read my saved Router posting rules with router_posting_rules. Tell me the revision, when you may post, who can read it, and what to leave out. Give an invented example in my voice, say whether you would post, ask first, or skip, and show its exact audience. Do not publish anything. Then help me find one useful existing post within my authorized access.'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  fetch('/api/posting-rules-guide').then(res => { if (!res.ok) throw new Error(); return res.json(); }).then(data => { if (!guide) guide = data; $('coach').disabled = false; }).catch(() => { if (!key) status('Could not load the setup prompt. Please reload the page.', true); });
  if (key) load(); else { $('sign-in').hidden = false; status('Sign in to save your rules. You can still copy the prompt and think them through with your agent.'); }
})();
