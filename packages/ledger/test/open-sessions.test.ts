// An Odd finds the owner's open Claude Code sessions in a chat and asks to
// connect one. Only the owner's yes connects it, through the office.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db, toolServer } from './tool-server.ts';

const { staff, asks } = await import('../src/schema.ts');
const { connectProject, shareProject, setAdvancedMode } =
  await import('../src/project-sessions.ts');
const { setOwnerName, decideAsk } = await import('../src/office.ts');
const { eq } = await import('drizzle-orm');
await setOwnerName('Tester');
await db.insert(staff).values({
  id: 'scout',
  name: 'Scout',
  role: 'Researcher',
  remit: 'Finds things.',
  variant: 'a',
  portrait: 'a',
  permission: 'draft',
  desk: 'Find things.'
});

const free = randomUUID();
const taken = randomUUID();
const OPEN_SESSIONS = JSON.stringify({
  open: [
    // An entry in another shape is left out, never the whole list.
    {
      nativeId: 'not-a-session',
      folder: '/work/odd',
      title: 'Odd',
      kind: 'interactive',
      status: 'idle'
    },
    { nativeId: free, folder: '/work/app', title: 'App work', kind: 'interactive', status: 'busy' },
    {
      nativeId: taken,
      folder: '/work/site',
      title: 'Site work',
      kind: 'background',
      status: 'idle'
    }
  ]
});
const chat = { OWNER_SAID: 'Find my sessions.', OPEN_SESSIONS };
const names = async (client: Awaited<ReturnType<typeof toolServer>>) =>
  (await client.listTools()).tools.map((t) => t.name);
const body = (r: Awaited<ReturnType<Awaited<ReturnType<typeof toolServer>>['callTool']>>) =>
  (r.content as { text: string }[])[0].text;

test(
  'the session tools are offered only in a chat with Advanced mode on, and never in a lesson run',
  { timeout: 60_000 },
  async () => {
    const TOOLS = ['find_open_sessions', 'ask_to_connect_session'];
    const offers = async (env: Record<string, string>) => {
      const has = await names(await toolServer('scout', env));
      return TOOLS.filter((t) => has.includes(t));
    };
    await setAdvancedMode(false);
    assert.deepEqual(await offers(chat), []);
    await setAdvancedMode(true);
    assert.deepEqual(await offers(chat), TOOLS);
    assert.deepEqual(await offers({}), []);
    assert.deepEqual(await offers({ ...chat, LESSON_RUN: '1' }), []);
  }
);

test(
  'an Odd lists the open sessions, asks for one, and is refused one it holds, one not open, a repeat and a run at Read',
  { timeout: 60_000 },
  async () => {
    await setAdvancedMode(true);
    const shared = await connectProject('claude', taken, '/work/site', 'Site work');
    await shareProject(shared.id, 'scout');
    const client = await toolServer('scout', chat);
    const ask = (args: Record<string, unknown>) =>
      client.callTool({ name: 'ask_to_connect_session', arguments: { why: 'Notes.', ...args } });

    const listed = JSON.parse(
      body(await client.callTool({ name: 'find_open_sessions', arguments: {} }))
    );
    assert.deepEqual(
      listed.sessions.map(
        (s: { session: string; sharedWithYou: boolean; ownerRunsBgFirst: boolean }) => [
          s.session,
          s.sharedWithYou,
          s.ownerRunsBgFirst
        ]
      ),
      [
        [free, false, true],
        [taken, true, false]
      ]
    );

    assert.equal((await ask({ session: taken })).isError, true);
    assert.equal((await ask({ session: randomUUID() })).isError, true);
    const first = await ask({ session: free });
    assert.ok(!first.isError, body(first));
    const raised = await db.select().from(asks).where(eq(asks.kind, 'session'));
    assert.equal(raised.length, 1);
    assert.deepEqual(raised[0].session, {
      nativeId: free,
      folder: '/work/app',
      title: 'App work',
      kind: 'interactive'
    });
    assert.equal((await ask({ session: free })).isError, true);
    assert.ok(!(await ask({ session: free, revises: raised[0].id })).isError);

    const read = await toolServer('scout', { ...chat, CEILING: 'read' });
    const atRead = await read.callTool({
      name: 'ask_to_connect_session',
      arguments: { session: free, why: 'Notes.' }
    });
    assert.equal(atRead.isError, true);
    await shareProject(shared.id, null);
  }
);

test('a plain approve never connects a session: only the office approves one', async () => {
  const [row] = await db
    .insert(asks)
    .values({
      staffId: 'scout',
      kind: 'session',
      title: 'Connect App work',
      why: 'w',
      ifApproved: 'i',
      session: {
        nativeId: randomUUID(),
        folder: '/work/app',
        title: 'App work',
        kind: 'background'
      }
    })
    .returning();

  await assert.rejects(decideAsk(row.id, 'approve', null), /Connect the session from its card/);
  const [after] = await db.select().from(asks).where(eq(asks.id, row.id));
  assert.equal(after.status, 'open');
});
