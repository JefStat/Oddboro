// The owner's yes to an Odd's ask to connect an open Claude Code session, through
// the real route and database. Only Claude's process discovery and the native
// terminal stand in for an installed client.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { L, folder, refusal, request } from '../office-under-test.ts';

const claude = await import('./claude-project.ts');
let running: Awaited<ReturnType<typeof claude.claudeProjects>> = [];
/** What happens while the office looks the session up, as a connect takes seconds. */
let meanwhile = async () => {};
mock.module('./claude-project.ts', {
  namedExports: {
    ...claude,
    claudeProjects: async () => {
      await meanwhile();
      return running;
    }
  }
});
mock.module('./terminal.ts', {
  namedExports: {
    ProjectTerminal: {
      open: async () => ({
        running: true,
        events: new EventEmitter(),
        releaseProcess: async () => {}
      })
    }
  }
});
const { projectController } = await import('./controller.ts');

async function sessionAsk(project: string, nativeId: string, kind: 'interactive' | 'background') {
  const { ask } = await L.raiseAsk('paige', {
    kind: 'session',
    title: 'Connect App work',
    why: 'The release notes live there.',
    ifApproved: 'The office connects it.',
    session: { nativeId, folder: project, title: 'App work', kind }
  });
  return ask.id;
}
const answer = (id: number, body: unknown = {}) =>
  request(`/api/asks/[id]/session`, 'POST', { params: { id: String(id) }, body });

test("the owner's yes connects a background session, shares it with the Odd and approves the ask", async (t) => {
  await L.setOwnerName('Tester');
  await L.setAdvancedMode(true);
  const project = join(folder, 'session-yes');
  mkdirSync(project);
  const nativeId = randomUUID();
  running = [{ id: nativeId, title: 'App work', updated: Date.now(), live: true, job: 'job-1' }];
  const id = await sessionAsk(realpathSync(project), nativeId, 'background');

  const res = await answer(id, { reason: 'Go ahead' });

  assert.equal(res.status, 200, await res.clone().text());
  const { session } = (await res.json()) as { session: string };
  t.after(() => projectController().disconnect(session));
  const asked = await L.ask(id);
  assert.equal(asked?.status, 'approved');
  assert.equal(asked?.session?.connected, session);
  assert.equal((await L.connection(session))?.staffId, 'paige');
});

test('an interactive session that never ran /bg is refused with the step, and the ask stays open', async () => {
  await L.setAdvancedMode(true);
  const project = join(folder, 'session-bg');
  mkdirSync(project);
  const nativeId = randomUUID();
  running = [{ id: nativeId, title: 'App work', updated: Date.now(), live: true, job: '' }];
  const id = await sessionAsk(realpathSync(project), nativeId, 'interactive');

  const { status, message } = await refusal(answer(id));

  assert.equal(status, 409);
  assert.match(message, /\/bg/);
  assert.equal((await L.ask(id))?.status, 'open');
});

test('the route refuses while Advanced mode is off', async () => {
  await L.setAdvancedMode(true);
  const project = join(folder, 'session-off');
  mkdirSync(project);
  const id = await sessionAsk(realpathSync(project), randomUUID(), 'background');
  await L.setAdvancedMode(false);

  const { status } = await refusal(answer(id));

  assert.equal(status, 403);
  assert.equal((await L.ask(id))?.status, 'open');
});

test('an ask answered while the office connects shares nothing, and the owner hears it was answered', async () => {
  await L.setAdvancedMode(true);
  const project = join(folder, 'session-race');
  mkdirSync(project);
  const nativeId = randomUUID();
  running = [{ id: nativeId, title: 'App work', updated: Date.now(), live: true, job: 'job-3' }];
  const id = await sessionAsk(realpathSync(project), nativeId, 'background');
  meanwhile = async () => {
    meanwhile = async () => {};
    await L.decideAsk(id, 'deny', null);
  };

  const { status, message } = await refusal(answer(id));

  assert.equal(status, 409);
  assert.match(message, /answered already/);
  assert.equal((await L.ask(id))?.status, 'denied');
  const connected = (await L.projectConnections()).find((s) => s.nativeId === nativeId);
  assert.equal(connected?.staffId ?? null, null);
  if (connected) await projectController().disconnect(connected.id);
});

test('an ask answered already is refused before anything connects', async () => {
  await L.setAdvancedMode(true);
  const nativeId = randomUUID();
  const id = await sessionAsk('/nowhere', nativeId, 'background');
  await L.decideAsk(id, 'deny', null);

  const { status } = await refusal(answer(id));

  assert.equal(status, 409);
  assert.equal(
    (await L.projectConnections()).find((s) => s.nativeId === nativeId),
    undefined
  );
});
