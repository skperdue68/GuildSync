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
  const result=notice=>({notice:`**Returning member:** ${notice} ${mention}`,roleMentions:officer?[officer.id]:[]});
  const refs=String(rankRefs||'').split(',').map(v=>v.trim()).filter(Boolean);
  const rankOf=role=>refs.length?refs.findIndex(ref=>/^\d+$/.test(ref)?String(role.id)===ref:canonical(role.name)===canonical(ref))
    :aliases.findIndex(group=>group.includes(normalized(role.name)));
  const targets=all.filter(role=>canonical(role.name)===canonical(historical.rankName) && rankOf(role)>=0);
  if(targets.length!==1)return result(`Previous recorded rank: ${safe(historical.rankName)||'unknown'}. Discord rank could not be restored because the rank role is missing or ambiguous. Please review and promote in ESO as appropriate.`);
  const target=targets[0],desiredRank=rankOf(target);
  try {
    if(!officer || !/^\d{1,32}$/.test(String(historical.actorDiscordId||''))) {
      return result('Automatic Discord rank restoration needs a verified officer uploader or officer-requested repost. Please review the historical rank and promote in ESO.');
    }
    const actor=await guild.members.fetch({user:historical.actorDiscordId,force:true});
    const actorRank=Math.max(-1,...[...(actor?.roles?.cache?.values()||[])].map(rankOf));
    const officerRank=rankOf(officer);
    if(!actor || actor.user?.bot || !(actor.roles.cache.has(officer.id) || officerRank>=0 && actorRank>=officerRank)) {
      return result('Discord rank could not be restored because the application uploader does not currently have officer rank. Please review and promote in ESO.');
    }
    if(desiredRank>actorRank)return result(`Recorded rank **${safe(historical.rankName)}** is above the uploader's current guild rank. A higher-ranked officer must review the Discord restoration and ESO promotion.`);
    let member;
    const ids=[...new Set(historical.discordUserIds||[])];
    if(ids.length>1)return result('Discord rank could not be restored because more than one confirmed account link exists. Please review the links and ESO rank.');
    if(ids.length===1)member=await guild.members.fetch({user:ids[0],force:true});
    else {
      const members=await guild.members.fetch();
      const matches=[...members.values()].filter(candidate=>!candidate.user?.bot &&
        [candidate.user?.username,candidate.user?.globalName,candidate.nickname,candidate.displayName].some(name=>name && account(name)===account(payload.applicantAccount)));
      if(matches.length!==1)return result('Discord rank could not be restored because no unique matching Discord member was found. Please review the Discord link and promote in ESO.');
      member=matches[0];
    }
    if(!member || member.user?.bot)return result('Discord member could not be found. Please review the Discord link and ESO rank.');
    const current=[...member.roles.cache.values()],highest=current.reduce((best,role)=>rankOf(role)>rankOf(best)?role:best,target);
    const effective=rankOf(highest)>desiredRank?highest:target;
    if(effective.id===target.id && !member.roles.cache.has(target.id))await member.roles.add(target.id,'GuildSync returning member: latest recorded ESO promotion');
    const lower=current.filter(role=>rankOf(role)>=0 && rankOf(role)<rankOf(effective));
    let cleanup='';
    if(lower.length) {
      try{await member.roles.remove(lower.map(role=>role.id),'GuildSync returning member: remove lower guild ranks');}
      catch(error){log(`Returning member lower-rank cleanup failed for ${member.id}: ${error.message}`);cleanup=' Some lower Discord roles could not be removed; please review them.';}
    }
    const retained=effective.id!==target.id;
    log(`Returning member ${payload.applicantAccount}: Discord ${member.id}, historical ${historical.rankName}, effective ${effective.name}.`);
    return result(`${safe(payload.applicantAccount)} ${retained?'retains their higher Discord rank':'has been restored to Discord rank'} **${safe(effective.name)}**.${cleanup} **An officer must also promote them in ESO** to the appropriate rank.`);
  } catch(error) {
    log(`Returning member rank restoration failed for ${payload.applicantAccount}: ${error.message}`);
    return result(`Previous recorded rank: **${safe(historical.rankName)}**. Discord rank could not be restored automatically. Please check bot permissions/account linking and promote in ESO.`);
  }
}
