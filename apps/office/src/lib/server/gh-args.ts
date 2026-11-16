// What the office lets an Odd ask the GitHub CLI. `gh` runs outside the Odd's
// sandbox, so a flag that reads a file of this Mac, or a command that runs
// code, is refused for both tools. Of the rest, only the listed reads run
// without the owner's yes.

/** Groups, and their subcommands, that only read. A group with `*` reads whatever follows it. */
const READS: Record<string, readonly string[]> = {
  pr: ['list', 'view', 'diff', 'checks', 'status'],
  issue: ['list', 'view', 'status'],
  repo: ['view', 'list'],
  run: ['list', 'view'],
  workflow: ['list', 'view'],
  release: ['list', 'view'],
  gist: ['list', 'view'],
  label: ['list'],
  project: ['list', 'view'],
  ruleset: ['list', 'view', 'check'],
  cache: ['list'],
  search: ['*'],
  status: ['*']
};

/** Groups that sign in, run code or open something on this Mac. Never run. */
const NEVER_GROUPS = new Set([
  'alias',
  'auth',
  'browse',
  'codespace',
  'completion',
  'config',
  'extension',
  'ext',
  'gpg-key',
  'ssh-key'
]);

/** Commands that upload a file of this Mac named on the command line. */
const NEVER_PAIRS = new Set(['gist create', 'gist edit', 'release create', 'release upload']);

/** Flags that read a file of this Mac, or open a browser. */
const NEVER_FLAGS = new Set([
  '--input',
  '--body-file',
  '--notes-file',
  '--file',
  '--field',
  '--web',
  '-w'
]);

const MAX_ARGS = 60;
const MAX_ARG_CHARS = 8_000;

export type GhCheck = { ok: true; reads: boolean } | { ok: false; why: string };

/** Whether `args` may run at all, and whether they only read. */
export function checkGh(args: readonly string[]): GhCheck {
  if (args.length === 0) return { ok: false, why: 'Give gh at least one argument.' };
  if (args.length > MAX_ARGS) return { ok: false, why: `Give gh at most ${MAX_ARGS} arguments.` };
  if (args.some((a) => a.length > MAX_ARG_CHARS || a.includes('\0')))
    return { ok: false, why: 'An argument is too long or holds a null byte.' };
  const [group = '', sub = ''] = args;
  if (group.startsWith('-')) return { ok: false, why: 'Start with a gh command, not a flag.' };
  if (NEVER_GROUPS.has(group)) return { ok: false, why: `The office never runs gh ${group}.` };
  if (NEVER_PAIRS.has(`${group} ${sub}`))
    return { ok: false, why: `The office never runs gh ${group} ${sub}: it uploads local files.` };
  const flag = args.find((a) => NEVER_FLAGS.has(a.split('=')[0]));
  if (flag) return { ok: false, why: `The office refuses ${flag.split('=')[0]}.` };
  if (args.some((a) => a.startsWith('-F')))
    return { ok: false, why: 'The office refuses -F, which can read local files.' };
  if (args.some((a) => a.startsWith('@') || a.includes('=@')))
    return { ok: false, why: 'The office refuses a value that starts with @, which reads a file.' };
  const reads = READS[group];
  return { ok: true, reads: !!reads && (reads.includes('*') || reads.includes(sub)) };
}
