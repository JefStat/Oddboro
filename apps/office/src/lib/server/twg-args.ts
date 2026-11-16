// What the office lets an Odd ask the Teamwork Graph CLI (`twg`). It runs
// outside the Odd's sandbox as the owner's own twg login, so the office keeps
// to the Atlassian products the owner chose, never switches login, and never
// passes a file of this computer. Whether a command only reads is what twg
// itself says of it (`twg help <command>`), checked by `twg-tool.ts`.

/** The products an Odd may use. `bb` is Bitbucket's short name, `context` the graph's reads. */
const PRODUCTS = new Set([
  'jira',
  'confluence',
  'bitbucket',
  'bb',
  'rovo',
  'goals',
  'projects',
  'teams',
  'context'
]);

/** Flags that choose another login, or read or write a file of this computer. */
const NEVER_FLAGS = new Set([
  '-p',
  '--profile',
  '-u',
  '--user',
  '--output-path',
  '--sqlite-file',
  '--file',
  '--file-local',
  '--file-remote',
  '--files-from',
  '--input-file',
  '--variables-file'
]);

const MAX_ARGS = 60;
const MAX_ARG_CHARS = 20_000;

export type TwgCheck = { ok: true; path: string[] } | { ok: false; why: string };

/** The command words before the first flag, at most four: `jira workitem get`. */
export function commandPath(args: readonly string[]): string[] {
  const words: string[] = [];
  for (const a of args) {
    if (a.startsWith('-') || words.length === 4) break;
    words.push(a);
  }
  return words;
}

/** Whether `args` may run at all, and the command path to look up. */
export function checkTwg(args: readonly string[]): TwgCheck {
  if (args.length === 0) return { ok: false, why: 'Give twg at least one argument.' };
  if (args.length > MAX_ARGS) return { ok: false, why: `Give twg at most ${MAX_ARGS} arguments.` };
  if (args.some((a) => a.length > MAX_ARG_CHARS || a.includes('\0')))
    return { ok: false, why: 'An argument is too long or holds a null byte.' };
  const [product = ''] = args;
  if (!PRODUCTS.has(product))
    return {
      ok: false,
      why: `The office runs twg for ${[...PRODUCTS].join(', ')} only. Start with one of them.`
    };
  const flag = args.find((a) => NEVER_FLAGS.has(a.split('=')[0]));
  if (flag) return { ok: false, why: `The office refuses ${flag.split('=')[0]}.` };
  if (args.some((a) => a.startsWith('@') || a.includes('=@')))
    return { ok: false, why: 'The office refuses a value that starts with @, which reads a file.' };
  return { ok: true, path: commandPath(args) };
}

/** What twg says a command does. One JSON line of `twg help <command>` per command. */
export type Access = 'read' | 'mutation' | 'unknown';

/** The access twg gives the command at exactly `path`, from the lines `twg help` printed. */
export function accessOf(helpLines: string, path: readonly string[]): Access | undefined {
  for (const line of helpLines.split('\n')) {
    try {
      const d = JSON.parse(line) as { type?: string; path?: string[]; access?: string };
      if (
        d.type === 'idx' &&
        d.path?.length === path.length &&
        d.path.every((w, i) => w === path[i])
      )
        return d.access === 'read' || d.access === 'mutation' ? d.access : 'unknown';
    } catch {
      // A line that is not JSON is not a command.
    }
  }
  return undefined;
}
