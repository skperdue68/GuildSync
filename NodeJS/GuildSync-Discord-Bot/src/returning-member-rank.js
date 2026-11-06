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
  const recordedRank=safe(historical.rankName);
  const promotion=recordedRank?`held AM Rank **${recordedRank}** and should be promoted in game. `:'has no recorded AM rank; an officer should confirm the in-game rank. ';
  const refs=String(rankRefs||'').split(',').map(v=>v.trim()).filter(Boolean);
  const rankOf=role=>refs.length?refs.findIndex(ref=>/^\d+$/.test(ref)?String(role.id)===ref:canonical(role.name)===canonical(ref))
    :aliases.findIndex(group=>group.includes(normalized(role.name)));
  const targets=all.filter(role=>canonical(role.name)===canonical(historical.rankName) && rankOf(role)>=0);
  if(targets.length!==1)return result(`${promotion}Their Discord rank could not be updated because the Discord rank role is missing or ambiguous. Please review the Discord rank roles.`);
  const target=targets[0],desiredRank=rankOf(target);
  try {
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
    let member;
    const ids=[...new Set(historical.discordUserIds||[])];
    if(ids.length>1)return result(`${promotion}Their Discord rank was not restored automatically because more than one confirmed account link exists. Please review the links.`);
    if(ids.length===1)member=await guild.members.fetch({user:ids[0],force:true});
    else {
      const members=await guild.members.fetch();
      const matches=[...members.values()].filter(candidate=>!candidate.user?.bot &&
        [candidate.user?.username,candidate.user?.globalName,candidate.nickname,candidate.displayName].some(name=>name && account(name)===account(payload.applicantAccount)));
      if(matches.length!==1)return result(`${promotion}A Discord account could not be identified for automatic promotion because no unique matching Discord member was found. Please review the Discord link.`);
      member=matches[0];
    }
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
    return result(`${promotion}Their Discord rank could not be restored automatically. Please check bot permissions/account linking.`);
  }
}
