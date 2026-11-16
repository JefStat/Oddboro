import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGh } from './gh-args.ts';

const reads = (...a: string[]) => {
  const r = checkGh(a);
  return r.ok && r.reads;
};

test('lists reads that run without a hold', () => {
  assert.equal(reads('pr', 'list', '--repo', 'a/b'), true);
  assert.equal(reads('issue', 'view', '12'), true);
  assert.equal(reads('search', 'repos', 'oddboro'), true);
});

test('treats every other command as a change', () => {
  assert.equal(reads('pr', 'merge', '3'), false);
  assert.equal(reads('api', '-X', 'DELETE', 'repos/a/b'), false);
  assert.equal(reads('repo', 'delete', 'a/b'), false);
});

test('refuses commands that run code or sign in', () => {
  for (const g of ['alias', 'extension', 'auth', 'config', 'browse', 'codespace'])
    assert.equal(checkGh([g, 'x']).ok, false, g);
});

test('refuses flags and values that read a file of this computer', () => {
  for (const a of [
    ['api', 'x', '--input', '/etc/hosts'],
    ['api', 'x', '--input=/etc/hosts'],
    ['api', 'x', '-F', 'b=@/etc/hosts'],
    ['api', 'x', '-Fb=@/etc/hosts'],
    ['api', 'x', '-f', 'b=@/etc/hosts'],
    ['pr', 'create', '--body-file', 'x'],
    ['gist', 'create', '/etc/hosts'],
    ['release', 'upload', 'v1', '/etc/hosts'],
    ['pr', 'view', '1', '--web']
  ])
    assert.equal(checkGh(a).ok, false, a.join(' '));
});

test('refuses an empty call, a leading flag and too many arguments', () => {
  assert.equal(checkGh([]).ok, false);
  assert.equal(checkGh(['--version']).ok, false);
  assert.equal(checkGh(Array(61).fill('x')).ok, false);
});
