/** Deterministic role responses over the synthetic tool-library fixture. Output is fixture, not model work. */
import type { ModelRequest } from '../../src/model-port.ts';

export const DRAFT = `# Before the software, the stickers

The Riverside Tool Library had a problem that looked like a software problem. In early March, the volunteer log reads: "Six tools came back late this week." Volunteers texted borrowers by hand.

Two weeks later they added a due-date sticker to each tool. It helped for drills but not for ladders, which members keep for weekend projects.

At the April open day, 9 of 14 members who answered said they had waited for a tool that was out late. That turned a volunteer's frustration into a members' problem.

So the committee chose a small test: automated reminder texts for one month before buying booking software. They will count late returns per week. There is no result yet, and this issue will not pretend there is.`;

export type Overrides = Partial<Record<ModelRequest['role'], (req: ModelRequest, n: number) => string>>;
export function script(o: Overrides = {}) {
  return (req: ModelRequest, n: number): string => {
    if (o[req.role]) return o[req.role]!(req, n);
    switch (req.role) {
      case 'director': return JSON.stringify(brief());
      case 'writer': return JSON.stringify(draft());
      case 'fact_reviewer': return JSON.stringify(facts());
      case 'craft_reviewer': return JSON.stringify(craft());
      default: throw new Error(`fixture script has no default response for role ${req.role}`);
    }
  };
}
export const brief = (x: object = {}) => ({ decision: 'proceed', reason: 'Dated log, member comments and a later decision support one clear story.', reader_question: 'How do you know you need software before you buy it?', angle: 'Cheap fixes first showed which tools and which members the problem really affected.', alternatives_considered: [{ angle: 'A software buying guide', why_not: 'Sources say nothing about products.' }, { angle: 'A success story', why_not: 'No result is recorded yet.' }], reader_promise: 'You will see how to test a cheap fix before buying a tool.', evidence_plan: [{ point: 'Late returns recurred', source_ids: ['src_1'] }, { point: '9 of 14 waited', source_ids: ['src_2'] }, { point: 'One-month reminder test', source_ids: ['src_3'] }], exclusions: ['Do not claim the reminder test worked'], open_questions_for_owner: ['May we name the volunteers?'], length_words: 400, ...x });
export const draft = (x: object = {}, text = DRAFT) => ({ title: 'Before the software, the stickers', draft_markdown: text, claims: [
  { id: 'c01', text: 'Six tools came back late in one week in early March.', draft_quote: '"Six tools came back late this week."', source_ids: ['src_1'] },
  { id: 'c02', text: '9 of 14 members who answered had waited for a late tool.', draft_quote: '9 of 14 members who answered said they had waited for a tool that was out late', source_ids: ['src_2'] },
  { id: 'c03', text: 'The committee chose a one-month reminder test before buying software.', draft_quote: 'automated reminder texts for one month before buying booking software', source_ids: ['src_3'] },
], notes_for_owner: [], ...x });
export const facts = (claims?: object[], unlisted: object[] = []) => ({ claims: claims ?? [
  { claim_id: 'c01', verdict: 'verified', source_id: 'src_1', source_excerpt: 'Six tools came back late this week.', note: '' },
  { claim_id: 'c02', verdict: 'verified', source_id: 'src_2', source_excerpt: '9 of them said they had waited for a tool that was out late.', note: '' },
  { claim_id: 'c03', verdict: 'verified', source_id: 'src_3', source_excerpt: 'test automated reminder texts for one month before buying booking software', note: '' },
], unlisted_claims: unlisted, summary: 'fixture' });
export const craft = (x: object = {}) => ({ verdict: 'ready', reader_promise_met: true, strengths: [{ excerpt: 'There is no result yet', why: 'honest limit' }], findings: [], summary: 'fixture review', ...x });
