import { join, dirname } from 'node:path';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  rmSync,
  existsSync,
  watch,
  type FSWatcher
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  advancedMode,
  home,
  STAFF_SERVER,
  PROJECT_RECEIVERS,
  type OpenSession,
  type ProjectSession,
  type ProjectRequest
} from '@oddboro/ledger';
import { pathToFileURL } from 'node:url';
import { AGENT_NAMES } from '@oddboro/ledger/agents';
import { currentSystem, probe } from '@oddboro/ledger/platform';
import { computerWord } from '@oddboro/ledger/system-words';
import { nativeCommand, nativeEnv, UUID } from './native.ts';
import { savedClaudeSessions, transcriptOf } from './claude-sessions.ts';
type Active = {
  pid?: number;
  sessionId?: string;
  id?: string;
  kind: string;
  cwd: string;
  name?: string;
  status?: string;
  waitingFor?: string;
};
/**
 * What the owner reads when Claude Code cannot list a project's conversations.
 * The project-sessions route shows a thrown message as it is, so a raw error
 * from starting the command (its path, ENOENT) never reaches the owner.
 * `missing` names the system as it is when the listing fails, not as this file
 * loaded, since a test fakes the system after that.
 */
export const CLAUDE_LIST_FAILED = {
  missing: () => `${AGENT_NAMES.claude} is not installed on this ${computerWord(currentSystem())}.`,
  failed: `${AGENT_NAMES.claude} could not list this project's conversations. Try again.`
};

/**
 * The sessions `claude agents --json` printed, or undefined when it printed
 * anything but a list. Entries that are not objects are left out.
 */
function agentList(out: string): Active[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(out);
  } catch {
    // The caller tells the owner the listing failed; the parser's own words
    // would show them a raw SyntaxError.
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  return list.filter((a): a is Active => typeof a === 'object' && a !== null);
}

/**
 * The Claude Code sessions running in `folder`, from `claude agents --json`.
 * With no folder, every session open on this computer.
 */
async function claudeAgents(folder?: string): Promise<Active[]> {
  const [exe, prefix] = nativeCommand('claude');
  const where = folder ? ['--cwd', folder] : [];
  const r = await probe(exe, [...prefix, 'agents', '--json', ...where], {
    env: nativeEnv(),
    ...(folder ? { cwd: folder } : {}),
    timeout: 10000,
    maxBuffer: 4_000_000
  });
  switch (r.status) {
    case 'ok': {
      const list = agentList(r.out);
      if (!list) throw new Error(CLAUDE_LIST_FAILED.failed);
      return list;
    }
    case 'missing':
      throw new Error(CLAUDE_LIST_FAILED.missing());
    case 'failed':
    case 'timeout':
      throw new Error(CLAUDE_LIST_FAILED.failed);
    default: {
      const missed: never = r;
      throw new Error(`claude agents came back as ${JSON.stringify(missed)}`);
    }
  }
}

/** The most open sessions a run is told of. */
const OPEN_MAX = 50;
const TITLE_MAX = 200;

/**
 * Every Claude Code session open on this computer, as an Odd's chat run is
 * told of them (`OPEN_SESSIONS`). A Claude Code that is missing or cannot list
 * them gives none, with the owner's words for why.
 */
export async function openClaudeSessions(): Promise<{ open: OpenSession[]; why?: string }> {
  let listed: Active[];
  try {
    listed = await claudeAgents();
  } catch (e: unknown) {
    return { open: [], why: e instanceof Error ? e.message : CLAUDE_LIST_FAILED.failed };
  }
  // An entry Claude Code wrote in another shape is left out, never the whole list.
  const open = listed.flatMap((a): OpenSession[] =>
    typeof a.sessionId === 'string' && UUID.test(a.sessionId) && typeof a.cwd === 'string' && a.cwd
      ? [
          {
            nativeId: a.sessionId,
            folder: a.cwd,
            title: (typeof a.name === 'string' && a.name ? a.name : AGENT_NAMES.claude).slice(
              0,
              TITLE_MAX
            ),
            kind: a.kind === 'background' ? 'background' : 'interactive',
            status: a.status === 'busy' ? 'busy' : 'idle'
          }
        ]
      : []
  );
  return open.length > OPEN_MAX
    ? {
        open: open.slice(0, OPEN_MAX),
        why: `${open.length} sessions are open. The office lists the first ${OPEN_MAX}.`
      }
    : { open };
}

