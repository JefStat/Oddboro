// Exercise the same MCP tools a run receives. Only Google's HTTP reply is a fixture.
import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readsOnly } from '@oddboro/ledger';
import { calendarServer, ownerEdit, withEventFooter } from './calendar.ts';
import { OWNER_META } from './http.ts';

const [ours, theirs] = InMemoryTransport.createLinkedPair();
const server = calendarServer(async () => 'test-token', 'reader@example.com');
await server.connect(ours);
const client = new Client({ name: 'calendar-test', version: '1' });
await client.connect(theirs);
after(async () => {
  await client.close();
  await server.close();
});

const calendar_id = 'room#1@group.calendar.google.com';
const period = { time_min: '2026-11-15T00:00:00-08:00', time_max: '2026-11-16T00:00:00-08:00' };

test('a read grant gets four calendar tools and each names its own account', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools
      .filter(readsOnly)
      .map((t) => t.name)
      .sort(),
    ['check_availability', 'get_event', 'list_calendars', 'list_events']
  );
  assert.ok(tools.every((t) => t.description?.includes('reader@example.com')));
});

test('calendar and event lists keep continuation tokens and the bounds on recurring events', async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer test-token');
    urls.push(new URL(input));
    return Response.json({ nextPageToken: 'following', items: [{ summary: 'A <meeting>' }] });
  });
  await client.callTool({ name: 'list_calendars', arguments: { page_token: 'second page' } });
  assert.equal(urls[0].pathname, '/calendar/v3/users/me/calendarList');
  assert.equal(urls[0].searchParams.get('pageToken'), 'second page');
  const r = await client.callTool({
    name: 'list_events',
    arguments: { calendar_id, ...period, page_token: 'next' }
  });
  assert.equal(
    urls[1].pathname,
    '/calendar/v3/calendars/room%231%40group.calendar.google.com/events'
  );
  const params = urls[1].searchParams;
  assert.equal(params.get('timeMin'), period.time_min);
  assert.equal(params.get('timeMax'), period.time_max);
  assert.equal(params.get('singleEvents'), 'true');
  assert.equal(params.get('orderBy'), 'startTime');
  assert.equal(params.get('pageToken'), 'next');
  assert.match(JSON.stringify(r.content), /following/);
  assert.match(JSON.stringify(r.content), /untrusted/);
});

test('get_event reads the selected occurrence and a busy check keeps errors by calendar', async (t) => {
  const sent: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent.push(new Request(url, init));
    return Response.json({ calendars: { secondary: { errors: [{ reason: 'notFound' }] } } });
  });
  await client.callTool({
    name: 'get_event',
    arguments: { calendar_id: 'primary', event_id: 'abc_20261115T140000Z' }
  });
  assert.equal(
    new URL(sent[0].url).pathname,
    '/calendar/v3/calendars/primary/events/abc_20261115T140000Z'
  );
  const r = await client.callTool({
    name: 'check_availability',
    arguments: { calendar_ids: ['primary', 'secondary'], ...period }
  });
  assert.equal(sent[1].method, 'POST');
  assert.equal(new URL(sent[1].url).pathname, '/calendar/v3/freeBusy');
  assert.deepEqual(await sent[1].json(), {
    timeMin: period.time_min,
    timeMax: period.time_max,
    items: [{ id: 'primary' }, { id: 'secondary' }]
  });
  assert.match(JSON.stringify(r.content), /notFound/);
  const bad = await client.callTool({
    name: 'list_events',
    arguments: { calendar_id, ...period, time_max: period.time_min }
  });
  assert.equal(bad.isError, true);
  assert.equal(sent.length, 2);
});

test('only create_event and update_event change anything, and no tool deletes', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools
      .filter((t) => !readsOnly(t))
      .map((t) => t.name)
      .sort(),
    ['create_event', 'update_event']
  );
  assert.ok(tools.every((t) => !t.annotations?.destructiveHint));
});

/** Every call to Google, with its body, and an event on the calendar with these attendees. */
function stand(t: TestContext, on: object[] = []) {
  const sent: { method: string; url: URL; body?: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    sent.push({
      method,
      url: new URL(url),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    });
    return Response.json(method === 'GET' ? { summary: 'Standup', attendees: on } : { id: 'e1' });
  });
  return sent;
}
const yes = { _meta: { [OWNER_META]: true } };
const lunch = {
  summary: 'Lunch',
  start_time: '2026-11-20T12:00:00-08:00',
  end_time: '2026-11-20T13:00:00-08:00'
};

