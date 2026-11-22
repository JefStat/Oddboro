// Finding an npm-installed tool on Windows from its .cmd shim (`npmCommand`),
// when its package is not beside the shim, as pnpm, Yarn and a moved npm
// folder leave it (#343). Plain files in a temporary folder; nothing runs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { npmCommand } from '../src/platform.ts';

const CODEX = ['@openai', 'codex'];

/** A folder on PATH holding codex.cmd with `script` as its run line, and the files in `files`. */
function onPath(script: string, files: string[], fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'npm-command-'));
  const path = process.env.PATH;
  try {
    for (const f of files) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), '');
    }
    writeFileSync(join(dir, 'codex.cmd'), `@ECHO off\r\nSETLOCAL\r\n"%_prog%"  ${script} %*\r\n`);
    process.env.PATH = dir;
    fn(dir);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a shim whose package is elsewhere runs the script its own line names, under this Node', () => {
  const script = join('global', '5', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  for (const from of ['%~dp0\\', '%dp0%\\'])
    onPath(`"${from}${script}"`, [script], (dir) =>
      assert.deepEqual(npmCommand('codex', CODEX), [process.execPath, [join(dir, script)]])
    );
  // Or by its full path.
  const elsewhere = mkdtempSync(join(tmpdir(), 'npm-elsewhere-'));
  const full = join(elsewhere, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
  try {
    onPath(`"${full}"`, [], () =>
      assert.deepEqual(npmCommand('codex', CODEX), [process.execPath, [full]])
    );
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a shim whose script is missing, or is not the tool's package, does not count", () => {
  const script = join('node_modules', '@openai', 'codex', 'bin', 'codex.js');
  onPath(`"%~dp0\\${script}"`, [], () => assert.equal(npmCommand('codex', CODEX), undefined));
  const other = join('node_modules', 'not-codex', 'bin', 'codex.js');
  onPath(`"%~dp0\\${other}"`, [other], () => assert.equal(npmCommand('codex', CODEX), undefined));
  onPath('', [], () => assert.equal(npmCommand('codex', CODEX), undefined));
});
