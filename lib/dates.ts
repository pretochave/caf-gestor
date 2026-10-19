export function storedDate(value:string):Date{
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)?value.replace(' ','T')+'Z':value);
}
export function brazilToday():string{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type)?.value).join('-');
}
