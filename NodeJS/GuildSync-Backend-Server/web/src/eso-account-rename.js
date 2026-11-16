const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function createEsoAccountRename({context, request, render, renamed}) {
  let state = {}, generation = 0;
  const reset = () => { generation++; state = {}; };
  const current = (key, version) => version === generation && key === context().key && context().allowed;
  async function submit(confirm = false) {
    const target = context();
    if (!target.allowed || !target.accountName || state.busy) return;
    if (confirm && (!state.preview || state.preview.conflict || !state.preview.token)) return;
    const version = ++generation, newAccountName = state.preview?.newAccountName || state.name;
    state.busy = true; state.error = ''; render();
    try {
      const response = await request(confirm ? 'guildsync:rename-eso-account' : 'guildsync:preview-eso-account-rename', {
        accountName: target.accountName, newAccountName, ...(confirm ? {token:state.preview.token} : {})
      });
      if (!current(target.key, version)) return;
      if (!response?.ok) throw new Error(response?.message || response?.error || 'Unable to change ESO account name.');
      if (confirm) { reset(); await renamed(response.newAccountName || newAccountName); return; }
      state.preview = response.preview;
      if (!state.preview) throw new Error('The rename preview was unavailable.');
    } catch (error) { if (current(target.key, version)) state.error = error.message || String(error); }
    finally { if (current(target.key, version)) { state.busy = false; render(); } }
  }
  return {reset, submit, html() {
    const target = context();
    if (!target.allowed || !target.accountName) return '';
    if (!state.open) return '<button type="button" id="openEsoAccountRename">Change ESO account name</button>';
    const preview = state.preview;
    return `<div class="eso-account-rename"><label for="esoAccountRenameInput">New ESO account name</label>
      <input id="esoAccountRenameInput" value="${escape(state.name)}" ${state.busy || preview ? 'disabled' : ''} />
      ${preview ? `<div class="eso-account-rename-preview">Change <strong>${escape(preview.accountName)}</strong> to <strong>${escape(preview.newAccountName)}</strong>.
        <div>${Object.entries(preview.counts || {}).map(([name,count]) => `${escape(({roster:'Roster',rankHistory:'Rank history',events:'History events',links:'Discord links',banking:'Banking entries',applications:'Applications',users:'GuildSync accounts'})[name]||name)}: ${escape(count)}`).join(' · ')}</div>
        ${preview.aliases?.length ? `<div>Known names: ${preview.aliases.map(escape).join(', ')}</div>` : ''}
        <div>${escape(preview.message || '')}</div>${preview.conflict ? '<div role="alert">This change cannot be confirmed until the issue above is resolved.</div>' : ''}</div>` : ''}
      ${state.error ? `<div class="discord-data-error" role="alert">${escape(state.error)}</div>` : ''}
      <button type="button" id="submitEsoAccountRename" ${state.busy || (preview && (preview.conflict || !preview.token)) ? 'disabled' : ''}>${state.busy ? 'Working…' : preview ? 'Confirm name change' : 'Preview change'}</button>
      <button type="button" id="cancelEsoAccountRename" ${state.busy ? 'disabled' : ''}>Cancel</button></div>`;
  }, wire(root) {
    root.querySelector('#openEsoAccountRename')?.addEventListener('click', () => { reset(); state.open = true; state.name = ''; render(); root.querySelector('#esoAccountRenameInput')?.focus(); });
    root.querySelector('#esoAccountRenameInput')?.addEventListener('input', event => { state.name = event.target.value; state.preview = null; });
    root.querySelector('#submitEsoAccountRename')?.addEventListener('click', () => submit(!!state.preview));
    root.querySelector('#cancelEsoAccountRename')?.addEventListener('click', () => { reset(); render(); });
  }};
}
