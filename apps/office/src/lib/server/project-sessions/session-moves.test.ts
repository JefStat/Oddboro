// A connected Claude Code conversation the owner moved to the background with
// /bg goes on under a new session ID. The office follows it before it opens the
// session, so work never goes to the conversation as it stood before. Only
// Claude's process discovery and the native terminal stand in for a client.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { L, folder } from '../office-under-test.ts';

const claude = await import('./claude-project.ts');
let running: Awaited<ReturnType<typeof claude.claudeProjects>> = [];
mock.module('./claude-project.ts', {
  namedExports: { ...claude, claudeProjects: async () => running }
});
/** What each terminal the office opened was started with. */
const opened: string[][] = [];
mock.module('./terminal.ts', {
  namedExports: {
    ProjectTerminal: {
      open: async (_agent: string, args: string[]) => {
        opened.push(args);
        return { running: true, events: new EventEmitter(), releaseProcess: async () => {} };
      }
    }
  }
});
const { projectController } = await import('./controller.ts');

test('a conversation moved with /bg opens as the session it runs in now, with the plugin answering for that session', async (t) => {
  await L.setOwnerName('Tester');
  await L.setAdvancedMode(true);
  const home = mkdtempSync(join(tmpdir(), 'office-claude-'));
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(() => {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
    rmSync(home, { recursive: true, force: true });
  });
  const project = join(folder, 'moves');
  mkdirSync(project);
  const c = projectController();
  const s = await c.connect('claude', project);
  t.after(() => c.disconnect(s.id));
  await L.shareProject(s.id, 'paige');
  // The owner ran /bg: Claude ends the old transcript naming the new session, whose job runs.
  const after = randomUUID();
  mkdirSync(join(home, 'projects', '-elsewhere'), { recursive: true });
  writeFileSync(
    join(home, 'projects', '-elsewhere', s.nativeId + '.jsonl'),
    JSON.stringify({ type: 'continued-in', sessionId: s.nativeId, continuedInSessionId: after }) +
      '\n'
  );
  running = [{ id: after, title: 'Moves (2)', updated: Date.now(), live: true, job: 'job-9' }];

  await c.terminal(s.id);

  assert.deepEqual(opened.at(-1), ['attach', 'job-9']);
  const now = await L.connection(s.id);
  assert.equal(now?.nativeId, after);
  assert.equal(now?.staffId, 'paige');
  const { plugin } = claude.prepareClaude(now!);
  assert.match(readFileSync(join(plugin, '.mcp.json'), 'utf8'), new RegExp(after));
});
