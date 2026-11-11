const aliases=[['gangster','gangsters'],['associate','associates'],['soldier','soldiers'],['capo','capos'],
  ['caporegime','caporegimes','caporegieme','caporegiemes'],['consigliere','consiglieri','consiglieres'],['kingpin','kingpins']];
const normalized=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
const canonical=value=>aliases.find(group=>group.includes(normalized(value)))?.[0] || normalized(value);
const account=value=>String(value||'').trim().replace(/^@/,'').toLowerCase();
const safe=value=>String(value||'').replace(/[\r\n`*_<>@]/g,'').slice(0,100);

export function appendReturningMemberNotice(message,notice) {
  if(!notice)return message;
  const suffix='\n\n'+notice;
  let prefix=String(message).slice(0,Math.max(0,2000-suffix.length-4));
  if((prefix.split('```').length-1)%2)prefix+='\n```';
  return prefix+suffix;
}

export async function restoreReturningMemberRank(guild,payload,{rankRefs='',officerRef='Consigliere',log=()=>{}}={}) {
  if(!payload.returningMember)return {notice:'',roleMentions:[]};
  const historical=payload.returningMember;
  const roles=await guild.roles.fetch(),all=[...roles.values()];
  const officers=all.filter(role=>String(role.id)===officerRef || canonical(role.name)===canonical(officerRef));
  const officer=officers.length===1?officers[0]:null;
  const mention=officer?`<@&${officer.id}>`:'Consigliere (role could not be resolved)';
  const applicant=safe(payload.applicantAccount)||'This member';
  const result=notice=>({notice:`**Returning member:** ${applicant} ${notice} ${mention}`,roleMentions:officer?[officer.id]:[]});
  // Every notice opens with the applicant and the rank we already know about so
  // officers do not have to look either up, then says what happened on Discord.
  const rawRank=safe(historical.rankName);
  // A stored rank of "Unknown" carries no more information than a missing one.
  const recordedRank=/^unknown$/i.test(rawRank.trim())?'':rawRank;
  const promotion=`held AM Rank **${recordedRank}** and should be promoted in game. `;
  const refs=String(rankRefs||'').split(',').map(v=>v.trim()).filter(Boolean);
  const rankOf=role=>refs.length?refs.findIndex(ref=>/^\d+$/.test(ref)?String(role.id)===ref:canonical(role.name)===canonical(ref))
    :aliases.findIndex(group=>group.includes(normalized(role.name)));
  const targets=recordedRank?all.filter(role=>canonical(role.name)===canonical(recordedRank) && rankOf(role)>=0):[];
  const linked=[...new Set(historical.discordUserIds||[])];
  const resolveMember=async()=>{
    if(linked.length>1)return {reason:'multipleLinks'};
    if(linked.length===1)return {member:await guild.members.fetch({user:linked[0],force:true})};
    const members=await guild.members.fetch();
    const matches=[...members.values()].filter(candidate=>!candidate.user?.bot &&
      [candidate.user?.username,candidate.user?.globalName,candidate.nickname,candidate.displayName].some(name=>name && account(name)===account(payload.applicantAccount)));
    return matches.length===1?{member:matches[0]}:{reason:'noMatch'};
  };
  try {
    if(!recordedRank) {
      // No ESO rank and no linked Discord account leaves nothing to report: without a
      // link there is no evidence of a previous stint, so this is a new member and the
      // post gets no returning-member line at all.
      if(!linked.length)return {notice:'',roleMentions:[]};
      // ESO is the source of authority, so with no rank on record there is nothing to
      // restore. A linked member's Discord rank is the only evidence left, and it is
      // reported as advice because GuildSync cannot write ranks into ESO.
      const {member,reason}=await resolveMember();
      if(reason==='multipleLinks')return result('has no ESO rank on record, and more than one confirmed account link exists. Please review the links and confirm the in-game rank.');
      if(!member || member.user?.bot)return result('has no ESO rank on record, and no unique linked Discord account could be identified. An officer should confirm the in-game rank.');
      const held=[...member.roles.cache.values()].filter(role=>rankOf(role)>=0);
      if(!held.length)return result('has no ESO rank on record and holds no guild rank role in Discord. An officer should confirm the in-game rank.');
      const highest=held.reduce((best,role)=>rankOf(role)>rankOf(best)?role:best);
      // The ESO roster keeps the rank after someone leaves. When the Discord rank is the
      // same rank, the member is already equivalent and no promotion is needed.
      const esoSide=safe(historical.rosterRank).trim(),esoSideRank=esoSide?rankOf({id:'',name:esoSide}):-1;
      if(esoSide && canonical(esoSide)===canonical(highest.name)) {
        log(`Returning member ${payload.applicantAccount}: Discord ${member.id} holds ${highest.name}, equivalent to ESO ${esoSide}; no promotion advised.`);
        return result(`has no ESO rank change on record, and their Discord **${safe(highest.name)}** already matches their **${esoSide}** ESO rank, so no in-game promotion is needed.`);
      }
      if(esoSide && esoSideRank>=0 && rankOf(highest)<esoSideRank)
        return result(`has no ESO rank change on record, and their **${esoSide}** ESO rank is already above their Discord **${safe(highest.name)}**, so no in-game promotion is needed.`);
      const entry=Math.min(...all.map(rankOf).filter(index=>index>=0));
      if(rankOf(highest)<=entry)return result(`has no ESO rank on record and holds only **${safe(highest.name)}** in Discord. An officer should confirm the in-game rank.`);
      log(`Returning member ${payload.applicantAccount}: no ESO rank on record; Discord ${member.id} holds ${highest.name}.`);
      return result(`has no ESO rank on record, but holds **${safe(highest.name)}** in Discord and should be promoted in game to match.`);
    }
    if(targets.length!==1)return result(`${promotion}Their Discord rank could not be updated because the Discord rank role is missing or ambiguous. Please review the Discord rank roles.`);
    const target=targets[0],desiredRank=rankOf(target);
    if(!officer || !/^\d{1,32}$/.test(String(historical.actorDiscordId||''))) {
      return result(`${promotion}Their Discord rank was not restored automatically because a verified officer uploader is required.`);
    }
    const actor=await guild.members.fetch({user:historical.actorDiscordId,force:true});
    const actorRank=Math.max(-1,...[...(actor?.roles?.cache?.values()||[])].map(rankOf));
    const officerRank=rankOf(officer);
    if(!actor || actor.user?.bot || !(actor.roles.cache.has(officer.id) || officerRank>=0 && actorRank>=officerRank)) {
      return result(`${promotion}Their Discord rank was not restored automatically because the application uploader does not currently have officer rank.`);
    }
    if(desiredRank>actorRank)return result(`${promotion}Their Discord rank was not restored automatically because the recorded rank is above the uploader's current guild rank. A higher-ranked officer must review it.`);
    const {member,reason}=await resolveMember();
    if(reason==='multipleLinks')return result(`${promotion}Their Discord rank was not restored automatically because more than one confirmed account link exists. Please review the links.`);
    if(reason==='noMatch')return result(`${promotion}A Discord account could not be identified for automatic promotion because no unique matching Discord member was found. Please review the Discord link.`);
    if(!member || member.user?.bot)return result(`${promotion}A Discord account could not be identified for automatic promotion. Please review the Discord link.`);
    const current=[...member.roles.cache.values()],highest=current.reduce((best,role)=>rankOf(role)>rankOf(best)?role:best,target);
    const effective=rankOf(highest)>desiredRank?highest:target;
    const alreadyHadTarget=member.roles.cache.has(target.id);
    if(effective.id===target.id && !alreadyHadTarget)await member.roles.add(target.id,'GuildSync returning member: latest recorded ESO rank change');
    const lower=current.filter(role=>rankOf(role)>=0 && rankOf(role)<rankOf(effective));
    let cleanup='';
    if(lower.length) {
      try{await member.roles.remove(lower.map(role=>role.id),'GuildSync returning member: remove lower guild ranks');}
      catch(error){log(`Returning member lower-rank cleanup failed for ${member.id}: ${error.message}`);cleanup=' Some lower Discord roles could not be removed; please review them.';}
    }
    const retained=effective.id!==target.id;
    log(`Returning member ${payload.applicantAccount}: Discord ${member.id}, historical ${historical.rankName}, effective ${effective.name}.`);
    return result(`${promotion}${retained?'Their Discord account already holds a higher rank':alreadyHadTarget?'Their Discord account already held the correct rank':'Their Discord account was promoted automatically to'} **${safe(effective.name)}**.${cleanup}`);
  } catch(error) {
    log(`Returning member rank restoration failed for ${payload.applicantAccount}: ${error.message}`);
    return result(recordedRank?`${promotion}Their Discord rank could not be restored automatically. Please check bot permissions/account linking.`
      :'has no ESO rank on record, and their linked Discord account could not be checked. An officer should confirm the in-game rank.');
  }
}