test("an event with guests is refused from a run, and goes with sendUpdates=all on the owner's click", async (t) => {
  const sent = stand(t);
  const refused = await client.callTool({
    name: 'create_event',
    arguments: { ...lunch, attendees: ['ada@example.com'] }
  });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /only when the owner clicks/);
  assert.equal(sent.length, 0);
  // Only the owner's own address on it: nobody else is emailed, so it goes.
  const own = await client.callTool({
    name: 'create_event',
    arguments: { ...lunch, attendees: ['Reader@example.com'] }
  });
  assert.notEqual(own.isError, true);
  assert.equal(sent[0].url.searchParams.get('sendUpdates'), 'none');
  const r = await client.callTool({
    name: 'create_event',
    arguments: { ...lunch, attendees: ['ada@example.com'], description: 'Bring cake.' },
    ...yes
  });
  assert.notEqual(r.isError, true);
  assert.equal(sent[1].url.searchParams.get('sendUpdates'), 'all');
  // On the click the description is the owner's: the office adds nothing.
  assert.equal(sent[1].body?.description, 'Bring cake.');
  assert.match(JSON.stringify(r.content), /emailed an invite to ada@example\.com/);
});

test('an all-day event takes dates, and an end before its start is refused', async (t) => {
  const sent = stand(t);
  await client.callTool({
    name: 'create_event',
    arguments: { summary: 'Off', start_time: '2026-12-24', end_time: '2026-12-27', all_day: true }
  });
  assert.deepEqual(sent[0].body?.start, { date: '2026-12-24' });
  assert.deepEqual(sent[0].body?.end, { date: '2026-12-27' });
  const back = await client.callTool({
    name: 'create_event',
    arguments: { ...lunch, end_time: '2026-11-20T11:00:00-08:00' }
  });
  assert.equal(back.isError, true);
  const zoneless = await client.callTool({
    name: 'create_event',
    arguments: { summary: 'x', start_time: '2026-11-20T12:00:00', end_time: '2026-11-20T13:00:00' }
  });
  assert.equal(zoneless.isError, true);
  assert.equal(sent.length, 1);
});

test('a change to an event with guests on it waits for the click, and keeps the guests it does not take off', async (t) => {
  const sent = stand(t, [
    { email: 'reader@example.com', self: true },
    { email: 'bo@example.com', responseStatus: 'accepted' },
    { email: 'cy@example.com' }
  ]);
  const refused = await client.callTool({
    name: 'update_event',
    arguments: { event_id: 'e1', location: 'Cafe' }
  });
  assert.equal(refused.isError, true);
  assert.ok(sent.every((s) => s.method === 'GET'));
  await client.callTool({
    name: 'update_event',
    arguments: {
      event_id: 'e1',
      added_attendees: ['di@example.com'],
      removed_attendee_emails: ['cy@example.com']
    },
    ...yes
  });
  const patch = sent.find((s) => s.method === 'PATCH')!;
  assert.equal(patch.url.pathname, '/calendar/v3/calendars/primary/events/e1');
  assert.equal(patch.url.searchParams.get('sendUpdates'), 'all');
  assert.deepEqual(patch.body?.attendees, [
    { email: 'reader@example.com', self: true },
    { email: 'bo@example.com', responseStatus: 'accepted' },
    { email: 'di@example.com' }
  ]);
});

test('the line Oddboro adds goes in once, and the owner edits only the event itself', () => {
  assert.equal(withEventFooter(undefined), 'Added by Oddboro: https://oddboro.com');
  assert.equal(withEventFooter('Agenda'), 'Agenda\n\nAdded by Oddboro: https://oddboro.com');
  assert.equal(withEventFooter(withEventFooter('Agenda')), withEventFooter('Agenda'));
  const held = { calendar_id: 'team', event_id: 'e1', summary: 'Old', location: 'Here' };
  assert.deepEqual(
    ownerEdit('update_event', held, {
      event_id: 'e2',
      calendar_id: 'mine',
      summary: 'New',
      location: '',
      added_attendees: ['ada@example.com']
    }),
    { calendar_id: 'team', event_id: 'e1', summary: 'New', added_attendees: ['ada@example.com'] }
  );
  assert.throws(() => ownerEdit('list_events', held, {}), /Only a calendar event/);
});
