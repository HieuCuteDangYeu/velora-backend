'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateManifest, boundedDatabaseUrl, provisionUsers, provisionRoles } = require('./seed-chat-stress-users.cjs');
function fixture() {
  const fixtureNamespace = 'mu-012345abcdef';
  return { fixtureNamespace, accounts: [1,2].map(i => {
    const suffix=String(i).padStart(3,'0');
    return { id: randomUUID(), email:`${fixtureNamespace}.${suffix}@velora-stress.invalid`,
      username:`vstress_012345abcdef_${suffix}`,fullName:`Velora load ${fixtureNamespace} ${suffix}`,password:'x'.repeat(32) };
  }) };
}
const bcrypt = { hash: async password => 'hashed:'+password, compare: async (password, hash) => hash==='hashed:'+password };
test('rejects existing real accounts, duplicate IDs and malformed fixture identities', () => {
  for (const mutate of [f=>f.accounts[0].email='real@example.com', f=>f.accounts[1].id=f.accounts[0].id,
    f=>f.accounts[0].username='admin',f=>f.accounts[0].password='short']) {
    const f=fixture();mutate(f);assert.throws(()=>validateManifest(f));
  }
});
test('caps temporary PostgreSQL pool at one and preserves schema/TLS parameters', () => {
  const u=new URL(boundedDatabaseUrl('postgresql://u:p@host/db?schema=user&sslmode=require&connection_limit=30'));
  assert.equal(u.searchParams.get('connection_limit'),'1');assert.equal(u.searchParams.get('schema'),'user');
  assert.equal(u.searchParams.get('sslmode'),'require');assert.equal(u.searchParams.get('pool_timeout'),'10');
});
test('dry run writes nothing and cannot authorize role provisioning', async () => {
  const f=fixture();const r=await provisionUsers({user:{findMany:async()=>[],createMany:()=>assert.fail('write')}},f,bcrypt,false);
  assert.equal(r.wouldCreate,2);assert.deepEqual(r.verifiedUserIds,[]);
  await assert.rejects(provisionRoles({}, {...f,provisioning:r},true),/receipt/);
});
test('creates only missing owned users, hashes passwords and reuses matching fixtures', async () => {
  const f=fixture(), first={...f.accounts[0],password:'hashed:'+f.accounts[0].password,isVerified:true};let data;
  const r=await provisionUsers({user:{findMany:async()=>[first],createMany:async arg=>{data=arg.data;return {count:data.length};}}},f,bcrypt,true);
  assert.equal(r.created,1);assert.equal(r.existing,1);assert.equal(data[0].id,f.accounts[1].id);
  assert.equal(data[0].password,'hashed:'+f.accounts[1].password);assert.equal(data[0].isVerified,true);
  assert.deepEqual(r.verifiedUserIds,f.accounts.map(a=>a.id));
});
test('any UUID/name/password ownership mismatch blocks all writes', async () => {
  for (const change of [{id:randomUUID()},{fullName:'someone else'},{password:'other hash'},{isVerified:false}]) {
    const f=fixture(), row={...f.accounts[0],password:'hashed:'+f.accounts[0].password,isVerified:true,...change};
    await assert.rejects(provisionUsers({user:{findMany:async()=>[row],createMany:()=>assert.fail('write')}},f,bcrypt,true),/conflicts/);
  }
});
test('only USER roles are inserted; no elevated roles are accepted or altered', async () => {
  const f=fixture();f.provisioning={verifiedUserIds:f.accounts.map(a=>a.id)};let data;
  const db={role:{findUnique:async()=>({id:3,name:'USER'})},userRole:{findMany:async()=>[],createMany:async arg=>{data=arg.data;return {count:data.length};}}};
  const r=await provisionRoles(db,f,true);assert.equal(r.created,2);assert.ok(data.every(a=>a.roleId===3));
  db.userRole.findMany=async()=>[{userId:f.accounts[0].id,role:{name:'ADMIN'}}];
  await assert.rejects(provisionRoles(db,f,true),/unexpected roles/);
});
test('wrong User Service receipt and missing USER policy fail closed', async () => {
  const f=fixture();f.provisioning={verifiedUserIds:[randomUUID(),randomUUID()]};
  await assert.rejects(provisionRoles({},f,true),/receipt/);
  f.provisioning.verifiedUserIds=f.accounts.map(a=>a.id);
  await assert.rejects(provisionRoles({role:{findUnique:async()=>null}},f,true),/USER role required/);
});
