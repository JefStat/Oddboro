import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessOf, checkTwg, commandPath } from './twg-args.ts';

test('takes the command words before the first flag, four at most', () => {
  assert.deepEqual(commandPath(['jira', 'workitem', 'get', 'SL-1', '--output', 'json']), [
    'jira',
    'workitem',
    'get',
    'SL-1'
  ]);
  assert.deepEqual(commandPath(['jira', '--x']), ['jira']);
  assert.equal(commandPath(['a', 'b', 'c', 'd', 'e']).length, 4);
});

test('allows only the chosen Atlassian products', () => {
  for (const p of [
    'jira',
    'confluence',
    'bitbucket',
    'bb',
    'rovo',
    'goals',
    'projects',
    'teams',
    'context'
  ])
    assert.equal(checkTwg([p, 'x']).ok, true, p);
  for (const p of [
    'admin',
    'auth',
    'login',
    'artifacts',
    'loom',
    'trello',
    'jsm',
    'assets',
    'setup'
  ])
    assert.equal(checkTwg([p, 'x']).ok, false, p);
});

test('refuses another login and every file of this computer', () => {
  for (const a of [
    ['jira', 'workitem', 'get', '-p', 'other'],
    ['jira', 'workitem', 'get', '--profile=other'],
    ['jira', 'workitem', 'attachment', 'download', '--output-path', '/tmp/x'],
    ['bitbucket', 'commit', 'create', '--file-local', 'x'],
    ['bitbucket', 'commit', 'create', '--files-from', 'x'],
    ['jira', 'workitem', 'create', '--input-json', '@/etc/hosts'],
    ['jira', 'workitem', 'create', '--input-json=@x']
  ])
    assert.equal(checkTwg(a).ok, false, a.join(' '));
});

test('refuses an empty call and too many arguments', () => {
  assert.equal(checkTwg([]).ok, false);
  assert.equal(checkTwg(['jira', ...Array(60).fill('x')]).ok, false);
});

test('reads the access twg gives the command at exactly that path', () => {
  const lines = [
    '{"type":"meta"}',
    '{"type":"idx","path":["jira","workitem","query"],"access":"read"}',
    '{"type":"idx","path":["jira","workitem","create"],"access":"mutation"}',
    '{"type":"idx","path":["jira","workitem"],"access":"unknown"}',
    'not json'
  ].join('\n');
  assert.equal(accessOf(lines, ['jira', 'workitem', 'query']), 'read');
  assert.equal(accessOf(lines, ['jira', 'workitem', 'create']), 'mutation');
  assert.equal(accessOf(lines, ['jira', 'workitem']), 'unknown');
  assert.equal(accessOf(lines, ['jira', 'board', 'get']), undefined);
});
