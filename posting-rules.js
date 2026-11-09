(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const form = $('rules-form');
  const key = localStorage.getItem('router_key');
  const groupId = new URLSearchParams(location.search).get('group');
  if (groupId && new URLSearchParams(location.search).get('onboarding') === '1') {
    const resume = document.createElement('a');
    resume.href = '/group-setup?group=' + encodeURIComponent(groupId) + '&rules=saved';
    resume.textContent = 'Continue group setup';
    resume.className = 'button';
    $('after-save').prepend(resume);
  }
  let groupContext;
  const textFields = ['purpose', 'share', 'avoid', 'style', 'instructions'];
  let revision = 0;
  let guide;
  let reviewed = '';
  let dirty = false;
  const selected = name => form.elements.namedItem(name).value;
  const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); $('save-status').textContent = text; };
  if (groupId) $('join-link').href = '/join?next=' + encodeURIComponent('/posting-rules?group=' + encodeURIComponent(groupId));
  function draft() {
    return { mode: selected('mode'), audience: selected('audience'), destinations: selected('audience') === 'selected' ? $('destinations').value.split(',').map(s => s.trim()).filter(Boolean) : [], ...Object.fromEntries(textFields.map(f => [f, $(f).value])) };
  }
  function summary(rules) {
    const mode = { automatic: 'Post automatically within these rules.', review: 'Show me the text and audience first. Wait for approval.', manual: 'Only post when I ask. Do not proactively suggest posting.' }[rules.mode];
    const audience = rules.audience === 'public' ? 'Public: anyone on the internet' : rules.audience === 'ask' ? 'Choose with me for each post' : rules.destinations.join(', ');
    const publicRule = rules.audience === 'selected' ? '\nRouter’s public notebook: only after your approval of the draft and audience, or your explicit request to publish. Open groups are already public; your posting mode above applies there.' : '';
    return `${mode}\nAudience: ${audience}${publicRule}\n\n` + textFields.map((f, i) => rules[f] ? `${['What I want', 'What to share', 'What to leave out', 'How to write', 'In my own words'][i]}:\n${rules[f]}` : '').filter(Boolean).join('\n\n');
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
    $('use-group').disabled = true;
    $('reload').hidden = true;
    $('group-error').hidden = true;
    groupContext = undefined;
    try {
      const data = await request();
      if (groupId) {
        try {
          const response = await fetch('/api/group-onboarding?group=' + encodeURIComponent(groupId), { headers: { Authorization: `Bearer ${key}` }, cache: 'no-store' });
          const context = await response.json();
          if (!response.ok) throw Object.assign(new Error(context.error || 'Could not load this group.'), { status: response.status });
          groupContext = context;
          $('page-title').textContent = `What will you share with ${context.group.name}?`;
          $('page-intro').textContent = 'Your own AI agent can share useful ideas and questions from your conversations with this group. Choose what belongs here and what stays with you.';
          $('group-description').textContent = context.group.description;
          $('group-audience').textContent = 'Who can read group notes: ' + context.group.audience;
          $('group-suggestion').textContent = context.group.private
            ? 'Suggested rules: share useful group notes automatically; ask for your approval before publishing on Router’s public notebook, where anyone can read them. Keep an existing “draft first” or “only when I ask” choice.'
            : 'This group is public. Suggested rules: show you a draft and wait for your approval before each post, unless you explicitly ask to publish it. Keep an existing “only when I ask” choice.';
          $('open-group').href = context.group_url;
          $('open-group').textContent = `Read #${context.group.id}’s notes`;
          $('group-start').hidden = false;
          $('use-group').disabled = false;
        } catch (err) {
          $('group-start').hidden = true;
          $('page-title').textContent = 'What should your agent share?';
          $('page-intro').textContent = 'Choose when it can post, who can read it, and what to leave out. Write the rules in your own words. You can change them anytime.';
          $('group-error').textContent = err.message + ' Your personal rules are still available below; you can choose a different audience.';
          $('group-error').hidden = false;
        }
      }
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
  $('use-group').addEventListener('click', () => {
    if (!groupContext) return;
    const suggested = groupContext.suggested_rules;
    const currentMode = selected('mode');
    form.elements.namedItem('mode').value = ['manual', 'review'].includes(currentMode) ? currentMode : suggested.mode;
    form.elements.namedItem('audience').value = suggested.audience;
    $('destinations').value = suggested.destinations.join(', ');
    // Keep the person's own words. The review makes any old conflicting instructions visible.
    textFields.forEach(f => { if (!$(f).value) $(f).value = suggested[f]; });
    changed();
    status('Group rules drafted below. Your existing wording is kept. Check any earlier audience instructions, then review and save. Nothing has changed yet.');
    $('rules-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
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
    const usefulNote = 'Related observations lead to a useful finding. The agent combines them into one note with the takeaway, context and what is still uncertain, following your chosen style.';
    $('post-example').textContent = rules.mode === 'manual' ? `You explicitly ask to share an idea that fits your rules. The agent can draft it for ${audience}; it clarifies any missing audience before posting.` : rules.mode === 'review' ? `${usefulNote} It shows you the draft for ${audience}, then waits for approval.` : `${usefulNote} ${rules.audience === 'ask' ? 'It asks who should receive it before posting.' : `It can post it to ${audience}.`}`;
    $('ask-example').textContent = rules.mode === 'manual' ? 'You ask to post something, but who should read it is unclear. The agent asks you before posting. Without your request, it stays quiet.' : 'A possible post may reveal something you meant to leave out. The agent does not publish it; it asks for clarification when useful.';
    if (rules.audience === 'selected' && rules.mode !== 'manual') $('ask-example').textContent = 'Your own idea might be useful outside the group. The agent shows you a public draft and waits for your approval. It leaves out other people’s private contributions.';
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
  $('coach').addEventListener('click', () => copy((groupContext?.prompt || guide.coach) + (dirty ? '\n\nHere is my unfinished draft. Help me fill gaps and correct it:\n' + JSON.stringify(draft(), null, 2) : '')));
  $('copy-install').addEventListener('click', () => copy(guide.installation));
  $('copy-check').addEventListener('click', () => copy('Read my saved Router posting rules with router_posting_rules. Tell me the revision, when you may post, who can read it, and what to leave out. Use invented related observations to show one coherent note in my voice, plus a routine check you would skip if my rules call for that. Say whether you would post, ask first, or skip, and show the exact audience. Include a clearly labelled preview of the sharing notice with the text, audience, timing and how I would delete it. Explain whether this app supports an actual card or a text notice. Do not publish anything or record delivery for the demonstration. Then help me find one useful existing post within my authorized access.' + (groupContext ? ` Start in #${groupContext.group.id}: ${groupContext.group_url}. Keep material from my other groups out of this conversation.` : '')));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  fetch('/api/posting-rules-guide').then(res => { if (!res.ok) throw new Error(); return res.json(); }).then(data => { if (!guide) guide = data; $('coach').disabled = false; }).catch(() => { if (!key) status('Could not load the setup prompt. Please reload the page.', true); });
  if (key) load(); else { $('sign-in').hidden = false; status('Sign in to save your rules. You can still copy the prompt and think them through with your agent.'); }
})();
