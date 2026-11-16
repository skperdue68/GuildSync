// Adapts pre-existing focused SQL doubles to additive identity lookups/locks.
// Identity behavior itself is exercised against SQL tables in eso-account-identity.test.js.
export function withIdentityTestDB(db){
 const original=db.execute.bind(db);
 db.execute=async(sql,args=[])=>{
  if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
  if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
  if(sql.includes('guildsync_eso_account_aliases') || sql.includes('guildsync_eso_account_renames'))return [[]];
  return original(sql,args);
 };
 const connect=db.getConnection?.bind(db);
 db.getConnection=async()=>{
  const c=connect?await connect():db;
  if(c===db)return db;
  return withIdentityTestDB(c);
 };
 db.release ||= ()=>{};
 return db;
}
