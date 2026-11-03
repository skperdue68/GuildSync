export function createDesktopSupport({onBlocked}) {
 let info=null;
 return {
  get blocked(){return info!==null;},get info(){return info;},
  receive(payload) {
   if(info || payload?.supported!==false)return !!info;
   let downloadUrl='';
   try{const url=new URL(payload.download_url||payload.download?.url);if(['https:','http:'].includes(url.protocol))downloadUrl=url.href;}catch{}
   info={message:String(payload.message||'This version of GuildSync is no longer supported. Install the latest version to continue.'),
    minimumVersion:String(payload.minimum_desktop_version||''),latestVersion:String(payload.latest_version||''),downloadUrl};
   onBlocked(info);return true;
  }
 };
}
