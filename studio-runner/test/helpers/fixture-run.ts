/** Child-process entry for crash tests: node fixture-run.ts <start|resume> <workspace> <request|run-id> */
import { startAgentRun, resumeAgentRun } from '../../src/agent-run.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script } from './fixture-script.ts';
const [cmd, ws, arg] = process.argv.slice(2);
const model = new FixtureModel(script());
const out = cmd === 'start' ? startAgentRun(ws, arg, { model }) : resumeAgentRun(ws, arg, { model });
console.log(JSON.stringify({ ...out, calls_by_role: model.calls.map(c => c.role) }));
