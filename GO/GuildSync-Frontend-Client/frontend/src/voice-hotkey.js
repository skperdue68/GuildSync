import {createShortcutCapture} from './shortcut-capture.js';
export function createVoiceHotkeyController({ bridge, eventsOn, getSocket, authenticated, changed = () => {} }) {
  let settings = { enabled: false, shortcut: 'Ctrl+M', supported: false };
  let held = false, sessionId = null, timer = null, capturing = false, message = '', initialized = false;
  let releasePending=Promise.resolve({ok:true});
  let eligible=false, nativeActive=false, nativeFailed=false, accessTimer=null, accessGeneration=0, accessPending=null;
  const notify = () => changed();
  const request = (state, id, callback) => {
    const socket = getSocket();
    if (socket?.connected) socket.emit('guildsync:voice-mute-hotkey', { state, sessionId: id }, callback);
  };
  function release() {
    clearInterval(timer); timer = null;
    const id = sessionId; sessionId = null;
    if (id) {
      releasePending=new Promise(resolve=>{
        const socket=getSocket();
        if(!socket?.connected)return resolve({ok:false,message:'Voice mute cleanup requires a connected server.'});
        const timeout=setTimeout(()=>resolve({ok:false,message:'Voice mute release was not confirmed. Wait for recovery before switching accounts.'}),16000);
        timeout.unref?.();
        request('released',id,response=>{clearTimeout(timeout);resolve(response||{ok:false,message:'Voice mute release was not confirmed.'});});
      });
    }
    return releasePending;
  }
  function edge({ state, message: nativeMessage }) {
    if (state === 'configured') { message = nativeMessage || ''; notify(); return; }
    if (state === 'error') {
      nativeFailed = true;
      held = false; release();
      message = nativeMessage || 'Global voice hotkey listener stopped.';
      void listener(false); notify(); return;
    }
    if (state === 'released') { held = false; release(); return; }
    if (state !== 'pressed' || held) return;
    held = true;
    if (!eligible || !settings.enabled || capturing || !authenticated() || !getSocket()?.connected) return;
    const id = crypto.randomUUID(); sessionId = id;
    request('pressed', id, response => {
      if (id !== sessionId) return;
      if (!response?.ok) { message = response?.message || 'Voice mute was rejected.'; release(); notify(); return; }
      message = 'Hold to mute active'; notify();
    });
    if (sessionId !== id) return;
    timer = setInterval(() => {
      if (!eligible || !held || !authenticated() || !getSocket()?.connected) { release(); return; }
      if (sessionId !== id) { release(); return; }
      request('heartbeat', id, response => {
        if (id === sessionId && !response?.ok) { message = response?.message || 'Voice mute ended.'; release(); notify(); }
      });
    }, 2000);
  }
  async function initialize() {
    if (initialized) return; initialized = true;
    eventsOn('guildsync:voice-hotkey', edge);
    try { settings = await bridge.GetVoiceHotkeySettings(); } catch (error) { message = String(error); }
    notify();
  }
  async function connection(connected,{waitForRelease=false}={}) {
    await initialize();
    clearInterval(accessTimer);accessTimer=null;
    if (!connected) { accessGeneration++;accessPending=null;eligible=false;nativeFailed=false;const released=release();cancelCapture();await listener(false);if(waitForRelease){const result=await released;if(!result?.ok)throw Error(result?.message||'Voice mute release was not confirmed.');}notify();return; }
    await refreshAccess();
    if(getSocket()?.connected){accessTimer=setInterval(()=>void refreshAccess(),30000);accessTimer.unref?.();}
  }
  async function listener(active) {
    if(active && nativeFailed)return;
    if(nativeActive===active)return;nativeActive=active;
    try{await bridge.SetVoiceHotkeyActive(active);}catch(error){nativeActive=false;nativeFailed=true;message=String(error);notify();}
  }
  async function refreshAccess() {
    if(accessPending)return accessPending;
    const generation=++accessGeneration,current=getSocket();
    const pending=(async()=>{
      await initialize();let response;
      if(authenticated()&&current?.connected)response=await new Promise(resolve=>{
        const timeout=setTimeout(()=>resolve(null),5000);
        current.emit('guildsync:voice-mute-access',{},value=>{clearTimeout(timeout);resolve(value);});
      });
      if(generation!==accessGeneration||current!==getSocket())return;
      const next=Boolean(current?.connected&&authenticated()&&response?.ok===true&&response.enabled===true&&response.allowed===true);
      const changedAccess=eligible!==next;eligible=next;
      if(!eligible){release();cancelCapture();}
      await listener(eligible && settings.enabled && settings.supported);
      if(changedAccess)notify();
    })();
    accessPending=pending;
    try{await pending;}finally{if(accessPending===pending)accessPending=null;}
  }
  async function invalidateAccess() {
    accessGeneration++;accessPending=null;eligible=false;release();cancelCapture();notify();await listener(false);
    await refreshAccess();
  }
  async function save(enabled, shortcut) {
    nativeFailed = false; message = '';
    release(); cancelCapture();
    try { settings = await bridge.SetVoiceHotkeySettings(enabled, shortcut); await listener(eligible && settings.enabled && settings.supported); }
    catch (error) { nativeFailed = true; message = String(error); await listener(false); try { settings = await bridge.GetVoiceHotkeySettings(); } catch {} }
    notify();
  }
  function cancelCapture() {
    if (!capturing) return;
    capturing = false; shortcutCapture.cancel(); document.removeEventListener('keydown', capture, true);
document.removeEventListener('keyup', captureUp, true);window.removeEventListener('blur', captureBlur);
    void bridge.SetVoiceHotkeyCapture(false);
  }
  const shortcutCapture=createShortcutCapture({
    save:shortcut=>void save(settings.enabled,shortcut),
    cancel:()=>{cancelCapture();message='';notify();},
    error:error=>{message=error;notify();},
    changed:shortcut=>{message=shortcut+' â€” release all keys to save';notify();}
  });
  function capture(event){shortcutCapture.keydown(event);}
  function captureUp(event){shortcutCapture.keyup(event);}
  function captureBlur(){shortcutCapture.cancel();}
  function render() {
    if(!eligible)return '';
    if (!settings.supported) return '<div id="voiceHotkeySection" class="profile-section"><strong>Voice Channel Mute</strong><p>Global voice hotkeys are unavailable in this desktop session. Linux needs X11 or a Wayland desktop with the Global Shortcuts portal.</p></div>';
    // Shortcut labels are validated by Go; messages are inserted using textContent below.
    return `<div id="voiceHotkeySection" class="profile-section"><strong>Voice Channel Mute</strong>${nativeFailed ? '<p>Voice mute is unavailable in this desktop session. GuildSync can still be used. Check the message below, then disable and re-enable the hotkey to retry.</p>' : ''}<label class="profile-row voice-hotkey-row">Enable <input id="voiceHotkeyEnabled" type="checkbox" ${settings.enabled ? 'checked' : ''}></label><div class="profile-row voice-hotkey-row">Shortcut <span>${settings.shortcut}</span></div><button id="voiceHotkeyCapture" type="button" class="voice-hotkey-capture-button">${capturing ? 'Press shortcut (Escape cancels)' : 'Set Hotkey'}</button><p id="voiceHotkeyStatus" class="voice-hotkey-help" role="status"></p><p class="voice-hotkey-help">Hold the shortcut to mute eligible lower-ranked channel members. Server permission is required.</p></div>`;
  }
  function wire(menu) {
    menu.querySelector('#voiceHotkeyEnabled')?.addEventListener('change', event => void save(event.target.checked, settings.shortcut));
    menu.querySelector('#voiceHotkeyCapture')?.addEventListener('click', async () => {
      release(); capturing = true; shortcutCapture.start(); message = 'Press one or more keys, then release all keys to save.'; await bridge.SetVoiceHotkeyCapture(true);
      document.addEventListener('keydown', capture, true);document.addEventListener('keyup', captureUp, true);window.addEventListener('blur',captureBlur); notify();
    });
    const status = menu.querySelector('#voiceHotkeyStatus'); if (status) status.textContent = message;
  }
  function close() { cancelCapture(); }
  function stop() { accessGeneration++;accessPending=null;clearInterval(accessTimer);accessTimer=null;eligible=false;release();cancelCapture();void listener(false);notify(); }
  return { initialize, connection, refreshAccess, invalidateAccess, render, wire, close, stop };
}

