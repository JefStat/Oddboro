import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callTwg, twgClient } from './twg-tool.ts';

const windows = process.platform === 'win32';
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

/** A stand-in twg: `help` lists one read and one mutation, anything else echoes its arguments. */
function fakeTwg(t: { after: (f: () => void) => void }): void {
  const dir = mkdtempSync(join(tmpdir(), 'fake-twg-'));
  const file = join(dir, 'twg');
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "help" ]; then
  shift
  echo '{"type":"idx","path":["jira","workitem","query"],"access":"read"}'
  echo '{"type":"idx","path":["jira","workitem","create"],"access":"mutation"}'
  exit 0
fi
echo "ran:$*"
`
  );
  chmodSync(file, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => {
    process.env.PATH = before;
  });
}

test('runs a command twg marks as a read, asking for JSON', { skip: windows }, async (t) => {
  fakeTwg(t);
  const r = await callTwg(['jira', 'workitem', 'query', '--jql', 'x'], 'read');
  assert.notEqual(r.isError, true);
  assert.match(text(r), /ran:jira workitem query --jql x --output json/);
  assert.match(text(r), /<untrusted source="twg"/);
});

test('twg_read refuses a command twg marks as a change', { skip: windows }, async (t) => {
  fakeTwg(t);
  const r = await callTwg(['jira', 'workitem', 'create'], 'read');
  assert.equal(r.isError, true);
  assert.match(text(r), /twg_write/);
});

test('twg_read refuses a command twg does not list', { skip: windows }, async (t) => {
  fakeTwg(t);
  assert.equal((await callTwg(['jira', 'workitem', 'mystery'], 'read')).isError, true);
});

test(
  'twg_write runs any allowed command and keeps the Odd output format',
  { skip: windows },
  async (t) => {
    fakeTwg(t);
    const r = await callTwg(['jira', 'workitem', 'create', '-o', 'text'], 'write');
    assert.match(text(r), /ran:jira workitem create -o text/);
    assert.doesNotMatch(text(r), /--output json/);
  }
);

test('refuses a product the owner did not choose before it runs twg', async () => {
  const r = await callTwg(['admin', 'users'], 'write');
  assert.equal(r.isError, true);
});

test('lists twg_read as a read and twg_write as a change', async () => {
  const client = await twgClient();
  const { tools } = await client.listTools();
  const marks = Object.fromEntries(tools.map((x) => [x.name, x.annotations?.readOnlyHint]));
  assert.equal(marks.twg_read, true);
  assert.equal(marks.twg_write, false);
  await client.close();
});
