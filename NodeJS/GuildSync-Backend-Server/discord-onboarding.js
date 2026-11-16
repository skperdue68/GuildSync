import {getEsoIdentitySourceDB,afterEsoIdentityUnlock} from './eso-account-identity.js';
import { createHash, randomUUID } from 'node:crypto';
import { createOnboardingStore } from './discord-onboarding-store.js';

const services=new WeakMap();
export async function notifyDiscordConfirmedLink(db,userId) {
 const service=services.get(getEsoIdentitySourceDB(db));
 if(service)await afterEsoIdentityUnlock(db,()=>service.observeConfirmedLink(userId).catch(error=>service.log('Onboarding link queue retry needed: '+error.message)));
}
export function createDiscordOnboarding(db,{store=createOnboardingStore(db),now=()=>Math.floor(Date.now()/1000),log=console.log,wake=()=>{}}={}) {
 const id=(g,u,kind,generation=0)=>createHash('sha256').update(g+':'+u+':'+kind+':'+generation).digest('hex');
 const reminderOn=config=>config?.enabled && config.reminderEnabled;
 async function enqueue(s,g,u,kind,esoName) {
  const existing=kind==='promotion'?(await s.jobs(g)).filter(j=>j.userId===u && j.kind===kind).sort((a,b)=>(b.generation || 0)-(a.generation || 0))[0]:await s.job(id(g,u,kind));
  let generation=0;
  if(existing) {
   if(kind==='promotion' && existing.status==='done') generation=(existing.generation || 0)+1;
   else {
   if(existing.status==='cancelled' && (kind==='promotion' || !existing.attemptAt)) {
    existing.status='pending';existing.claimToken=null;existing.leaseUntil=0;
    await s.putJob(existing);
   }
    return;
   }
  }
  await s.putJob({id:id(g,u,kind,generation),guildId:g,userId:u,kind,generation,esoName,status:'pending',leaseUntil:0,retryAt:0});
  log('Onboarding queued '+kind+' for '+u);
 }
 async function ensureMember(s,g,u) {
  let m=await s.member(g,u);
  if(!m) {m={guildId:g,userId:u,joinedAt:0,eligibleSince:null,present:true};await s.putMember(m);}
  return m;
 }
 async function check(s,g,job,state) {
  if(!state?.config.enabled || job.guildId!==g)return false;
  const member=await s.member(g,job.userId),linked=await s.confirmed(job.userId);
  if(!member?.present)return false;
  if(job.kind==='promotion')return Boolean(state.config.promotionEnabled && linked);
  return Boolean(reminderOn(state.config) && member.eligibleSince===state.reminderSince && member.eligibleSince!==null && !member.remindedAt && !linked && now()>=member.joinedAt+state.config.reminderHours*3600);
 }
 async function claimed(s,g,jobId,token) {
  const job=await s.job(jobId);
  if(!job || job.guildId!==g || job.status!=='pending' || job.claimToken!==token || job.leaseUntil<=now())throw Error('Onboarding claim expired or invalid.');
  return job;
 }
 const service={log,
  async configure(guildId,config) {
   for(const key of ['enabled','promotionEnabled','promotionNotifyEnabled','reminderEnabled'])if(typeof config?.[key]!=='boolean')throw Error('Invalid onboarding configuration: '+key);
   if(!['private_thread','channel'].includes(config.mode) || !Number.isFinite(config.reminderHours) || config.reminderHours<=0 || config.reminderHours>8760)throw Error('Invalid onboarding delivery configuration.');
   for(const key of ['channelId'])if(config[key] && !/^\d+$/.test(config[key]))throw Error('Invalid onboarding '+key);
   for(const key of ['gangsterRoleId','associateRoleId'])if(config[key] && (typeof config[key]!=='string' || /[,\x00-\x1f\x7f@]/.test(config[key])))throw Error('Invalid onboarding '+key);
   await store.atomic(guildId,async s=>{
    const old=await s.state(guildId),oldOn=reminderOn(old?.config),newOn=reminderOn(config);
    const cutoff=newOn?(oldOn?old.reminderSince:now()):null;
    await s.putState({guildId,config,reminderSince:cutoff,updatedAt:now()});
    if(!newOn || !oldOn) for(const m of await s.members(guildId)) {m.eligibleSince=null;await s.putMember(m);}
   });
   wake();return {configured:true};
  },
  async observeMember(guildId,member) {
   if(member.bot || !member.discord_id)return;
   await store.atomic(guildId,async s=>{
    const state=await s.state(guildId);if(!state?.config.enabled)return;
    const u=String(member.discord_id),m=await ensureMember(s,guildId,u);
    const joined=typeof member.joined_at==='number'?member.joined_at:Math.floor(Date.parse(member.joined_at)/1000);
    const newJoin=Number.isFinite(joined) && joined!==m.joinedAt;
    if(Number.isFinite(joined))m.joinedAt=joined;
    m.present=member.present!==false;
    if(!m.present)m.eligibleSince=null;
    else if(newJoin && reminderOn(state.config) && joined>state.reminderSince && !m.remindedAt)m.eligibleSince=state.reminderSince;
    await s.putMember(m);
   });wake();
  },
  async observeConfirmedLink(userId) {
   for(const state of await store.states())if(state.config.enabled)await store.atomic(state.guildId,async s=>{
    const linked=await s.confirmed(userId);if(!linked)return;
    const m=await ensureMember(s,state.guildId,userId);m.eligibleSince=null;await s.putMember(m);
    if(state.config.promotionEnabled && (await s.promotionCandidates(state.config)).includes(userId))await enqueue(s,state.guildId,userId,'promotion',linked);
   });wake();
  },
  async claim(guildId) {return store.atomic(guildId,async s=>{
   const state=await s.state(guildId);if(!state?.config.enabled)return null;
   if(state.config.promotionEnabled)for(const u of await s.promotionCandidates(state.config)) {
    const m=await ensureMember(s,guildId,u);
    if(m.present)await enqueue(s,guildId,u,'promotion',await s.confirmed(u));
   }
   for(const m of await s.members(guildId))if(m.present && m.eligibleSince!==null && m.eligibleSince===state.reminderSince && !m.remindedAt && now()>=m.joinedAt+state.config.reminderHours*3600) {
    if(await s.confirmed(m.userId)){m.eligibleSince=null;await s.putMember(m);}
    else if(reminderOn(state.config))await enqueue(s,guildId,m.userId,'reminder');
   }
   const jobs=(await s.jobs(guildId)).sort((a,b)=>(a.retryAt || 0)-(b.retryAt || 0) || a.id.localeCompare(b.id));
   for(const job of jobs) {
    if(job.status!=='pending' || job.leaseUntil>now() || job.retryAt>now())continue;
    if(job.kind==='promotion' && job.roleChanged && job.deliveryConfig?.promotionNotifyEnabled && !state.config.promotionNotifyEnabled)continue;
    if(!await check(s,guildId,job,state)){job.status='cancelled';await s.putJob(job);continue;}
    job.deliveryConfig ||= structuredClone(state.config);job.claimToken=randomUUID();job.leaseUntil=now()+300;await s.putJob(job);
    const member=await s.member(guildId,job.userId);
    return {...job,threadId:job.threadId || (member.threadChannelId===job.deliveryConfig.channelId?member.threadId:undefined),config:job.deliveryConfig,previousMessageIds:jobs.filter(j=>j.userId===job.userId && j.status==='done' && j.messageId).map(j=>j.messageId)};
   }return null;
  });},
  async validate(g,j,t) {return store.atomic(g,async s=>{const job=await claimed(s,g,j,t),state=await s.state(g);return {valid:await check(s,g,job,state),notificationEnabled:job.kind!=='promotion'||Boolean(state?.config.promotionNotifyEnabled),esoName:await s.confirmed(job.userId)};});},
  async progress(g,j,t,patch) {return store.atomic(g,async s=>{
   const job=await claimed(s,g,j,t),allowed=['threadId','destinationId','roleStarted','roleChanged','content','attemptAt','messageId'];
   for(const key of allowed)if(patch[key]!==undefined)job[key]=patch[key];
   job.leaseUntil=now()+300;await s.putJob(job);
   if(patch.threadId){const m=await s.member(g,job.userId);m.threadId=patch.threadId;m.threadChannelId=job.deliveryConfig?.channelId;await s.putMember(m);}
   return {saved:true};
  });},
  async finish(g,j,t,result) {return store.atomic(g,async s=>{
   const job=await claimed(s,g,j,t);job.claimToken=null;job.leaseUntil=0;
   if(result.done){job.status='done';job.completedAt=now();job.messageId=result.messageId || job.messageId;
    const m=await s.member(g,job.userId);
    if(job.kind==='reminder')m.remindedAt=now();else if(result.promoted!==false)m.promotedAt=now();
    m.eligibleSince=null;await s.putMember(m);
   }else if(result.cancelled){job.status='cancelled';job.retryAt=now()+60;const m=await s.member(g,job.userId);if(!m.present || await s.confirmed(job.userId))m.eligibleSince=null;await s.putMember(m);}
   else {job.retryAt=now()+60;job.lastError=String(result.error || 'Retry requested').slice(0,1000);}
   await s.putJob(job);return {completed:job.status==='done'};
  });}
 };
 if(db)services.set(db,service);return service;
}
