// The office runs the owner's native client through their own login shell, so
// it gets what their startup files set up. Its arguments go as arguments, so
// a session ID or a folder with spaces reaches the client whole.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { throughLoginShell } from './terminal.ts';

const ARGS = ['--plugin-dir', '/a folder/plugin', '--resume', 'id-1'];

test('fish runs the client as its arguments, a login and interactive shell', () => {
  assert.deepEqual(throughLoginShell('claude', ARGS, '/opt/homebrew/bin/fish', 'mac'), [
    '/opt/homebrew/bin/fish',
    ['-l', '-i', '-c', 'exec $argv', 'claude', ...ARGS]
  ]);
});

test('zsh and bash run the client as "$0" "$@", a login and interactive shell', () => {
  for (const shell of ['/bin/zsh', '/bin/bash'])
    assert.deepEqual(throughLoginShell('claude', ARGS, shell, 'linux'), [
      shell,
      ['-l', '-i', '-c', 'exec "$0" "$@"', 'claude', ...ARGS]
    ]);
});

test('Windows, no shell, and a shell the office does not know run the client directly', () => {
  assert.deepEqual(throughLoginShell('claude', ARGS, '/bin/zsh', 'windows'), ['claude', ARGS]);
  assert.deepEqual(throughLoginShell('claude', ARGS, '', 'mac'), ['claude', ARGS]);
  assert.deepEqual(throughLoginShell('claude', ARGS, '/usr/bin/nu', 'linux'), ['claude', ARGS]);
});
