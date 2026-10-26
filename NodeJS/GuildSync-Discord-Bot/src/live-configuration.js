const allowed=new Set([
 ...['ENABLED','ALLOWED_ROLE_IDS','RANK_ROLE_IDS'].map(k=>'GUILDSYNC_VOICE_MUTE_'+k),
 ...['ENABLED','PROMOTION_ENABLED','PROMOTION_NOTIFY_ENABLED','REMINDER_ENABLED','REMINDER_HOURS','NOTIFICATION_MODE','CHANNEL_ID','GANGSTER_ROLE_ID','ASSOCIATE_ROLE_ID','PROMOTION_MESSAGE','REMINDER_MESSAGE'].map(k=>'GUILDSYNC_ONBOARDING_'+k),
 ...['ANNOUNCEMENTS_ENABLED','CHANNEL_ID','INTERVAL_HOURS','ANNOUNCE_ON_PURCHASE','BIWEEKLY_THRESHOLD','MONTHLY_THRESHOLD','BONUS_REMINDER_HOURS','SALES_CLOSE_REMINDER_HOURS','ARCHIVE_ANNOUNCEMENTS_ENABLED','ARCHIVE_CHANNEL_IDS'].map(k=>'GUILDSYNC_RAFFLE_'+k)
]);
export function createLiveConfiguration({env=process.env,start}) {
 const baseline={...env};
 let tail=Promise.resolve(),stops=[],signature,epoch=0,suspended=false,latest;
 const defaults=keys=>Object.fromEntries(keys.filter(item=>allowed.has(item.key)).map(item=>[
  item.key,baseline[item.key]===undefined||baseline[item.key]===''?item.defaultValue:baseline[item.key]
 ]));
 const effectiveEnvironment=configuration=>{
  const effective={...baseline,...defaults(configuration.keys || [])};
  for(const [key,value] of Object.entries(configuration.overrides || {})) {
   if(!allowed.has(key))throw Error('Unsupported bot configuration setting.');
   effective[key]=String(value);
  }
  return effective;
 };
 const fingerprint=env=>JSON.stringify(Object.fromEntries([...allowed].map(key=>[key,env[key]])));
 return {
  defaults,
  pause() {
   suspended=true;epoch++;signature=undefined;latest=undefined;
   // Remove listeners synchronously, before another socket connect event.
   const stopping=Promise.all(stops.splice(0).map(stop=>stop()));
   tail=Promise.all([tail,stopping]).then(()=>{}).catch(()=>{});
   return tail;
  },
  apply(configuration,{force=false,resume=false}={}) {
   // A broadcast can arrive while a reconnect refresh is still awaiting its reply.
   if(!latest || (configuration.revision ?? 0)>=(latest.revision ?? 0))latest=configuration;
   const requestedEpoch=epoch;
   const job=tail.then(async()=>{
    if(requestedEpoch!==epoch || suspended&&!resume)return;
    if(!force && signature===fingerprint(effectiveEnvironment(latest)))return;
    await Promise.all(stops.splice(0).map(stop=>stop()));
    if(requestedEpoch!==epoch)return;
    // Select the latest snapshot after draining, so updates cannot be lost in that wait.
    const effective=effectiveEnvironment(latest);
    const created=(await start(effective)) || [];
    if(requestedEpoch!==epoch) {
     await Promise.all(created.map(stop=>stop()));
     return;
    }
    stops=created;signature=fingerprint(effective);suspended=false;
   });
   tail=job.catch(()=>{});
   return job;
  }
 };
}
