import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSiteScans, type CandidateTotal, type ScanSite, type SiteScanDependencies } from '../scripts/scan';
import type { ArticleDiscovery } from '../packages/domain/src/article-collection';

const sites:ScanSite[]=[
 {id:'first',url:'https://first.example.com',method:'rss',source_timezone:'Asia/Dhaka'},
 {id:'second',url:'https://second.example.com',method:'sitemap',source_timezone:'Asia/Dhaka'},
];
function discoveries(site:ScanSite,count=1):ArticleDiscovery[] {
 return Array.from({length:count},(_,index)=>({url:`${site.url}/article-${index}`,source:site.method as ArticleDiscovery['source'],discoveredAt:new Date('2026-10-12T06:00:00Z'),dateEvidence:[]}));
}
function dependencies(options:{
 endpointErrors?:Set<string>;
 collectErrors?:Set<string>;
 totals?:CandidateTotal[];
 notes?:Record<string,string[]>;
 counts?:Record<string,number>;
}={}) {
 const events:string[]=[],enqueued:Array<{id:string;links:ArticleDiscovery[]}>=[],persisted:Array<{id:string;diagnostics:string[]}>=[];
 const dependencies:SiteScanDependencies={
  loadEndpoints:async site=>{
   events.push(`endpoints:${site.id}`);
   if(options.endpointErrors?.has(site.id))throw new Error(`Endpoint query failed for ${site.id}`);
   return [{kind:site.method as 'rss'|'sitemap',url:`${site.url}/feed`}];
  },
  collectLinks:async(site,diagnostics)=>{
   events.push(`collect:${site.id}`);
   assert.equal(site.endpoints[0].url,`${site.url}/feed`);
   assert.equal(site.source_timezone,'Asia/Dhaka');
   diagnostics.push(...options.notes?.[site.id]??[]);
   if(options.collectErrors?.has(site.id))throw new Error(`HTTP 503 for ${site.id}`);
   return discoveries(site,options.counts?.[site.id]??1);
  },
  enqueueLinks:async(id,links)=>{events.push(`enqueue:${id}`);enqueued.push({id,links});},
  persistDiagnostics:async(id,diagnostics)=>{events.push(`diagnostics:${id}`);persisted.push({id,diagnostics:[...diagnostics]});},
  candidateTotals:async()=>{events.push('totals');return options.totals??[{status:'done',count:2}];},
 };
 return {dependencies,events,enqueued,persisted};
}

test('mixed current site outcomes succeed and retain historical errors in the summary',async()=>{
 const totals=[{status:'done',count:7},{status:'error',count:20}];
 const setup=dependencies({collectErrors:new Set(['first']),totals,counts:{second:2}});
 const summary=await runSiteScans(sites,setup.dependencies);
 assert.equal(summary.exitCode,0);
 assert.deepEqual(summary.candidates,totals);
 assert.deepEqual(summary.sites,[
  {site_id:'first',url:sites[0].url,status:'error',discovered:0,error:'HTTP 503 for first',diagnostics:[]},
  {site_id:'second',url:sites[1].url,status:'ok',discovered:2,error:null,diagnostics:[]},
 ]);
 assert.deepEqual(setup.enqueued.map(item=>item.id),['second']);
 assert.deepEqual(setup.events,['endpoints:first','collect:first','endpoints:second','collect:second','enqueue:second','diagnostics:second','totals']);
});

test('every currently attempted site failing gives nonzero even when historical candidates succeeded',async()=>{
 const setup=dependencies({collectErrors:new Set(['first','second']),totals:[{status:'done',count:100}]});
 const summary=await runSiteScans(sites,setup.dependencies);
 assert.equal(summary.exitCode,1);
 assert.ok(summary.sites.every(site=>site.status==='error' && site.error?.startsWith('HTTP 503')));
 assert.equal(summary.sites.length,2);
 assert.equal(setup.enqueued.length,0);
 assert.deepEqual(summary.candidates,[{status:'done',count:100}]);
});

