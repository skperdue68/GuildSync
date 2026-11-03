function parse(value) {
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(String(value||''));
 if(!match || match[4]?.split('.').some(part=>/^\d+$/.test(part)&&part.length>1&&part[0]==='0'))return null;
 return {parts:match.slice(1,4).map(BigInt),pre:match[4]?.split('.')||[]};
}
export function compareDesktopVersions(a,b) {
 const left=parse(a),right=parse(b);if(!left||!right)throw Error('Invalid desktop release version.');
 for(let i=0;i<3;i++)if(left.parts[i]!==right.parts[i])return left.parts[i]>right.parts[i]?1:-1;
 if(!left.pre.length||!right.pre.length)return left.pre.length===right.pre.length?0:left.pre.length?-1:1;
 for(let i=0;i<Math.max(left.pre.length,right.pre.length);i++) {
  const x=left.pre[i],y=right.pre[i];if(x===y)continue;if(x===undefined||y===undefined)return x===undefined?-1:1;
  const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);
  if(xn&&yn)return BigInt(x)>BigInt(y)?1:-1;
  if(xn!==yn)return xn?-1:1;return x>y?1:-1;
 }
 return 0;
}
export function createDesktopVersionPolicy({minimum='',latest,download=()=>null,fallbackUrl,timeoutMs=15000}) {
 minimum=String(minimum||'').trim();
 if(minimum&&!parse(minimum))throw Error('GUILDSYNC_MIN_DESKTOP_VERSION must be blank or a release version such as 1.5.0.');
 const fallback=new URL(fallbackUrl||'https://github.com/skperdue68/GuildSync/releases/latest');
 if(!['http:','https:'].includes(fallback.protocol))throw Error('GUILDSYNC_DESKTOP_UPDATE_URL must be an HTTP(S) URL.');
 function status(identity={}) {
  const version=String(identity.version||'').trim(),desktop=identity.client_type!=='web';
  const supported=!(minimum&&desktop&&(!parse(version)||compareDesktopVersions(version,minimum)<0));
  let installer=download(identity.platform||identity.os||identity.operating_system);
  if(!supported&&installer&&(!parse(installer.version)||compareDesktopVersions(installer.version,minimum)<0))installer=null;
  const latestVersion=minimum&&parse(latest)&&compareDesktopVersions(minimum,latest)>0?minimum:latest;
  const updateRequired=!supported || !!installer&&(!parse(version)||compareDesktopVersions(version,installer.version)<0);
  return {ok:supported,supported,minimum_desktop_version:minimum||null,client_version:version,latest_version:latestVersion,
   release_version:latest,update_required:updateRequired,download_available:!!installer,download:installer,
   platform:identity.platform||'',download_url:installer?.url||fallback.href,download_file_name:installer?.file_name||'',
   message:!supported?`This version of GuildSync (${version||'unknown'}) is no longer supported. Install the latest version to continue. Minimum supported desktop version: ${minimum}.`
    :updateRequired?`GuildSync ${version||'unknown'} is out of date. Latest version is ${latestVersion}.`
    :`GuildSync ${version||'unknown'} is supported.`};
 }
 function reject(socket,result) {
  socket.guildSyncVersionAdmitted=false;
  socket.emit('guildsync:version-status',result);
  socket.disconnect(true);
 }
 function admit(socket,register) {
  socket.guildSyncVersionAdmitted=false;
  const accept=()=>{socket.guildSyncVersionAdmitted=true;register();};
  if(!minimum || ['discord-bot','voice-mute'].includes(socket.guildSyncAuthType))return accept();
  let timer;
  const finish=identity=>{
   clearTimeout(timer);socket.off('guildsync:client-version',firstReport);
   const result=status(identity);
   if(!result.supported)return reject(socket,result);
   socket.guildSyncClientIdentity=identity;accept();socket.emit('guildsync:version-status',result);
  };
  const firstReport=payload=>finish(payload&&typeof payload==='object'?payload:{});
  const auth=socket.handshake.auth||{};
  if(auth.client_type && (auth.version||auth.client_type==='web'))return finish(auth);
  // No application listeners or broadcast rooms exist until an older client identifies itself.
  socket.on('guildsync:client-version',firstReport);
  timer=setTimeout(()=>finish({client_type:'wails'}),timeoutMs);timer.unref?.();
  socket.once('disconnect',()=>clearTimeout(timer));
 }
 return {status,admit,reject};
}