/**
 * The open sessions a run is told of: only a chat that reads no lesson, with
 * Advanced mode on. It never throws, so a run can start it early and await it late.
 */
export async function openSessionsFor(
  run: { ownerSaid?: string; lessonRun?: boolean },
  advanced: () => Promise<boolean> = advancedMode
): Promise<{ open: OpenSession[]; why?: string } | undefined> {
  if (!run.ownerSaid || run.lessonRun) return undefined;
  try {
    if (!(await advanced())) return undefined;
  } catch {
    return { open: [], why: 'The office could not tell whether Advanced mode is on.' };
  }
  return openClaudeSessions();
}

/** One of a project's Claude conversations, saved or running, as Find existing lists it. */
export type ClaudeRow = {
  id: string;
  title: string;
  updated: number;
  live: boolean;
  /** The background job, when one runs it. */
  job: string;
  busy?: boolean;
  pid?: number;
};
export async function claudeProjects(folder: string): Promise<ClaudeRow[]> {
  const [history, processes] = await Promise.all([
    savedClaudeSessions(folder),
    claudeAgents(folder)
  ]);
  const active = processes.filter((a) => a.cwd === folder && a.sessionId);
  const rows = new Map<string, ClaudeRow>(
    history
      .filter((h) => !h.cwd || h.cwd === folder)
      .map((h) => [
        h.sessionId,
        {
          id: h.sessionId,
          title: h.title,
          updated: h.lastModified,
          live: false,
          job: ''
        }
      ])
  );
  for (const a of active)
    rows.set(a.sessionId!, {
      id: a.sessionId!,
      title: a.name || rows.get(a.sessionId!)?.title || 'Claude Code',
      updated: rows.get(a.sessionId!)?.updated || Date.now(),
      live: true,
      job: a.id || '',
      busy: a.status === 'busy',
      pid: typeof a.pid === 'number' ? a.pid : undefined
    });
  return [...rows.values()].sort((a, b) => b.updated - a.updated);
}

/** What the owner reads when the office cannot move a session in. */
export const MOVE_FAILED = {
  stop: 'The office could not close that session where it runs. Close it there, then press Move into Oddboro.',
  slow: 'That session did not close in time. Close it where it runs, then press Move into Oddboro.',
  busy: 'The session stayed busy. Press Move into Oddboro to try again.',
  noTranscript:
    'The office cannot see that session working, so it cannot wait for it. Wait until it is idle, then press Move into Oddboro.'
};

/** How long a closing session has to leave `claude agents`, and how often the office looks. */
const GONE_WITHIN_MS = 10_000;
const GONE_LOOK_MS = 250;
/** How long the office waits for a busy turn to end before it gives up. */
const IDLE_WITHIN_MS = 30 * 60_000;

/**
 * Close a session where it runs, keeping its conversation: `claude stop` for a
 * background job, or SIGTERM for one in a terminal, which Claude Code ends on
 * cleanly with its transcript whole.
 */
export async function endSession(row: Pick<ClaudeRow, 'job' | 'pid'>): Promise<void> {
  if (row.job) {
    const [exe, prefix] = nativeCommand('claude');
    const r = await probe(exe, [...prefix, 'stop', row.job], { env: nativeEnv(), timeout: 10000 });
    if (r.status !== 'ok') throw new Error(MOVE_FAILED.stop);
    return;
  }
  if (row.pid === undefined) throw new Error(MOVE_FAILED.stop);
  try {
    process.kill(row.pid, 'SIGTERM');
  } catch (e: unknown) {
    // Gone already is what the office wanted.
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(MOVE_FAILED.stop);
  }
}