test('all current sites succeeding gives zero, including genuinely empty discovery',async()=>{
 const setup=dependencies({counts:{first:0,second:3},totals:[{status:'error',count:4},{status:'done',count:3}]});
 const summary=await runSiteScans(sites,setup.dependencies);
 assert.equal(summary.exitCode,0);
 assert.deepEqual(summary.sites.map(site=>[site.status,site.discovered,site.error]),[['ok',0,null],['ok',3,null]]);
 assert.deepEqual(setup.enqueued.map(item=>item.links.length),[0,3]);
 assert.equal(summary.candidates.find(total=>total.status==='error')?.count,4);
});

test('no eligible sites is successful while candidate totals remain visible',async()=>{
 const setup=dependencies({totals:[{status:'error',count:8}]});
 const summary=await runSiteScans([],setup.dependencies);
 assert.deepEqual(summary,{sites:[],candidates:[{status:'error',count:8}],exitCode:0});
 assert.deepEqual(setup.events,['totals']);
 assert.equal(setup.enqueued.length,0);
});

test('failure to retrieve one site endpoints is isolated and later sites still run',async()=>{
 const setup=dependencies({endpointErrors:new Set(['first'])});
 const summary=await runSiteScans(sites,setup.dependencies);
 assert.equal(summary.exitCode,0);
 assert.equal(summary.sites[0].error,'Endpoint query failed for first');
 assert.equal(summary.sites[1].status,'ok');
 assert.deepEqual(setup.events,['endpoints:first','endpoints:second','collect:second','enqueue:second','diagnostics:second','totals']);
});

test('coverage notes accompany a successful site and are passed to diagnostic persistence',async()=>{
 const message='Collection capped at 1000 recent/unknown articles; coverage is incomplete.';
 const setup=dependencies({notes:{first:[message]}});
 const summary=await runSiteScans(sites,setup.dependencies);
 assert.equal(summary.exitCode,0);
 assert.equal(summary.sites[0].status,'ok');
 assert.deepEqual(summary.sites[0].diagnostics,[message]);
 assert.deepEqual(summary.sites[1].diagnostics,[]);
 assert.deepEqual(setup.persisted,[{id:'first',diagnostics:[message]},{id:'second',diagnostics:[]}]);
});

test('candidate summary setup failure remains an error even with no eligible sites',async()=>{
 const setup=dependencies();
 setup.dependencies.candidateTotals=async()=>{throw new Error('Database unavailable');};
 await assert.rejects(runSiteScans([],setup.dependencies),/Database unavailable/);
});

test('candidate summary failure cannot override a successful current site and preserves its outcome',async()=>{
 const setup=dependencies({counts:{first:2}});
 setup.dependencies.candidateTotals=async()=>{throw new Error('Candidate totals unavailable');};
 const summary=await runSiteScans([sites[0]],setup.dependencies);
 assert.equal(summary.exitCode,0);
 assert.deepEqual(summary.sites,[{site_id:'first',url:sites[0].url,status:'ok',discovered:2,error:null,diagnostics:[]}]);
 assert.deepEqual(summary.candidates,[]);
 assert.equal(summary.candidate_error,'Candidate totals unavailable');
 assert.deepEqual(setup.enqueued.map(item=>item.id),['first']);
});

test('scan script imports without registering executable signal handlers or setting exit status',async()=>{
 const interruptListeners=process.listenerCount('SIGINT'),terminationListeners=process.listenerCount('SIGTERM'),exitCode=process.exitCode;
 const script=new URL('../scripts/scan.ts',import.meta.url);
 script.searchParams.set('import-check',String(Date.now()));
 const module=await import(script.href);
 assert.equal(typeof module.runSiteScans,'function');
 assert.equal(process.listenerCount('SIGINT'),interruptListeners);
 assert.equal(process.listenerCount('SIGTERM'),terminationListeners);
 assert.equal(process.exitCode,exitCode);
});
