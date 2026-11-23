/** Offline-first Studio runner proof-of-execution. Does not perform live marketing work. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync, lstatSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNotRestricted } from './agent-run.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const STATES = new Set(['CREATED','SOURCE_LOADING','PLANNING','DRAFTING','QA_METADATA','QA_SOURCE_MATCH','PACKAGING','SIMULATION_COMPLETE','BLOCKED_INPUT','BLOCKED_PERMISSION','BLOCKED_SOURCE','BLOCKED_BUDGET','BLOCKED_QA','BLOCKED_PROVIDER',
  // E4 agent pipeline states (RUNNER-CONTRACTS-v0.1 §5)
  'BRIEF_READY','QA_FACTS','QA_CRAFT','REVISING','WAITING_FOR_OWNER','BLOCKED_EVIDENCE','FAILED_RECOVERABLE',
  // E5 owner controls
  'ASSET_APPROVED','CANCELLED']);
const VERSION = 'studio.local-run/0.1';

type SourceRef = { id: string; path: string; digest: string; text: string };
type Budget = { max_model_calls: number; max_steps: number };
export type Request = {
  schema_version: string;
  workspace_id: string;
  mode: 'one_off'|'campaign';
  goal: string;
  audience: string;
  source_paths: string[];
  provider: 'mock';
  budget: Budget;
  permissions: { actions: string[] };
  campaign?: { linear_project?: string } | null;
};
export type Run = { run_id: string; status: string; request_json: string; calls: number; steps: number; created_at: string; updated_at: string };
export type EventRow = { id: number; run_id: string; event_type: string; details_json: string };

export class RunnerFailure extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code=code; this.name = 'RunnerFailure'; } }
export const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export function now(){return new Date().toISOString()}
export function record(db: DatabaseSync, runId: string, event: string, details: unknown={}) {
  db.prepare('INSERT INTO events(run_id,event_type,details_json,at) VALUES(?,?,?,?)').run(runId,event,JSON.stringify(details),now());
}
export function setState(db:DatabaseSync, id:string, state:string, details:unknown={}){
  if(!STATES.has(state))throw new Error('Unknown state');
  db.exec('BEGIN IMMEDIATE');
  try{ db.prepare('UPDATE runs SET status=?,updated_at=? WHERE run_id=?').run(state,now(),id);record(db,id,'state', {state,...(details as object)});db.exec('COMMIT'); }
  catch(e){db.exec('ROLLBACK');throw e}
}
function incrementAndRecord(db:DatabaseSync,id:string,key:'calls'|'steps',event:string,details:unknown) {
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare(`UPDATE runs SET ${key}=${key}+1,updated_at=? WHERE run_id=?`).run(now(),id);
    record(db,id,event,details);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
}
export function get(db:DatabaseSync,id:string): Run {const r=db.prepare('SELECT * FROM runs WHERE run_id=?').get(id) as Run | undefined;if(!r)throw new RunnerFailure('NOT_FOUND','Unknown run ID');return r}
export function safeDir(p:string,create=true){
  const full=resolve(p), parsed=parse(full),parts=full.slice(parsed.root.length).split(sep).filter(Boolean);
  let cur=parsed.root;for(const part of parts){cur=join(cur,part);try{if(lstatSync(cur).isSymbolicLink())throw new RunnerFailure('PERMISSION','Runtime path contains symbolic link')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
  if(create)mkdirSync(full,{recursive:true,mode:0o700});
}
/** Local owner-maintained identity guard; future remote adapters require authenticated tenant resolution. */
export function readWorkspaceIdentity(root:string):string {
  const file=join(root,'studio-workspace.json');
  if(!existsSync(file))throw new RunnerFailure('PERMISSION','Trusted studio-workspace.json manifest missing');
  if(lstatSync(file).isSymbolicLink()||!statSync(file).isFile())throw new RunnerFailure('PERMISSION','Workspace identity must be a regular local file');
  let raw:unknown;
  try {raw=JSON.parse(readFileSync(file,'utf8'))}
  catch {throw new RunnerFailure('PERMISSION','Invalid trusted workspace identity JSON')}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RunnerFailure('PERMISSION','Invalid workspace identity object');
  const m=raw as Record<string,unknown>;
  if(m.schema_version!=='studio.workspace/0.1'||typeof m.workspace_id!=='string'||!/^[-a-zA-Z0-9_]{3,70}$/.test(m.workspace_id))
    throw new RunnerFailure('PERMISSION','Invalid workspace identity schema or identifier');
  const allowed=process.env.STUDIO_ALLOWED_WORKSPACE_ROOT;
  if(allowed){
    let pinned:string;
    try {pinned=realpathSync(resolve(allowed))}catch {throw new RunnerFailure('PERMISSION','Configured workspace root unavailable')}
    if(pinned!==root)throw new RunnerFailure('PERMISSION','Workspace root differs from trusted launch configuration');
  }
  return m.workspace_id;
}

