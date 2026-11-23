import { startRun,resumeRun,listRuns,inspectRun,doctor } from './runner.ts';
import { inspectSource,startAgentRun,resumeAgentRun,reviseAgentRun,approveAgentRun,cancelAgentRun,isAgentRequest } from './agent-run.ts';
import { handoffCheck, handoffScoreFile, handoffPromptFor } from './handoff.ts';
import { readFileSync } from 'node:fs';
import { improvementPropose, improvementHandoff, improvementRecord, improvementDecide, improvementClose, improvementList } from './improvement.ts';
import { captureImport, captureAnnotate, captureList, captureShow } from './conversation-capture.ts';
import { captureDisclosureGrant, captureDisclosureRead, captureDisclosureRevoke } from './capture-disclosure.ts';
import { sourceDisclosureGrant, sourceDisclosureList, sourceDisclosureRevoke } from './source-disclosure.ts';
import { contextSync, contextSearch, sessionStart, evidenceAddCatalog, evidenceAddHost, evidenceRemove, sessionNote, directionApprove, sessionRun, sessionRerun, sessionStatus } from './director-session.ts';
import { envOverride } from './env-override.ts';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runEval } from './eval.ts';
import { codexApiKeyEnv } from './model-port.ts';
import { onboardWorkspace } from './onboarding.ts';
function opt(name:string):string|undefined{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const hasFlag=(name:string)=>{/* exact flag token, never a value: skip the token after any --option that takes a value */for(let i=3;i<process.argv.length;i++){const a=process.argv[i];if(a===name)return true;if(a.startsWith('--')&&a!==name&&!BOOL.has(a))i++}return false};
const BOOL=new Set(['--allow-dirty-pins','--live','--force']);
function flag(name:string):string{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error('Missing '+name);return process.argv[i+1]}
function agentDoctor(){
  const check=(bin:string,args:string[])=>spawnSync(bin,args,{encoding:'utf8',timeout:15_000,maxBuffer:20_000});
  const claudeBin=envOverride('STUDIO_CLAUDE_BIN')||'claude',codexBin=envOverride('STUDIO_CODEX_BIN')||'codex';
  const claude=check(claudeBin,['--version']),codex=check(codexBin,['--version']),claudeKey=!!process.env.ANTHROPIC_API_KEY,codexKey=codexApiKeyEnv();
  const claudeAuth=claude.status===0&&!claudeKey?check(claudeBin,['auth','status','--json']):null;
  let claudeLoggedIn=false; try{const a=JSON.parse(claudeAuth?.stdout||'');claudeLoggedIn=a.loggedIn===true&&a.authMethod==='claude.ai'&&a.apiProvider==='firstParty'}catch{}
  const codexAuth=codex.status===0&&!codexKey?check(codexBin,['login','status']):null;
  const codexLoggedIn=codexAuth?.status===0&&/logged in using chatgpt/i.test(codexAuth.stdout+codexAuth.stderr);
  const providers=[
    {provider:'fixture',usable:true,detail:'tests only'},
    {provider:'claude-code-cli',cli_present:claude.status===0,logged_in:claudeLoggedIn,api_key_set:claudeKey,usable:claude.status===0&&claudeLoggedIn&&!claudeKey},
    {provider:'codex-cli',cli_present:codex.status===0,logged_in:codexLoggedIn,api_key_set:codexKey??false,usable:codex.status===0&&codexLoggedIn&&!codexKey,status:'subscription provider, pending one owner live acceptance run'},
  ];
  return {live_provider_available:providers.some((p)=>p.provider!=='fixture'&&p.usable),agent_pipeline:'studio.request/0.2',providers,claude_cli:claude.status===0?claude.stdout.trim():'not found',codex_cli:codex.status===0?codex.stdout.trim():'not found',anthropic_api_key_set:claudeKey,codex_api_key_set:codexKey??false,
    note:'Live providers use their logged-in subscriptions and refuse API-key environments; the Service selects one from its tenant record.'};
}
const cmd=process.argv[2];
try{
 let result:unknown;
 let pending:Promise<unknown>|null=null;
 switch(cmd){
  case 'doctor': result={...doctor(),...agentDoctor()};break;
  case 'onboard': pending=onboardWorkspace(resolve(flag('--workspace')),opt('--answers')?resolve(flag('--answers')):undefined,hasFlag('--force'));break;
  case 'eval':{const pack=process.argv[3];if(!pack||pack.startsWith('--'))throw new Error('Usage: studio eval <pack> [--baseline <git-ref-or-results-file>] [--live] [--provider <name>] [--results-dir <dir>]');const report=runEval(pack,{baseline:opt('--baseline'),live:hasFlag('--live'),provider:opt('--provider'),resultsDir:opt('--results-dir')});result=report;if(!report.pass)process.exitCode=1;break;}
  case 'run':{const req=resolve(flag('--request'));result=isAgentRequest(JSON.parse(readFileSync(req,'utf8')))?startAgentRun(resolve(flag('--workspace')),req,{allowDirtyPins:hasFlag('--allow-dirty-pins')}):startRun(resolve(flag('--workspace')),req);break;}
  case 'resume':{const ws=resolve(flag('--workspace')),id=flag('--run-id');result=isAgentRequest(inspectRun(ws,id).request)?resumeAgentRun(ws,id):resumeRun(ws,id);break;}
  case 'revise':result=reviseAgentRun(resolve(flag('--workspace')),flag('--run-id'),resolve(flag('--feedback')));break;
  case 'approve':result=approveAgentRun(resolve(flag('--workspace')),flag('--run-id'),flag('--digest'),opt('--decisions')?resolve(opt('--decisions')!):undefined);break;
  case 'cancel':result=cancelAgentRun(resolve(flag('--workspace')),flag('--run-id'),flag('--reason'));break;
  case 'handoff-check':result=handoffCheck(resolve(flag('--workspace')),flag('--run-id'),opt('--model')||'haiku');break;
  case 'handoff-prompt':{const h=handoffPromptFor(resolve(flag('--workspace')),flag('--run-id'));process.stdout.write(`SYSTEM:\n${h.system}\n\nUSER:\n${h.user}\n`);process.exit(0);}
  case 'handoff-score':result=handoffScoreFile(resolve(flag('--workspace')),flag('--run-id'),resolve(flag('--answer')));break;
  case 'context-sync':result=contextSync(flag('--workspace'));break;
  case 'context-search':result=contextSearch(flag('--workspace'),flag('--query'),Number(opt('--limit')??8));break;
  case 'session-start':result=sessionStart(flag('--workspace'),flag('--idea'),opt('--slug'));break;
  case 'evidence-add':result=opt('--catalog')?evidenceAddCatalog(flag('--workspace'),flag('--session'),flag('--catalog'),opt('--section')):evidenceAddHost(flag('--workspace'),flag('--session'),{kind:flag('--kind'),uri:flag('--uri'),file:flag('--file'),retrieved_by:flag('--retrieved-by'),revision:opt('--revision'),title:opt('--title'),visibility:opt('--visibility'),owner_quote:opt('--owner-quote'),retrieved_at:opt('--retrieved-at')});break;
  case 'evidence-remove':result=evidenceRemove(flag('--workspace'),flag('--session'),flag('--path'));break;
  case 'session-note':result=sessionNote(flag('--workspace'),flag('--session'),flag('--kind'),flag('--file'));break;
  case 'direction-approve':result=directionApprove(flag('--workspace'),flag('--session'),flag('--direction'));break;
  case 'session-run':result=sessionRun(flag('--workspace'),flag('--session'),{host:opt('--host'),allowDirtyPins:hasFlag('--allow-dirty-pins')});break;
  case 'session-status':result=sessionStatus(flag('--workspace'),opt('--session'));break;
  case 'capture-import':result=captureImport(flag('--workspace'),{file:flag('--file'),host:flag('--host'),format:flag('--format'),authorization:flag('--authorization'),title:flag('--title'),visibility:opt('--visibility'),conversation_id:opt('--conversation-id'),from:opt('--from')?Number(opt('--from')):undefined,to:opt('--to')?Number(opt('--to')):undefined});break;
  case 'capture-annotate':result=captureAnnotate(flag('--workspace'),flag('--capture'),flag('--record'),flag('--annotated-by'));break;
  case 'capture-list':result=captureList(flag('--workspace'));break;
  case 'capture-show':result=captureShow(flag('--workspace'),flag('--capture'),flag('--ref'));break;
  case 'capture-disclosure-grant':result=captureDisclosureGrant(flag('--workspace'),flag('--file'));break;
  case 'capture-disclosure-read':result=captureDisclosureRead(flag('--workspace'),flag('--grant'),{session:flag('--session'),host:flag('--host'),role:'director',purpose:'internal_read'});break;
  case 'capture-disclosure-revoke':result=captureDisclosureRevoke(flag('--workspace'),flag('--grant'),flag('--owner-quote'));break;
  case 'session-rerun':result=sessionRerun(flag('--workspace'),flag('--session'),flag('--reason'),{host:opt('--host'),allowDirtyPins:hasFlag('--allow-dirty-pins')});break;
  case 'source-disclosure-grant':result=sourceDisclosureGrant(flag('--workspace'),flag('--file'),inspectSource);break;
  case 'source-disclosure-list':result=sourceDisclosureList(flag('--workspace'),opt('--session'));break;
  case 'source-disclosure-revoke':result=sourceDisclosureRevoke(flag('--workspace'),flag('--grant'),flag('--owner-quote'));break;
  case 'improvement-propose':result=improvementPropose(flag('--workspace'),flag('--session'),flag('--proposal'),flag('--reported-by'));break;
  case 'improvement-handoff':result=improvementHandoff(flag('--workspace'),flag('--id'),flag('--target'));break;
  case 'improvement-record':result=improvementRecord(flag('--workspace'),flag('--id'),flag('--change'),opt('--tests')??'',opt('--version'));break;
  case 'improvement-decide':result=improvementDecide(flag('--workspace'),flag('--id'),flag('--decision'),flag('--owner-quote'));break;
  case 'improvement-close':result=improvementClose(flag('--workspace'),flag('--id'));break;
  case 'improvement-list':result=improvementList(flag('--workspace'),opt('--session'));break;
  case 'status':result=listRuns(resolve(flag('--workspace')));break;
  case 'inspect':result=inspectRun(resolve(flag('--workspace')),flag('--run-id'));break;
  default:throw new Error('Usage: studio [context-sync|context-search --query Q|session-start --idea TEXT [--slug S]|evidence-add --session S (--catalog ID [--section H] | --kind web|github|gdrive|other --uri U --file F --retrieved-by host:tool [--revision R] [--visibility approved|restricted [--owner-quote TEXT, required to approve non-web evidence]])|session-note --session S --kind K --file F|direction-approve --session S --direction F|session-run --session S [--host H] [--allow-dirty-pins]|session-status [--session S]|capture-import --file F --host H --format studio|text|chatgpt-export|claude-export|claude-code-jsonl --authorization TEXT --title T [--visibility] [--conversation-id] [--from N --to N]|capture-annotate --capture ID --record F --annotated-by host:tool|capture-list|capture-show --capture ID --ref ci-N|mN|capture-disclosure-grant --file F|capture-disclosure-read --grant ID --session S --host H|capture-disclosure-revoke --grant ID --owner-quote TEXT|session-rerun --session S --reason R [--host H] [--allow-dirty-pins]|source-disclosure-grant --file F|source-disclosure-list [--session S]|source-disclosure-revoke --grant ID --owner-quote TEXT|improvement-propose --session S --proposal F --reported-by host:tool|improvement-handoff --id I --target claude-code|codex|improvement-record --id I --change REF [--tests "cmd => result"] [--version vNNN]|improvement-decide --id I --decision approve|reject --owner-quote TEXT|improvement-close --id I|improvement-list [--session S]  (all with --workspace DIR)|doctor|eval <pack> [--baseline <git-ref-or-results-file>] [--live] [--provider <name>] [--results-dir <dir>]|run --workspace DIR --request FILE|resume --workspace DIR --run-id ID|revise --workspace DIR --run-id ID --feedback FILE|approve --workspace DIR --run-id ID --digest SHA256 [--decisions FILE]|cancel --workspace DIR --run-id ID --reason TEXT|handoff-check --workspace DIR --run-id ID [--model haiku]|handoff-prompt --workspace DIR --run-id ID|handoff-score --workspace DIR --run-id ID --answer FILE|status --workspace DIR|inspect --workspace DIR --run-id ID]');
 }
 if(pending) pending.then(value=>console.log(JSON.stringify(value,null,2))).catch(e=>{console.error('STUDIO ERROR:',e instanceof Error?e.message:String(e));process.exitCode=1});
 else console.log(JSON.stringify(result,null,2));
}catch(e){console.error('STUDIO ERROR:',e instanceof Error?e.message:String(e));process.exitCode=1}
