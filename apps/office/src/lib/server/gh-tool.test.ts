import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callGh, ghClient, scrub } from './gh-tool.ts';

const windows = process.platform === 'win32';
const TOKEN = 'tok-secret-123';

/** A stand-in gh that prints its arguments and the token it was given. */
function fakeGh(t: { after: (f: () => void) => void }): void {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const file = join(dir, 'gh');
  writeFileSync(file, '#!/bin/sh\necho "args:$*"\necho "token:$GH_TOKEN"\necho "home:$HOME" >&2\n');
  chmodSync(file, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => {
    process.env.PATH = before;
  });
}

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

test('scrub cuts every copy of the token', () => {
  assert.equal(scrub('a tok b tok', 'tok'), 'a [token] b [token]');
  assert.equal(scrub('keep', ''), 'keep');
});

test('runs gh with the token and never gives the token back', { skip: windows }, async (t) => {
  fakeGh(t);
  const r = await callGh(['pr', 'list'], 'read', async () => TOKEN);
  assert.notEqual(r.isError, true);
  assert.match(text(r), /args:pr list/);
  assert.match(text(r), /token:\[token\]/);
  assert.doesNotMatch(text(r), new RegExp(TOKEN));
  assert.match(text(r), /<untrusted source="gh"/);
});

test('gh_read refuses a command that changes something', { skip: windows }, async (t) => {
  fakeGh(t);
  const r = await callGh(['pr', 'merge', '1'], 'read', async () => TOKEN);
  assert.equal(r.isError, true);
  assert.match(text(r), /gh_write/);
});

test('refuses a flag that reads a local file before it runs gh', async () => {
  let asked = false;
  const r = await callGh(['api', 'x', '--input', '/etc/hosts'], 'write', async () => {
    asked = true;
    return TOKEN;
  });
  assert.equal(r.isError, true);
  assert.equal(asked, false);
});

test('lists gh_read as a read and gh_write as a change', async () => {
  const client = await ghClient(async () => TOKEN);
  const { tools } = await client.listTools();
  const marks = Object.fromEntries(tools.map((x) => [x.name, x.annotations?.readOnlyHint]));
  assert.equal(marks.gh_read, true);
  assert.equal(marks.gh_write, false);
  await client.close();
});