/** Wait, a bounded time, until `claude agents` no longer lists the session as running. */
export async function untilGone(
  folder: string,
  sessionId: string,
  list: (folder: string) => Promise<ClaudeRow[]> = claudeProjects
): Promise<void> {
  const end = Date.now() + GONE_WITHIN_MS;
  for (;;) {
    const row = (await list(folder)).find((r) => r.id === sessionId && r.live);
    if (!row) return;
    if (Date.now() >= end) throw new Error(MOVE_FAILED.slow);
    await new Promise((resolve) => setTimeout(resolve, GONE_LOOK_MS));
  }
}

/**
 * Wait until the session is idle, looking again only when its transcript
 * changes, since a turn writes there, and never past `IDLE_WITHIN_MS`.
 */
export async function untilIdle(
  folder: string,
  sessionId: string,
  list: (folder: string) => Promise<ClaudeRow[]> = claudeProjects,
  signal?: AbortSignal
): Promise<void> {
  const busy = async () => (await list(folder)).some((r) => r.id === sessionId && r.live && r.busy);
  if (!(await busy())) return;
  const file = await transcriptOf(sessionId);
  if (!file) throw new Error(MOVE_FAILED.noTranscript);
  await new Promise<void>((resolve, reject) => {
    let looking = false;
    // A change while the office looks gets one more look, so the turn's last write is never missed.
    let again = false;
    let finished = false;
    const done = (e?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      watcher.close();
      signal?.removeEventListener('abort', aborted);
      if (e) reject(e);
      else resolve();
    };
    const aborted = () => done(new Error(MOVE_FAILED.busy));
    const limit = setTimeout(() => done(new Error(MOVE_FAILED.busy)), IDLE_WITHIN_MS);
    const look = () => {
      if (finished) return;
      if (looking) {
        again = true;
        return;
      }
      looking = true;
      again = false;
      busy()
        .then((still) => (still ? undefined : done()))
        .catch((e: unknown) => done(e instanceof Error ? e : new Error(String(e))))
        .finally(() => {
          looking = false;
          if (again) look();
        });
    };
    const watcher = watch(file, look);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
const jsonFile = (p: string, data: unknown) => {
  const tmp = p + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, p);
};
const boxOf = (s: ProjectSession) => home('project-sessions', s.id, 'inbox');
export function prepareClaude(s: ProjectSession) {
  const root = home('project-sessions', s.id),
    market = join(root, 'market'),
    plugin = join(market, 'plugin'),
    box = boxOf(s);
  mkdirSync(box, { recursive: true, mode: 0o700 });
  mkdirSync(join(market, '.claude-plugin'), { recursive: true, mode: 0o700 });
  const ledger = dirname(dirname(STAFF_SERVER));
  cpSync(join(ledger, 'project-plugin'), plugin, { recursive: true });
  // Claude keys installed plugins by name. Two live conversations in one
  // project must keep distinct helpers even after both plugins are reloaded.
  const manifest = join(plugin, '.claude-plugin', 'plugin.json');
  const pluginName = 'oddboro-project-' + s.id;
  jsonFile(manifest, { ...JSON.parse(readFileSync(manifest, 'utf8')), name: pluginName });
  const ext = STAFF_SERVER.endsWith('.ts') ? '.ts' : '.js';
  const link = {
    command: process.execPath,
    args: [join(ledger, 'src', 'project-session-tools' + ext), box, s.nativeId, s.folder]
  };
  jsonFile(join(plugin, '.mcp.json'), { mcpServers: { oddboro_project: link } });
  // The shell line is fixed; paths and session identity live in the adjacent
  // launcher file as quoted JavaScript data, never as shell input.
  writeFileSync(
    join(plugin, 'start-watch.mjs'),
    'process.argv.push(' +
      JSON.stringify(box) +
      ',' +
      JSON.stringify(s.nativeId) +
      ',' +
      JSON.stringify(s.folder) +
      '); await import(' +
      JSON.stringify(pathToFileURL(join(ledger, 'src', 'project-watch' + ext)).href) +
      ');\n'
  );
  // The monitor runs in a POSIX shell, including Git Bash on Windows.
  // Desktop installs can have a bundled Node without a node on the PATH.
  const node = process.execPath.replaceAll('\\', '/').replaceAll("'", "'\\''");
  mkdirSync(join(plugin, 'monitors'), { recursive: true });
  jsonFile(join(plugin, 'monitors', 'monitors.json'), [
    {
      name: 'office-work',
      command: "'" + node + "'" + ' "${CLAUDE_PLUGIN_ROOT}/start-watch.mjs"',
      description: 'Work from your connected Oddboro office'
    }
  ]);
  jsonFile(join(market, '.claude-plugin', 'marketplace.json'), {
    name: 'oddboro-' + s.id,
    owner: { name: 'Oddboro' },
    plugins: [
      {
        name: pluginName,
        source: './plugin',
        description: 'Connect this project session to your office.'
      }
    ]
  });
  return { plugin, market, box };
}
/** Each send checks both live receivers, with no prompt leaving before they answer. */
export async function checkClaudeReceiver(s: ProjectSession) {
  const box = boxOf(s),
    key = randomUUID();
  const replies = PROJECT_RECEIVERS.map((receiver) => join(box, key + '.' + receiver));
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (replies.every((file) => existsSync(file))) resolve();
      };
      watcher = watch(box, check);
      watcher.on('error', reject);
      timer = setTimeout(
        () =>
          reject(
            new Error(
              'Claude’s office plugin is not ready. In Details, connect the plugin and reload it in this conversation, then retry. Nothing was sent.'
            )
          ),
        30_000
      );
      jsonFile(join(box, 'probe.json'), { key });
      check();
    });
  } finally {
    watcher?.close();
    clearTimeout(timer);
    for (const file of [join(box, 'probe.json'), ...replies]) rmSync(file, { force: true });
  }
}
export function postClaude(s: ProjectSession, r: ProjectRequest) {
  jsonFile(join(boxOf(s), 'offer.json'), { id: r.id, prompt: r.prompt });
}
/** Keep a correction against its original assignment until Claude acknowledges it. */
export function correctClaude(s: ProjectSession, id: string, prompt: string) {
  const box = boxOf(s),
    file = join(box, 'correction.json');
  if (JSON.parse(readFileSync(join(box, 'offer.json'), 'utf8')).id !== id)
    throw new Error('That assignment has ended.');
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (old.id === id && !existsSync(join(box, old.key + '.correction-read')))
      throw new Error('Claude has not picked up the previous correction yet.');
  }
  jsonFile(file, { id, key: randomUUID(), prompt });
}
export function clearClaude(s: ProjectSession, id: string) {
  const file = join(boxOf(s), 'offer.json');
  if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).id === id) rmSync(file);
}
export function hearClaude(
  s: ProjectSession,
  read: (id: string, answer?: string) => Promise<void>,
  corrected: (id: string) => void,
  failure: (e: unknown) => void
): FSWatcher {
  const box = boxOf(s);
  const check = (name: string) => {
    if (/^[0-9a-f-]{36}\.correction-read$/.test(name)) {
      try {
        corrected(JSON.parse(readFileSync(join(box, name), 'utf8')).id);
      } catch (e) {
        failure(e);
      }
      return;
    }
    const m = /^([0-9a-f-]{36})\.(accepted|reply)$/.exec(name);
    if (!m) return;
    try {
      const body = JSON.parse(readFileSync(join(box, name), 'utf8'));
      void read(m[1], m[2] === 'reply' ? body.answer : undefined).catch(failure);
    } catch (e) {
      failure(e);
    }
  };
  // Not persistent: a watch left open must never keep the office from exiting.
  const w = watch(box, { persistent: false }, (_event, name) => {
    if (name) check(name);
  });
  // A reply published while the office was down must still reach its request.
  const offer = join(box, 'offer.json');
  const answered = () => {
    if (!existsSync(offer)) return;
    const { id } = JSON.parse(readFileSync(offer, 'utf8'));
    for (const suffix of ['accepted', 'reply'])
      if (existsSync(join(box, id + '.' + suffix))) check(id + '.' + suffix);
  };
  answered();
  // On macOS a new watch starts a moment after watch() returns, and a file
  // written in that moment raises no event. Look once more to catch it.
  const again = setTimeout(() => {
    try {
      answered();
    } catch (e) {
      failure(e);
    }
  }, 1000).unref();
  w.once('close', () => clearTimeout(again));
  return w;
}
