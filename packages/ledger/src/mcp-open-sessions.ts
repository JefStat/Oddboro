// The owner's open Claude Code sessions, as the office read them when this
// chat started (`OPEN_SESSIONS`), and the ask to connect one. Only the owner's
// yes connects a session and shares it: these tools never reach one.
import { z } from 'zod';
import type { OpenSession } from './schema.ts';
import { raiseAsk } from './office.ts';
import { projectConnections } from './project-sessions.ts';
import { parseLevel } from './access-words.ts';
import { ME, me, OWNER, offered, tool, json, text, refused, revisesArg, VIA } from './mcp-run.ts';
import { placed, raisedNote } from './mcp-desk.ts';

const SESSION = z.object({
  nativeId: z.string().uuid(),
  folder: z.string().min(1),
  title: z.string(),
  kind: z.enum(['interactive', 'background']),
  status: z.enum(['busy', 'idle'])
});
const OPEN = z.object({ open: z.array(z.unknown()), why: z.string().optional() });

/** The list the office set, or none with why when it set nothing a run can read. */
export function openSessions(raw: string | undefined): { open: OpenSession[]; why?: string } {
  if (!raw) return { open: [], why: 'The office listed no sessions for this run.' };
  try {
    const listed = OPEN.parse(JSON.parse(raw));
    // An entry in another shape is left out, never the whole list.
    const open = listed.open.flatMap((s) => {
      const one = SESSION.safeParse(s);
      return one.success ? [one.data] : [];
    });
    return { open, ...(listed.why ? { why: listed.why } : {}) };
  } catch {
    return { open: [], why: 'The office could not read the list of sessions.' };
  }
}

const LISTED = openSessions(process.env.OPEN_SESSIONS);

/** The native IDs of the sessions the owner shared with this Odd already. */
const sharedIds = async () => new Set((await projectConnections(ME)).map((s) => s.nativeId));

if (offered('find_open_sessions'))
  tool(
    'find_open_sessions',
    {
      description: `See the Claude Code sessions open on ${OWNER}'s computer as this chat started: each one's title, folder, whether it is busy, and whether it is shared with you already. To work with one that is not shared, ask with ask_to_connect_session.`,
      inputSchema: {}
    },
    async () => {
      const shared = await sharedIds();
      return json({
        sessions: LISTED.open.map((s) => ({
          session: s.nativeId,
          title: s.title,
          folder: s.folder,
          status: s.status,
          sharedWithYou: shared.has(s.nativeId),
          // An interactive session takes work only after the owner runs /bg in it.
          ownerRunsBgFirst: s.kind === 'interactive'
        })),
        ...(LISTED.why ? { why: LISTED.why } : {})
      });
    }
  );

if (offered('ask_to_connect_session'))
  tool(
    'ask_to_connect_session',
    {
      description: `Ask ${OWNER} to connect one of their open Claude Code sessions, from find_open_sessions, and share it with you. That session works as ${OWNER}, with their own sign-ins, so only their yes connects it. Once it is shared, send it work with send_project_work; each piece still waits for their yes unless they let you send without asking.${raisedNote}`,
      inputSchema: {
        session: z.string().uuid().describe('The session from find_open_sessions.'),
        why: z.string().max(1000).describe('What work needs it, in one or two plain sentences.'),
        revises: revisesArg
      }
    },
    async ({ session, why, revises }) => {
      if ((parseLevel(process.env.CEILING) ?? me.permission) === 'read')
        return refused('This run can only read.');
      const found = LISTED.open.find((s) => s.nativeId === session);
      if (!found)
        return refused(
          'That session was not open when this chat started. Call find_open_sessions and pick one it lists.'
        );
      if ((await sharedIds()).has(session))
        return refused(
          'That session is shared with you already. Send it work with send_project_work.'
        );
      const on = await placed({});
      if ('problem' in on) return refused(on.problem);
      const { ask } = await raiseAsk(ME, {
        ...on,
        kind: 'session',
        title: `Connect ${found.title}`,
        why,
        ifApproved: `The office connects ${found.title} and shares it with ${me.name}, who can then send it work.`,
        session: {
          nativeId: found.nativeId,
          folder: found.folder,
          title: found.title,
          kind: found.kind
        },
        revises,
        via: VIA
      });
      return text(
        `Ask ${ask.id} is on ${OWNER}'s desk. When they connect the session, a new run of yours picks up the work with it. Check my_asks later for their decision.`
      );
    }
  );
