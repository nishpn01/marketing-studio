/** Child process for the reliability review: node crash-child.ts <workspace> <slug> ; STUDIO_FAULT_BEFORE_RECEIPT makes it exit mid-run. */
import { sessionRun } from '../../src/director-session.ts';
import { FixtureModel } from '../../src/model-port.ts';
import { script } from '../helpers/fixture-script.ts';
const [ws, slug] = process.argv.slice(2);
console.log(JSON.stringify(sessionRun(ws, slug, { model: new FixtureModel(script()) })));
