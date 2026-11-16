// The GitHub CLI as an outside tool the office runs itself. An Odd gets two
// tools: gh_read, for the listed reads, and gh_write, for every other command,
// which the gateway holds on the desk. The token is the owner's GitHub
// sign-in, put in the child's environment alone and cut from what comes back.
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
import { checkGh } from './gh-args.ts';
import { cap, DATA_NOTE, untrusted } from './google/http.ts';
import { onPath } from './on-path.ts';
import { outsideToolEnv } from './run-env-allow.ts';

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/** Where `gh` sits when the office's PATH lacks the folder, as in an app started from the Dock. */
const FALLBACKS = (): string[] =>
  currentPlatform() === 'win32'
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', join(homedir(), '.local', 'bin', 'gh')];

export const ghBinary = (): string | undefined =>
  onPath('gh') ?? FALLBACKS().find((f) => existsSync(f));

/** `text` with every copy of `token` cut out. */
export const scrub = (text: string, token: string): string =>
  token ? text.split(token).join('[token]') : text;

type Done = { code: number; out: string; err: string };

function runGh(bin: string, args: string[], token: string, home: string): Promise<Done> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: home,
        env: {
          ...outsideToolEnv(),
          HOME: home,
          USERPROFILE: home,
          GH_CONFIG_DIR: join(home, 'gh'),
          GH_TOKEN: token,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1'
        },
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

const reply = (text: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {})
});

/** One gh call as a tool result, or a refusal in words the Odd can read. */
export async function callGh(
  args: string[],
  want: 'read' | 'write',
  token: () => Promise<string>
): Promise<CallToolResult> {
  const check = checkGh(args);
  if (!check.ok) return reply(check.why, true);
  if (want === 'read' && !check.reads)
    return reply('That command can change something. Call gh_write with it.', true);
  const bin = ghBinary();
  if (!bin)
    return reply(
      'The GitHub CLI is not installed on this computer. The owner installs it from cli.github.com.',
      true
    );
  const secret = await token();
  const home = await mkdtemp(join(tmpdir(), 'ob-gh-'));
  try {
    const done = await runGh(bin, args, secret, home);
    const text = scrub([done.out, done.err].filter(Boolean).join('\n') || '(no output)', secret);
    return reply(untrusted('gh', cap(text), args.slice(0, 2).join(' ')), done.code !== 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const argv = z
  .array(z.string())
  .describe('The arguments after gh, one string each: ["pr", "list", "--repo", "owner/name"].');

/** The two tools, over the owner's GitHub sign-in (`token`). */
export function ghServer(token: () => Promise<string>): McpServer {
  const server = new McpServer({ name: 'gh', version: '1.0.0' });
  server.registerTool(
    'gh_read',
    {
      description: `Run a GitHub CLI command that only reads, such as pr list, pr view, issue view, repo view, run view or search. It reaches the owner's GitHub as them. ${DATA_NOTE}`,
      inputSchema: { args: argv },
      annotations: { readOnlyHint: true }
    },
    ({ args }) => callGh(args, 'read', token)
  );
  server.registerTool(
    'gh_write',
    {
      description:
        "Run any other GitHub CLI command, such as pr create, pr merge, issue comment or api with a method. It changes things in the owner's GitHub as them. Local files cannot go in: no --body-file, --input or @file values.",
      inputSchema: { args: argv },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    ({ args }) => callGh(args, 'write', token)
  );
  return server;
}

/** The tools as an in-memory MCP client, as `builtin` makes one for Gmail. */
export async function ghClient(token: () => Promise<string>): Promise<Client> {
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  await ghServer(token).connect(theirs);
  const client = new Client({ name: 'oddboro-office', version: '1.0.0' });
  await client.connect(ours);
  return client;
}
