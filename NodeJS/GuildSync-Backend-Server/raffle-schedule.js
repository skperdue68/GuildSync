// Calendar periods keep their Eastern clock time; they are not fixed-duration weeks.
const DAY_SECONDS = 86400;
const PERIOD_DAYS = 14;
const ANCHOR_DAY = Date.UTC(2026, 5, 6) / 1000;
const easternFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'
});

export function easternParts(timestamp) {
  return Object.fromEntries(easternFormatter.formatToParts(new Date(Number(timestamp)*1000))
    .filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
}

export function easternSalesCutoff({year,month,day}) {
  const target = Date.UTC(year,month-1,day,19)/1000;
  let timestamp = target;
  // Resolve the UTC offset at the boundary date, rather than borrowing today's offset.
  for(let iteration=0;iteration<3;iteration++) {
    const local=easternParts(timestamp);
    const adjustment=target-Date.UTC(local.year,local.month-1,local.day,local.hour)/1000;
    timestamp+=adjustment;
    if(!adjustment)break;
  }
  return timestamp;
}

function calendarDay(timestamp) {
  const {year,month,day}=easternParts(timestamp);
  return Date.UTC(year,month-1,day)/1000;
}

function cutoffForDay(dayTimestamp) {
  const date=new Date(dayTimestamp*1000);
  return easternSalesCutoff({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,day:date.getUTCDate()});
}

export function shiftRaffleSalesEnd(salesEnd,periods=1) {
  if(!Number.isSafeInteger(periods))throw Error('Raffle period offset must be an integer.');
  return cutoffForDay(calendarDay(salesEnd)+periods*PERIOD_DAYS*DAY_SECONDS);
}

export function biweeklySalesEndAtOrAfter(referenceTime) {
  referenceTime=Number(referenceTime);
  if(!Number.isFinite(referenceTime))throw Error('Invalid raffle reference time.');
  const period=Math.floor((calendarDay(referenceTime)-ANCHOR_DAY)/(PERIOD_DAYS*DAY_SECONDS));
  let cutoff=cutoffForDay(ANCHOR_DAY+period*PERIOD_DAYS*DAY_SECONDS);
  if(cutoff<referenceTime)cutoff=shiftRaffleSalesEnd(cutoff,1);
  return cutoff;
}

export function isLastRaffleInEasternMonth(salesEnd) {
  const current=easternParts(salesEnd),next=easternParts(shiftRaffleSalesEnd(salesEnd,1));
  return current.year!==next.year||current.month!==next.month;
}

export function monthlySalesEndAtOrAfter(referenceTime) {
  let cutoff=biweeklySalesEndAtOrAfter(referenceTime);
  while(!isLastRaffleInEasternMonth(cutoff))cutoff=shiftRaffleSalesEnd(cutoff,1);
  return cutoff;
}

export function previousMonthlySalesEnd(salesEnd) {
  let cutoff=shiftRaffleSalesEnd(salesEnd,-1);
  while(!isLastRaffleInEasternMonth(cutoff))cutoff=shiftRaffleSalesEnd(cutoff,-1);
  return cutoff;
}

export function nextMonthlySalesEnd(salesEnd) {
  let cutoff=shiftRaffleSalesEnd(salesEnd,1);
  while(!isLastRaffleInEasternMonth(cutoff))cutoff=shiftRaffleSalesEnd(cutoff,1);
  return cutoff;
}

// Correct only genuine cadence boundaries at the legacy or intended cutoff time.
// Arbitrary historic timestamps and fixture/custom windows remain untouched.
export function normalizeScheduledSalesEnd(timestamp) {
  const value=Number(timestamp);
  if(!Number.isSafeInteger(value)||value<=0)return timestamp;
  const {year,month,day}=easternParts(value);
  const dayTimestamp=Date.UTC(year,month-1,day)/1000;
  if((dayTimestamp-ANCHOR_DAY)%(PERIOD_DAYS*DAY_SECONDS)!==0)return timestamp;
  const corrected=easternSalesCutoff({year,month,day});
  const legacy=Date.UTC(year,month-1,day,23)/1000;
  return value===legacy||value===corrected?corrected:timestamp;
}