type LockInfo={pid:number; nonce:string; started:string};
/** True when a live local process holds the workspace lock (a missing or dead holder is not 'held'). */
export function lockHeld(root:string):boolean{
  const path=join(root,'.studio','runner.lock');
  if(!existsSync(path))return false;
  try{const o=JSON.parse(readFileSync(path,'utf8')) as LockInfo;process.kill(o.pid,0);return true}
  catch(err){return (err as NodeJS.ErrnoException).code!=='ESRCH'}
}
export function withWorkspaceLock<T>(root:string,fn:()=>T):T {
  const path=join(root,'.studio','runner.lock');
  const nonce=randomUUID();
  let acquired=false;
  for(let attempt=0;attempt<4&&!acquired;attempt++){
    try{
      const fd=openSync(path,'wx',0o600);
      try {writeFileSync(fd,JSON.stringify({pid:process.pid,nonce,started:now()} satisfies LockInfo))}
      finally{closeSync(fd)}
      acquired=true;
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      if(lstatSync(path).isSymbolicLink())throw new RunnerFailure('PERMISSION','Runner lock is a symlink');
      let owner:LockInfo;
      try {owner=JSON.parse(readFileSync(path,'utf8')) as LockInfo}
      catch {throw new RunnerFailure('LOCKED','Unreadable lock file; investigate before retry')}
      if(!Number.isInteger(owner.pid)||owner.pid<1||typeof owner.nonce!=='string')throw new RunnerFailure('LOCKED','Untrusted lock content; investigate before retry');
      try{process.kill(owner.pid,0);throw new RunnerFailure('LOCKED','Workspace is already executing a run')}
      catch(err){
        if(err instanceof RunnerFailure)throw err;
        if((err as NodeJS.ErrnoException).code!=='ESRCH')throw new RunnerFailure('LOCKED','Cannot confirm previous Runner exited');
      }
      // Local single-host recovery: use a fresh exclusive create on the next attempt.
      // Compare exact bytes before unlink; on uncertain concurrent mutation stop safely.
      if(!existsSync(path)||readFileSync(path,'utf8')!==JSON.stringify(owner))
        throw new RunnerFailure('LOCKED','Lock changed during stale lock recovery');
      unlinkSync(path);
    }
  }
  if(!acquired)throw new RunnerFailure('LOCKED','Could not acquire exclusive local workspace lock');
  try {return fn()}
  finally{
    try{
      const lock=JSON.parse(readFileSync(path,'utf8')) as LockInfo;
      if(lock.nonce===nonce && lock.pid===process.pid)unlinkSync(path);
    }catch{ /* A missing/replaced lock must not be deleted by the wrong process. */ }
  }
}

