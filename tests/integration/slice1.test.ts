import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { migrate } from '../../scripts/migrate';
import { clientWorkspace, mutateClient, mutateKeyword, AccessError, NotFoundError, ValidationError } from '../../apps/web/lib/clients';
test('slice 1 CRUD, client scoping, revisions, invalid rules and live role/approval checks', async () => {
 const admin = new Pool({ connectionString:process.env.MIGRATION_DATABASE_URL });
 const runtime = new Pool({ connectionString:process.env.DATABASE_URL });
 const users: string[] = [];
 const clients: string[] = [];
 const keywordInput = {term:' ব্র্যা\u200Bন্ড ',aliases:['Brand',' Brand '],exclusions:['চাকরি'],match_type:'exact',boolean_ast:null,active:true};
 const clientInput = {name:'Slice 1 client',notes:'test',active:true};
 try {
  await migrate(admin);
  await migrate(admin);
  for (const role of ['admin','analyst','viewer']) {
   const row = (await admin.query("INSERT INTO monitor.app_users(email,role,state,approved_at) VALUES($1,$2,'active',now()) RETURNING id",[`slice1-${role}-${crypto.randomUUID()}@example.com`,role])).rows[0];
   users.push(row.id);
  }
  const [owner, analyst, viewer] = users;
  const first = await mutateClient(runtime,analyst,'create','',clientInput); clients.push(first);
  const second = await mutateClient(runtime,owner,'create','',{...clientInput,name:'Second client'}); clients.push(second);
  assert.equal((await clientWorkspace(runtime,viewer,first)).client.id,first);
  await mutateClient(runtime,analyst,'update',first,{...clientInput,name:'Updated',active:false});
  assert.equal((await clientWorkspace(runtime,viewer,first)).client.active,false);
  await mutateKeyword(runtime,analyst,first,'create','',keywordInput);
  const keyword = (await clientWorkspace(runtime,viewer,first)).keywords[0];
  assert.equal(keyword.term,'ব্র্যান্ড');
  assert.deepEqual(keyword.aliases,['Brand']);
  assert.deepEqual(keyword.exclusions,['চাকরি']);
  assert.equal(keyword.revision,1);
  assert.equal(keyword.boolean_ast,null);
  assert.equal((await clientWorkspace(runtime,viewer,second)).keywords.length,0);
  await assert.rejects(mutateKeyword(runtime,analyst,second,'update',keyword.id,keywordInput),NotFoundError);
  await assert.rejects(mutateKeyword(runtime,analyst,second,'delete',keyword.id),NotFoundError);
  const boolean_ast = {op:'and',args:[{op:'literal',value:'Brand'},{op:'not',arg:{op:'literal',value:'jobs'}}]};
  await mutateKeyword(runtime,owner,first,'update',keyword.id,{...keywordInput,match_type:'boolean',boolean_ast,active:false});
  let updated = (await clientWorkspace(runtime,viewer,first)).keywords[0];
  assert.equal(updated.revision,2);
  assert.equal(updated.active,false);
  assert.deepEqual(updated.boolean_ast,boolean_ast);
  await Promise.all([mutateKeyword(runtime,analyst,first,'update',keyword.id,keywordInput),mutateKeyword(runtime,analyst,first,'update',keyword.id,keywordInput)]);
  updated = (await clientWorkspace(runtime,viewer,first)).keywords[0];
  assert.equal(updated.revision,4);
  assert.equal(updated.boolean_ast,null);
  await assert.rejects(mutateKeyword(runtime,analyst,first,'update',keyword.id,{...keywordInput,match_type:'boolean',boolean_ast:{op:'code'}}),ValidationError);
  assert.equal((await clientWorkspace(runtime,viewer,first)).keywords[0].revision,4);
  await assert.rejects(mutateClient(runtime,analyst,'create','',{...clientInput,name:''}),ValidationError);
  for (const action of ['create','update','delete'] as const) {
   await assert.rejects(mutateClient(runtime,viewer,action,first,clientInput),AccessError);
   await assert.rejects(mutateKeyword(runtime,viewer,first,action,keyword.id,keywordInput),AccessError);
  }
  await admin.query("UPDATE monitor.app_users SET role='viewer' WHERE id=$1",[analyst]);
  await assert.rejects(mutateClient(runtime,analyst,'update',first,clientInput),AccessError);
  await admin.query("UPDATE monitor.app_users SET state='disabled' WHERE id=$1",[analyst]);
  await assert.rejects(clientWorkspace(runtime,analyst,first),AccessError);
  await assert.rejects(mutateKeyword(runtime,analyst,first,'create','',keywordInput),AccessError);
  await assert.rejects(clientWorkspace(runtime,viewer,crypto.randomUUID()),NotFoundError);
  await assert.rejects(clientWorkspace(runtime,viewer,'invalid'),ValidationError);
  await assert.rejects(runtime.query('INSERT INTO monitor.keywords(client_id,term,created_by) VALUES($1,$2,$3)',[crypto.randomUUID(),'orphan',owner]),{code:'23503'});
  await assert.rejects(runtime.query("UPDATE monitor.keywords SET match_type='boolean',boolean_ast=NULL WHERE id=$1",[keyword.id]),{code:'23514'});
  await mutateKeyword(runtime,owner,first,'delete',keyword.id);
  assert.equal((await clientWorkspace(runtime,viewer,first)).keywords.length,0);
  await mutateKeyword(runtime,owner,first,'create','',keywordInput);
  await mutateClient(runtime,owner,'delete',first);
  assert.equal((await runtime.query('SELECT id FROM monitor.keywords WHERE client_id=$1',[first])).rowCount,0);
  await assert.rejects(mutateKeyword(runtime,owner,first,'create','',keywordInput),NotFoundError);
  await assert.rejects(mutateClient(runtime,owner,'update',first,clientInput),NotFoundError);
 } finally {
  for (const id of clients) await admin.query('DELETE FROM monitor.clients WHERE id=$1',[id]);
  for (const id of users) await admin.query('DELETE FROM monitor.app_users WHERE id=$1',[id]);
  await runtime.end(); await admin.end();
 }
});
