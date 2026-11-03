import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hasRaffleAdminRole} from './raffle-permissions.js';

test('unset configuration retains Consigliere; unknown, same-looking and higher roles do not grant access',()=>{
 assert.equal(hasRaffleAdminRole([{name:'Consigliere'}],{}),true);
 for(const name of ['Kingpin','Member','Consigliere Assistant'])assert.equal(hasRaffleAdminRole([{name}],{}),false);
});
test('custom role names and IDs work in bot and database shapes, replacing defaults',()=>{
 const env={GUILDSYNC_RAFFLE_ADMIN_ROLES:' Officers, 123456 '};
 assert.equal(hasRaffleAdminRole([{name:'officers'}],env),true);
 assert.equal(hasRaffleAdminRole([{role_name:'Officers'}],env),true);
 assert.equal(hasRaffleAdminRole([{id:'123456',name:'Renamed'}],env),true);
 assert.equal(hasRaffleAdminRole([{role_id:'123456'}],env),true);
 assert.equal(hasRaffleAdminRole([{name:'Consigliere'}],env),false);
 assert.equal(hasRaffleAdminRole([{name:'123456',id:'999'}],env),false);
});
test('explicit blank, missing roles and mentions grant nobody',()=>{
 for(const value of ['', ' , ', '<@&123456>'])assert.equal(hasRaffleAdminRole([{name:'Consigliere',id:'123456'}],{GUILDSYNC_RAFFLE_ADMIN_ROLES:value}),false);
 assert.equal(hasRaffleAdminRole(null,{}),false);
});
test('backend and bot use identical role policy',()=>{
 assert.equal(readFileSync(new URL('./raffle-permissions.js',import.meta.url),'utf8'),readFileSync(new URL('../GuildSync-Discord-Bot/src/raffle-permissions.js',import.meta.url),'utf8'));
});
