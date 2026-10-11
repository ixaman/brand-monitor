'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { dhakaTime, highlightParts, inTab, tabCounts, visibleMentions, type Mention, type Tab } from '../../lib/mention-view';
import type { Filters } from '../../lib/mentions';
import { review } from './actions';
export function Feed({rows,serverTime,clientId,filters,manage,links}:{rows:Mention[];serverTime:number;clientId:string;filters:Filters;manage:boolean;links:Record<Tab,string>}) {
 const router=useRouter(),[now,setNow]=useState(serverTime),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState(''),[pending,startTransition]=useTransition();
 useEffect(() => {
  const started=Date.now(),monotonicStarted=performance.now();
  const tick=()=>setNow(serverTime+Math.max(0,Date.now()-started,performance.now()-monotonicStarted));
  const refresh=()=>{tick();router.refresh();};
  const visibility=()=>{if(document.visibilityState==='visible') refresh();};
  tick();setSelected([]);
  const timer=setInterval(tick,1000),poll=setInterval(()=>router.refresh(),60000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visibility);
  return ()=>{clearInterval(timer);clearInterval(poll);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visibility);};
 },[serverTime,router]);
 useEffect(()=>{
  const next=rows.reduce((expiry,row)=>row.expires_at!==null && row.expires_at>=now?Math.min(expiry,row.expires_at):expiry,Infinity);
  if (!Number.isFinite(next)) return;
  const timer=setTimeout(()=>setNow(current=>Math.max(current,next+1)),Math.min(2147483647,Math.max(1,next-now+1)));
  return ()=>clearTimeout(timer);
 },[rows,now]);
 const live=visibleMentions(rows,now),counts=tabCounts(live,now),items=live.filter(row=>inTab(row,filters.tab,now));
 const activeSelected=selected.filter(id=>items.some(row=>row.id===id));
 const act=(ids:string[],status:string)=>startTransition(async()=>{
  const form=new FormData();form.set('client',clientId);form.set('status',status);ids.forEach(id=>form.append('ids',id));
  const result=await review(form);setError(result.error ?? '');if(!result.error){setSelected([]);router.refresh();}
 });
 const labels:Record<Tab,string>={new:'New',all:filters.older?'All (history)':`All (${filters.hours}h)`,flagged:'Flagged',unverified:'Date unverified'};
 return <><nav aria-label="Mention tabs">{(['new','all','flagged','unverified'] as const).map(tab=><a href={links[tab]} key={tab} aria-current={filters.tab===tab?'page':undefined}>{labels[tab]} ({counts[tab]})</a>)}</nav>
 {error && <p role="alert">{error}</p>}
 {manage && items.length>0 && <div className="bulk-actions"><label><input type="checkbox" checked={activeSelected.length===items.length} onChange={e=>setSelected(e.target.checked?items.map(row=>row.id):[])}/> Select all in this tab</label><span>{activeSelected.length} selected</span>{(['reviewed','flagged','ignored'] as const).map(status=><button key={status} disabled={pending || !activeSelected.length} onClick={()=>act(activeSelected,status)}>{status==='reviewed'?'Mark reviewed':status==='flagged'?'Flag':'Ignore'} selected</button>)}</div>}
 {!items.length && <p role="status">{filters.tab==='unverified'?'No matching mentions with unresolved publication dates. Recently discovered items also appear in the main feed.':`No ${filters.tab==='all'?'':filters.tab+' '}mentions match this client and these filters. ${filters.older?'History is enabled, including items labelled Date not verified.':`This feed includes verified publication dates and unverified items first discovered in the last ${filters.hours} hours.`} Ignored items require the Ignored status filter. Try All or clear filters.`}</p>}
 {items.map(row=><article className="mention-card" key={row.id}>
 {manage && <label><input type="checkbox" checked={activeSelected.includes(row.id)} onChange={e=>setSelected(e.target.checked?[...selected,row.id]:selected.filter(id=>id!==row.id))}/> Select mention: {row.title}</label>}
 <h2><a href={row.url} target="_blank" rel="noopener noreferrer">{row.title}</a></h2>
 <p>{row.site} · {row.unverified?<strong className="date-unverified">Date not verified</strong>:<time dateTime={row.published_at!}>{dhakaTime(row.published_at!)} (Asia/Dhaka)</time>} · {row.status} · {row.sources.join(', ') || 'Stored article'}</p>
 {row.unverified && <p>First discovered: <time dateTime={row.discovered_at}>{dhakaTime(row.discovered_at)} (Asia/Dhaka)</time>. {row.date_reason || 'Publication evidence needs verification.'}{row.published_at && ` Candidate publish time: ${dhakaTime(row.published_at)} (Asia/Dhaka)`}</p>}
 {row.matches.map(match=>{const parts=highlightParts(match);return <div key={`${match.keyword_id}-${match.matched_in}`}><p>Keyword: {match.keyword} · Matched: {match.matched_term} · In {match.matched_in}</p><blockquote>{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</blockquote></div>;})}
 {manage && <div className="review-actions">{(['reviewed','flagged','ignored'] as const).map(status=><button key={status} disabled={pending} onClick={()=>act([row.id],status)}>{status==='reviewed'?'Mark reviewed':status==='flagged'?'Flag':'Ignore'}</button>)}</div>}
 </article>)}</>;
}
