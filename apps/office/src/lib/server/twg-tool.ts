// The Teamwork Graph CLI as an outside tool the office runs itself, on the
// owner's own twg login. An Odd gets twg_read, for commands twg itself marks
// as reads, and twg_write, for every other command, which the gateway holds
// on the desk. The login stays in the owner's home, never in the Odd's reach.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { currentPlatform } from '@oddboro/ledger/platform';
import { z } from 'zod';
import { cap, DATA_NOTE, untrusted } from './google/http.ts';
import { onPath } from './on-path.ts';
import { outsideToolEnv } from './run-env-allow.ts';
import { accessOf, checkTwg, type Access } from './twg-args.ts';

const TIMEOUT_MS = 90_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Where `twg` sits when the office's PATH lacks the folder, as in an app started from the Dock. */
const FALLBACKS = (): string[] =>
  currentPlatform() === 'win32'
    ? [join(process.env.LOCALAPPDATA ?? homedir(), 'twg', 'twg.exe')]
    : ['/opt/homebrew/bin/twg', '/usr/local/bin/twg', join(homedir(), '.local', 'bin', 'twg')];

export const twgBinary = (): string | undefined =>
  onPath('twg') ?? FALLBACKS().find((f) => existsSync(f));

type Done = { code: number; out: string; err: string };

function runTwg(bin: string, args: string[], cwd: string): Promise<Done> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        // The owner's home, so twg finds its own login. Nothing else of the office's environment.
        env: { ...outsideToolEnv(), TWG_AGENT_DEFAULTS: '1', NO_COLOR: '1' },
        windowsHide: true,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER
      },
      (error, out, err) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, out, err: err || (error && code === 1 ? error.message : '') });
      }
    );
  });
}

const known = new Map<string, Access>();

/** What twg says the command at `path` does, longest path first, asked once per path. */
async function accessFor(bin: string, path: string[], cwd: string): Promise<Access> {
  for (let n = path.length; n >= 2; n--) {
    const words = path.slice(0, n);
    const key = words.join(' ');
    const hit = known.get(key);
    if (hit) return hit;
    const found = accessOf((await runTwg(bin, ['help', ...words], cwd)).out, words);
    if (found) {
      known.set(key, found);
      return found;
    }
  }
  return 'unknown';
}

const reply = (text: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {})
});

/** `args` with JSON output asked for, unless the Odd chose a format. */
const withJson = (args: string[]): string[] =>
  args.some((a) => a === '-o' || a === '--output' || a.startsWith('--output='))
    ? args
    : [...args, '--output', 'json'];

/** One twg call as a tool result, or a refusal in words the Odd can read. */
export async function callTwg(args: string[], want: 'read' | 'write'): Promise<CallToolResult> {
  const check = checkTwg(args);
  if (!check.ok) return reply(check.why, true);
  const bin = twgBinary();
  if (!bin)
    return reply(
      'The Teamwork Graph CLI (twg) is not installed on this computer, or is not signed in. The owner installs it and runs twg login.',
      true
    );
  const cwd = await mkdtemp(join(tmpdir(), 'ob-twg-'));
  try {
    if (want === 'read' && (await accessFor(bin, check.path, cwd)) !== 'read')
      return reply('twg does not mark that command as only reading. Call twg_write with it.', true);
    const done = await runTwg(bin, withJson(args), cwd);
    const text = [done.out, done.err].filter(Boolean).join('\n') || '(no output)';
    return reply(untrusted('twg', cap(text), check.path.join(' ')), done.code !== 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const argv = z
  .array(z.string())
  .describe(
    'The arguments after twg, one string each: ["jira", "workitem", "get", "SL-123"]. Start with jira, confluence, bitbucket, rovo, goals, projects, teams or context.'
  );

/** The two tools. */
export function twgServer(): McpServer {
  const server = new McpServer({ name: 'twg', version: '1.0.0' });
  server.registerTool(
    'twg_read',
    {
      description: `Run a Teamwork Graph CLI command that only reads, such as jira workitem get or query, confluence search, bitbucket pull requests, or context. It reaches Jira, Confluence and Bitbucket as the owner. twg itself says which commands read: any other is refused here. ${DATA_NOTE}`,
      inputSchema: { args: argv },
      annotations: { readOnlyHint: true }
    },
    ({ args }) => callTwg(args, 'read')
  );
  server.registerTool(
    'twg_write',
    {
      description:
        "Run any other Teamwork Graph CLI command, such as jira workitem create, transition or comment, or a Confluence page update. It changes things in the owner's Jira, Confluence or Bitbucket as them. Local files cannot go in: no file flags or @file values.",
      inputSchema: { args: argv },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    ({ args }) => callTwg(args, 'write')
  );
  return server;
}

/** The tools as an in-memory MCP client. */
export async function twgClient(): Promise<Client> {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await twgServer().connect(theirs);
  const client = new Client({ name: 'oddboro-office', version: '1.0.0' });
  await client.connect(ours);
  return client;
}
