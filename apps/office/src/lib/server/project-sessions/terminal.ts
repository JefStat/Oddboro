// Terminal bytes go only to the owner's session view. A tab closing detaches
// its listener; the native client stays up. Reopening replays a bounded screen history.
import { EventEmitter, once } from 'node:events';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { openProjectTerminal } from '@oddboro/ledger/project-terminal';
import { currentSystem, type System } from '@oddboro/ledger/platform';
import { nativeCommand, nativeEnv } from './native.ts';

type Pty = Awaited<ReturnType<typeof openProjectTerminal>>;

/** The owner's own shell, from their account, or none where it has none (Windows). */
const ownShell = (): string | undefined => {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
};

/** Where the native client starts through the owner's login shell: not Windows, whose shell has no login startup files. */
const LOGIN_SHELL: Record<System, boolean> = { mac: true, linux: true, windows: false };

/**
 * The command that runs the native client through the owner's login shell, so
 * it gets what their own startup files set up, as a new terminal tab does,
 * on top of the office's filtered environment. The client's own arguments
 * pass as arguments, never inside the script, so nothing needs quoting.
 * Windows, and a shell the office does not know, run the client directly.
 */
export function throughLoginShell(
  exe: string,
  args: string[],
  shell = ownShell(),
  system = currentSystem()
): [string, string[]] {
  if (!system || !LOGIN_SHELL[system] || !shell) return [exe, args];
  const name = basename(shell);
  if (name === 'fish') return [shell, ['-l', '-i', '-c', 'exec $argv', exe, ...args]];
  if (['zsh', 'bash', 'sh', 'ksh', 'dash'].includes(name))
    return [shell, ['-l', '-i', '-c', 'exec "$0" "$@"', exe, ...args]];
  return [exe, args];
}

export class ProjectTerminal {
  readonly events = new EventEmitter();
  private child: Pty;
  private history = '';
  private ended = false;
  private writer?: string;
  take(view: string, replace = false) {
    if (!this.writer || replace) {
      this.writer = view;
      this.events.emit('control');
    }
    return this.writer === view;
  }
  controls(view: string) {
    return this.writer === view;
  }
  release(view: string) {
    if (this.writer === view) {
      this.writer = undefined;
      this.events.emit('control');
    }
  }
  requireControl(view: string) {
    if (!this.controls(view)) throw new Error('Take control of the terminal in this window first.');
    return this;
  }

  get screen() {
    return this.history;
  }
  get running() {
    return !this.ended;
  }
  /** Open the native client in a terminal. The terminal library loads here, the first time. */
  static async open(
    agent: 'codex' | 'claude',
    args: string[],
    cwd: string,
    extra: Record<string, string> = {}
  ) {
    const [client, prefix] = nativeCommand(agent);
    const [exe, argv] = throughLoginShell(client, [...prefix, ...args]);
    return new ProjectTerminal(
      await openProjectTerminal(exe, argv, {
        cwd,
        env: { ...nativeEnv(), ...extra, TERM: 'xterm-256color' },
        cols: 100,
        rows: 30,
        name: 'xterm-256color'
      })
    );
  }
  private constructor(child: Pty) {
    this.child = child;
    const stop = () => this.close();
    process.once('exit', stop);
    this.child.onData((s) => {
      this.history = (this.history + s).slice(-240000);
      this.events.emit('data', s);
    });
    this.child.onExit(({ exitCode }) => {
      process.off('exit', stop);
      this.ended = true;
      this.events.emit('exit', exitCode);
    });
  }
  write(text: string) {
    if (this.ended) throw new Error('Reopen this terminal.');
    this.child.write(text);
  }
  resize(cols: number, rows: number) {
    if (!this.ended) this.child.resize(cols, rows);
  }
  async releaseProcess() {
    if (this.ended) return;
    const ended = once(this.events, 'exit', { signal: AbortSignal.timeout(12000) });
    this.close();
    try {
      await ended;
    } catch {
      throw new Error('The native terminal is still closing. Wait before reconnecting.');
    }
  }
  close() {
    if (!this.ended) this.child.kill();
  }
}