export function openWorkspace(workspaceArg:string,readOnly=false): {root:string;db:DatabaseSync;workspaceId:string} {
  const root=realpathSync(resolve(workspaceArg));
  if(!statSync(root).isDirectory())throw new RunnerFailure('INPUT','Workspace is not a directory');
  const workspaceId=readWorkspaceIdentity(root);
  const hidden=join(root,'.studio');safeDir(hidden,!readOnly);
  const dbPath=join(hidden,'runs.sqlite');
  if(existsSync(dbPath)&&lstatSync(dbPath).isSymbolicLink())throw new RunnerFailure('PERMISSION','Runner database is a symlink');
  if(readOnly&&!existsSync(dbPath))throw new RunnerFailure('NOT_FOUND','Runner database does not exist');
  const db=new DatabaseSync(dbPath,{readOnly});
  if(!readOnly)db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,status TEXT NOT NULL,request_json TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,steps INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,event_type TEXT NOT NULL,details_json TEXT NOT NULL,at TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id));`);
  return{root,db,workspaceId};
}
export function validateRequest(raw:unknown): Request {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RunnerFailure('INPUT','Request must be an object');
  const r=raw as Record<string,unknown>;
  if(r.schema_version!=='studio.request/0.1')throw new RunnerFailure('INPUT','Unsupported request schema');
  if(typeof r.workspace_id!=='string'||!/^[-a-zA-Z0-9_]{3,70}$/.test(r.workspace_id))throw new RunnerFailure('INPUT','Invalid workspace_id');
  if(r.mode!=='one_off'&&r.mode!=='campaign')throw new RunnerFailure('INPUT','Invalid mode');
  if(typeof r.goal!=='string'||r.goal.trim().length<10||r.goal.length>3000)throw new RunnerFailure('INPUT','Goal length invalid');
  if(typeof r.audience!=='string'||r.audience.trim().length<3)throw new RunnerFailure('INPUT','Audience missing');
  if(!Array.isArray(r.source_paths)||r.source_paths.length<1||r.source_paths.length>12||r.source_paths.some(x=>typeof x!=='string'||!x.startsWith('sources/')||x.includes('..')||x.includes('\\')||x.includes('\0')))throw new RunnerFailure('INPUT','source_paths must be relative to sources/');
  if(r.provider!=='mock')throw new RunnerFailure('PROVIDER','Only mock provider is installed; no API keys are used');
  const b=r.budget as Record<string,unknown> | undefined;
  if(!b||!Number.isInteger(b.max_model_calls)||!Number.isInteger(b.max_steps)||Number(b.max_model_calls)<2||Number(b.max_model_calls)>10||Number(b.max_steps)<4||Number(b.max_steps)>30)throw new RunnerFailure('BUDGET','Budget must have bounded model calls [2,10] and steps [4,30]');
  const p=r.permissions as Record<string,unknown> | undefined;
  const actions=Array.isArray(p?.actions)?p.actions:[];
  if(!p||!Array.isArray(p.actions)||actions.some(x=>!['read_sources','write_private_draft','run_metadata_gate'].includes(x))||!['read_sources','write_private_draft','run_metadata_gate'].every(x=>actions.includes(x)))throw new RunnerFailure('PERMISSION','Only known draft-only actions may be granted');
  if(r.mode==='campaign'&&(!r.campaign||typeof r.campaign!=='object'||typeof (r.campaign as Record<string,unknown>).linear_project!=='string'))throw new RunnerFailure('INPUT','Campaign needs existing Linear project link; runner will not create projects');
  return r as Request;
}
export function safeSource(root:string,path:string): string {
  let base:string,p:string;
  try {base=realpathSync(join(root,'sources'));p=realpathSync(resolve(root,path))}
  catch {throw new RunnerFailure('SOURCE','Source missing or inaccessible: '+path)}
  if(!p.startsWith(base+sep)||!statSync(p).isFile())throw new RunnerFailure('PERMISSION','Source outside allowed sources directory');
  if(statSync(p).nlink>1)throw new RunnerFailure('PERMISSION','Hard-linked source files are refused');
  if(statSync(p).size>100_000)throw new RunnerFailure('INPUT','Source exceeds 100 KB offline limit');
  return p;
}
function getSources(root:string,r:Request): SourceRef[] {
  assertNotRestricted(root,r.source_paths); // the mock has no grant path; restricted sources are refused
  return r.source_paths.map((path,i)=>{
    const file=safeSource(root,path),text=readFileSync(file,'utf8');
    if(text.trim().length<25)throw new RunnerFailure('SOURCE','Source lacks enough content: '+path);
    return {id:`src_${i+1}`,path,digest:hash(text),text};
  });
}
export function atomicWrite(path:string,content:string){safeDir(dirname(path));try{if(lstatSync(path).isSymbolicLink())throw new RunnerFailure('PERMISSION','Runtime file is a symbolic link')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}const tmp=path+'.tmp-'+randomUUID();writeFileSync(tmp,content,{mode:0o600,flag:'wx'});renameSync(tmp,path)}
function verifyArtifact(path:string,wantDigest:string):boolean{
  return existsSync(path)&&!lstatSync(path).isSymbolicLink()&&hash(readFileSync(path))===wantDigest
}
function assertCompletedArtifacts(db:DatabaseSync,id:string,dir:string){
  const rows=db.prepare('SELECT details_json FROM events WHERE run_id=? AND event_type=? ORDER BY id').all(id,'step_complete') as {details_json:string}[];
  const done=new Map<string,Record<string,unknown>>(rows.map(row=>{const x=JSON.parse(row.details_json) as Record<string,unknown>;return[String(x.step),x] as [string,Record<string,unknown>]}));
  const expected:[string,string,string][]=[
    ['brief','brief.md','sha256'],
    ['draft','draft.md','sha256'],
    ['draft','claim-manifest.json','manifest_sha256'],
    ['metadata_qa','metadata-qa.json','sha256'],
    ['source_match','source-match-qa.json','sha256'],
    ['package','review-package.md','sha256']
  ];
  for(const [step,file,field] of expected){
    const digest=done.get(step)?.[field];
    if(typeof digest!=='string'||!verifyArtifact(join(dir,file),digest))
      throw new RunnerFailure('SOURCE','Persisted artifact missing or changed: '+file);
  }
}
function modelCall(db:DatabaseSync,id:string,r:Request,kind:'plan'|'draft',fn:()=>string):string{
  const run=get(db,id);
  if(run.calls>=r.budget.max_model_calls)throw new RunnerFailure('BUDGET','Mock call limit reached');
  incrementAndRecord(db,id,'calls','mock_model',{kind,provider:'mock',billable:false});
  return fn();
}
function step(db:DatabaseSync,id:string,r:Request,state:string){
  const run=get(db,id);
  if(run.steps>=r.budget.max_steps)throw new RunnerFailure('BUDGET','Step limit reached');
  if(!STATES.has(state))throw new RunnerFailure('INPUT','Unknown requested step state');
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('UPDATE runs SET steps=steps+1,status=?,updated_at=? WHERE run_id=?').run(state,now(),id);
    record(db,id,'state',{state});
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
}
function completed(db:DatabaseSync,id:string,stepId:string,info:unknown){record(db,id,'step_complete',{step:stepId,...(info as object)})}
function hasCompleted(db:DatabaseSync,id:string,stepId:string):boolean {return !!db.prepare('SELECT 1 FROM events WHERE run_id=? AND event_type=? AND json_extract(details_json,\'$.step\')=? LIMIT 1').get(id,'step_complete',stepId)}
function evidenceSentence(text:string):string {
  const first=text.split('\n').map(s=>s.replace(/^#+\s*/, '').trim()).find(s=>s.length>=25 && !s.startsWith('['));
  return (first||text.trim()).slice(0,240);
}
function runOnce(root:string,db:DatabaseSync,id:string,r:Request){
  const dir=join(root,'.studio','artifacts',id);safeDir(dir);
  const sources=getSources(root,r),inputs=sources.map(s=>({id:s.id,path:s.path,sha256:s.digest}));
  const manifestPath=join(dir,'claim-manifest.json'),draftPath=join(dir,'draft.md'),briefPath=join(dir,'brief.md');
  const srcHash=hash(JSON.stringify(inputs));
  const prev=existsSync(join(dir,'source-index.json'))?JSON.parse(readFileSync(join(dir,'source-index.json'),'utf8')):null;
  if(prev&&prev.sha256!==srcHash)throw new RunnerFailure('SOURCE','Source changed since run; requires a new run or deliberate re-research');
  if(!prev){step(db,id,r,'SOURCE_LOADING');atomicWrite(join(dir,'source-index.json'),JSON.stringify({sources:inputs,sha256:srcHash},null,2));completed(db,id,'sources',{sha256:srcHash})}

  if(!hasCompleted(db,id,'brief')){
    step(db,id,r,'PLANNING');
    const expected=`# MOCK strategic brief — NOT MODEL RESEARCH\n\nGoal: ${r.goal}\nAudience: ${r.audience}\nOriginal source IDs: ${sources.map(s=>s.id).join(', ')}\nAngle: examine the evidence presented by the source notes.\nLimit: an offline mock cannot validate readers, choose a real creative angle or access live sources.\n`;
    if(existsSync(briefPath)){
      if(readFileSync(briefPath,'utf8')!==expected)throw new RunnerFailure('SOURCE','Unrecognized existing strategic brief; refusing overwrite');
      completed(db,id,'brief',{sha256:hash(expected),reconciled:true});
    }else{
      const brief=modelCall(db,id,r,'plan',()=>expected);
      atomicWrite(briefPath,brief);
      if(process.env.STUDIO_FAULT_AFTER_BRIEF_WRITE==='1'){process.stderr.write('Injected failure after brief write\n');process.exit(74)}
      completed(db,id,'brief',{sha256:hash(brief),reconciled:false});
    }
  }
  if(!hasCompleted(db,id,'draft')){
    step(db,id,r,'DRAFTING');
    // Deterministic mock recovery only: a real provider response must use stored receipts.
    const expectedText=`# MOCK NEWSLETTER — SIMULATION ONLY\n\nThis is a deterministic test artifact, not a publishable article.\n\n${sources.map(s=>`## Source ${s.id}\n\n${evidenceSentence(s.text)}\n`).join('\n')}\nActual newsletter writing, strategy and independent editorial QA require a separately authorized live model and reviewer.\n`;
    const expectedManifest={asset_id:`mock-${id}`,status:'draft',audience:r.audience,goal:r.goal,source_refs:sources.map(s=>({id:s.id,uri:`workspace://${r.workspace_id}/${s.path}`,kind:'primary',sha256:s.digest})),claims:sources.map(s=>({text:evidenceSentence(s.text),source_ids:[s.id],review:'unreviewed'})),source_index_sha256:srcHash,owner_approved:false};
    const expectedManifestText=JSON.stringify(expectedManifest,null,2);
    if(existsSync(draftPath)||existsSync(manifestPath)){
      if(existsSync(draftPath)&&readFileSync(draftPath,'utf8')!==expectedText)
        throw new RunnerFailure('SOURCE','Unrecognized existing draft; refusing overwrite');
      if(existsSync(manifestPath)&&readFileSync(manifestPath,'utf8')!==expectedManifestText)
        throw new RunnerFailure('SOURCE','Unrecognized existing claim manifest; refusing overwrite');
      if(!existsSync(draftPath))atomicWrite(draftPath,expectedText);
      if(!existsSync(manifestPath))atomicWrite(manifestPath,expectedManifestText);
      completed(db,id,'draft',{sha256:hash(expectedText),manifest_sha256:hash(expectedManifestText),reconciled:true});
    }else{
      const text=modelCall(db,id,r,'draft',()=>expectedText);
      atomicWrite(draftPath,text);
      if(process.env.STUDIO_FAULT_AFTER_DRAFT_ONLY_WRITE==='1'){process.stderr.write('Injected failure after partial draft bundle\n');process.exit(73)}
      atomicWrite(manifestPath,expectedManifestText);
      if(process.env.STUDIO_FAULT_AFTER_DRAFT_WRITE==='1'){process.stderr.write('Injected failure after local draft write\n');process.exit(72)}
      completed(db,id,'draft',{sha256:hash(text),manifest_sha256:hash(expectedManifestText),reconciled:false});
    }
  }
  if(!hasCompleted(db,id,'metadata_qa')){
    step(db,id,r,'QA_METADATA');
    const out=spawnSync('python3',['-m','tools.newsletter_gate','--draft',draftPath,'--manifest',manifestPath],{cwd:REPO_ROOT,encoding:'utf8',timeout:10000,maxBuffer:100_000});
    if(out.error)throw new RunnerFailure('QA','Python gate unavailable: '+out.error.message);
    if(out.status!==0)throw new RunnerFailure('QA','Metadata gate failed: '+out.stdout+' '+out.stderr);
    let result:Record<string,unknown>;try{result=JSON.parse(out.stdout)}catch{throw new RunnerFailure('QA','Invalid Python gate output')}
    const report=JSON.stringify({...result,tool:'python3 -m tools.newsletter_gate',executed:true,independent_fact_check:false},null,2);
    atomicWrite(join(dir,'metadata-qa.json'),report);
    completed(db,id,'metadata_qa',{verdict:result.verdict,sha256:hash(report)});
  }
  if(!hasCompleted(db,id,'source_match')){
    step(db,id,r,'QA_SOURCE_MATCH');
    const man=JSON.parse(readFileSync(manifestPath,'utf8'));
    const claims=man.claims.map((c:{text:string;source_ids:string[]})=>{
      const found=c.source_ids.every(sid=>sources.find(s=>s.id===sid)?.text.includes(c.text));
      return {text:c.text,source_ids:c.source_ids,literal_text_present:found,semantic_fact_verified:false};
    });
    if(claims.some((c:{literal_text_present:boolean})=>!c.literal_text_present))throw new RunnerFailure('QA','Mock source claim mismatch');
    const report=JSON.stringify({method:'deterministic literal source match',claims,independent_fact_check:false,editorial_review:false},null,2);
    atomicWrite(join(dir,'source-match-qa.json'),report);
    completed(db,id,'source_match',{claims:claims.length,sha256:hash(report)});
  }
  if(!hasCompleted(db,id,'package')){
    step(db,id,r,'PACKAGING');
    const text=`# Offline Runner Simulation — ${id}\n\n**State: SIMULATION ONLY. NO EDITORIAL APPROVAL.**\n\nThis tested bounded local orchestration, sources, existing Python metadata gate, and restartable state.\n\n- Brief: brief.md\n- Draft: draft.md (mock fixture; not a real newsletter)\n- Source manifest: source-index.json\n- Claim manifest: claim-manifest.json\n- Metadata QA: metadata-qa.json\n- Literal source-match check: source-match-qa.json\n\n**Missing before a real owner review:** live Director and writer models, independent factual/editorial reviewers, actual source clearance and the owner's voice assessment.\n\nNo publish, merge, or account actions were available.\n`;
    atomicWrite(join(dir,'review-package.md'),text);completed(db,id,'package',{sha256:hash(text)});
  }
  setState(db,id,'SIMULATION_COMPLETE',{mock:true,source_index_sha256:srcHash});
  return{run_id:id,status:'SIMULATION_COMPLETE',artifact_dir:dir,model_calls:get(db,id).calls};
}
export function startRun(workspaceArg:string,requestFile:string){
  const {root,db,workspaceId}=openWorkspace(workspaceArg);
  try{return withWorkspaceLock(root,()=>{
    const source=resolve(requestFile),raw=JSON.parse(readFileSync(source,'utf8'));
    const request=validateRequest(raw);
    if(request.workspace_id!==workspaceId)throw new RunnerFailure('PERMISSION','Request workspace_id does not match trusted local workspace identity');
    const id=randomUUID(),t=now();
    db.prepare('INSERT INTO runs(run_id,status,request_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'CREATED',JSON.stringify(request),t,t);
    record(db,id,'created',{schema:VERSION,workspace_id:request.workspace_id,mode:request.mode});
    try{return runOnce(root,db,id,request)}catch(e){handleFailure(db,id,e);throw e}
  })}finally{db.close()}
}
function handleFailure(db:DatabaseSync,id:string,error:unknown){
  const x=error instanceof RunnerFailure?error:new RunnerFailure('INPUT',String(error));
  const state=({INPUT:'BLOCKED_INPUT',PERMISSION:'BLOCKED_PERMISSION',SOURCE:'BLOCKED_SOURCE',BUDGET:'BLOCKED_BUDGET',QA:'BLOCKED_QA',PROVIDER:'BLOCKED_PROVIDER'} as Record<string,string>)[x.code]||'BLOCKED_INPUT';
  setState(db,id,state,{error:x.message});
}
export function resumeRun(workspaceArg:string,id:string){
  const {root,db,workspaceId}=openWorkspace(workspaceArg);
  try{return withWorkspaceLock(root,()=>{
    const row=get(db,id),r=validateRequest(JSON.parse(row.request_json));
    if(r.workspace_id!==workspaceId)throw new RunnerFailure('PERMISSION','Stored request belongs to another workspace');
    if(row.status==='SIMULATION_COMPLETE'){
      // Source drift invalidates a completed simulation too; no silent reuse of stale evidence.
      const idxPath=join(root,'.studio','artifacts',id,'source-index.json');
      const actual=hash(JSON.stringify(getSources(root,r).map(s=>({id:s.id,path:s.path,sha256:s.digest}))));
      if(!existsSync(idxPath)||JSON.parse(readFileSync(idxPath,'utf8')).sha256!==actual){setState(db,id,'BLOCKED_SOURCE',{error:'Sources changed since simulation'});throw new RunnerFailure('SOURCE','Sources changed since simulation')}
      const artifactDir=join(root,'.studio','artifacts',id);
      try{assertCompletedArtifacts(db,id,artifactDir)}
      catch(e){setState(db,id,'BLOCKED_SOURCE',{error:e instanceof Error?e.message:String(e)});throw e}
      return{run_id:id,status:row.status,artifact_dir:artifactDir,model_calls:row.calls};
    }
    if(row.status.startsWith('BLOCKED_'))throw new RunnerFailure('INPUT',`Run blocked in ${row.status}; create a new run after resolving the issue`);
    try{return runOnce(root,db,id,r)}catch(e){handleFailure(db,id,e);throw e}
  })}finally{db.close()}
}
export function inspectRun(workspaceArg:string,id:string){const{root,db}=openWorkspace(workspaceArg,true);try{const r=get(db,id);return {...r,request:JSON.parse(r.request_json),events:db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id').all(id) as unknown as EventRow[],artifact_dir:join(root,'.studio','artifacts',id)};}finally{db.close()}}
export function listRuns(workspaceArg:string): Array<Pick<Run,'run_id'|'status'|'calls'|'steps'|'created_at'|'updated_at'>> {
  const root=realpathSync(resolve(workspaceArg));readWorkspaceIdentity(root);safeDir(join(root,'.studio'),false);
  if(!existsSync(join(root,'.studio','runs.sqlite')))return [];
  const{db}=openWorkspace(root,true);try{return db.prepare('SELECT run_id,status,calls,steps,created_at,updated_at FROM runs ORDER BY created_at DESC').all() as unknown as Array<Pick<Run,'run_id'|'status'|'calls'|'steps'|'created_at'|'updated_at'>>;}finally{db.close()}}
export function doctor(){return{version:VERSION,node:process.version,sqlite:'node:sqlite',python_gate:'python3 -m tools.newsletter_gate',providers:['mock'],live_provider_available:false,publish_available:false,notes:'node:sqlite is experimental in Node 22. CI runs Node 22.16 and Node 26.'}}
