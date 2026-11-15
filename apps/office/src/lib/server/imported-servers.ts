// The MCP servers a hire's Claude Code agent file listed. Each web address,
// and each name the office's tools already have, becomes an access ask at
// read on the owner's desk, the same ask `ask_for_access` raises. Nothing is
// granted here: the owner says yes or no to each, and a yes gives the usual
// steps to connect it. A server that runs a command is never run or asked for.
import {
  BUILT_IN,
  catalog,
  ensureConnector,
  GITHUB_ADDRESS,
  GITHUB_ID,
  raiseAsk,
  type AskRow
} from '@oddboro/ledger';
import { MOST_SERVERS, sortServers, type ImportedServer } from '#lib/staff/claude-agent.ts';

/** The office's tools an agent file's server name can match: its catalog and the ones it connects itself. */
export async function knownTools(): Promise<{ id: string; name: string }[]> {
  const saved = await catalog();
  return [...saved, ...BUILT_IN.filter((b) => !saved.some((c) => c.id === b.id))].map((c) => ({
    id: c.id,
    name: c.name
  }));
}

/** The servers a hire's body sent, checked: a name, and a web address or nothing. */
export function serversFrom(v: unknown): ImportedServer[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, MOST_SERVERS)
    .filter(
      (s): s is { name: string; url?: unknown; command?: unknown } =>
        !!s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string'
    )
    .map((s) => ({
      name: s.name.trim().slice(0, 80),
      ...(typeof s.url === 'string' ? { url: s.url.slice(0, 2000) } : {}),
      // A command is kept only so it sorts as listed, never to run it.
      ...(s.command !== undefined ? { command: '' } : {})
    }))
    .filter((s) => s.name);
}

/** Raise one read access ask for each server that asks. A failed one is logged, never a failed hire. */
export async function askForImported(
  staffId: string,
  odd: string,
  servers: ImportedServer[]
): Promise<AskRow[]> {
  if (!servers.length) return [];
  const { asks } = sortServers(servers, await knownTools());
  const raised: AskRow[] = [];
  for (const s of asks) {
    try {
      // Any address on GitHub's server is the catalog's GitHub, which signs in.
      const found = await ensureConnector(
        GITHUB_ADDRESS.test(s.connector) ? GITHUB_ID : s.connector
      );
      if (!found.connector) throw new Error(found.problem);
      const conn = found.connector;
      const { ask } = await raiseAsk(staffId, {
        title: `Connect ${conn.name} (read)`,
        why: `${odd}'s Claude Code agent file lists the MCP server "${s.name}". Say yes to connect it at read, or no to leave it out.`,
        ifApproved: conn.readyAt
          ? `${odd} can use ${conn.name} at once: you connected it already, so there are no steps.`
          : `You get numbered steps to connect ${conn.name} for ${odd}.`,
        access: { connector: conn.id, level: 'read' }
      });
      raised.push(ask);
    } catch (e) {
      console.error(`[hire] access ask for ${s.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return raised;
}
