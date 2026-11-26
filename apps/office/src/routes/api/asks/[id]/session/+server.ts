// The owner connects the open Claude Code session an Odd asked for
// (`ask_to_connect_session`): `{ reason? }`. The office connects it as
// Projects does, then approves the ask and shares the session with that Odd
// in one transaction (`approveSession`), so the run the answer starts finds it
// shared and an ask answered meanwhile shares nothing. A refusal, such as an
// interactive session that needs /bg first, leaves the ask open and says why.
// /bg carries a conversation on in a new session, so the ask's session is
// followed to the one it runs in now (`continuedAs`).
import { error, json } from '@sveltejs/kit';
import { advancedMode, approveSession, ask } from '@oddboro/ledger';
import { ADVANCED_OFF, projectController } from '#lib/server/project-sessions/controller.ts';
import { continuedAs } from '#lib/server/project-sessions/claude-sessions.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
  if (!(await advancedMode())) error(403, ADVANCED_OFF);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 2000) : '';
  const id = Number(params.id);
  const asked = await ask(id);
  if (!asked || asked.kind !== 'session' || !asked.session)
    error(404, 'No session ask by that number');
  if (asked.status !== 'open') error(409, 'That ask is answered already');
  const { folder, title } = asked.session;
  let connected: string;
  let nativeId: string;
  try {
    nativeId = await continuedAs(asked.session.nativeId);
    connected = (await projectController().connect('claude', folder, nativeId, title)).id;
  } catch (e: unknown) {
    error(409, e instanceof Error ? e.message : 'The office could not connect that session.');
  }
  let approved: boolean;
  try {
    approved = await approveSession(
      id,
      asked.staffId,
      { ...asked.session, nativeId, connected },
      reason || null
    );
  } catch (e: unknown) {
    error(409, e instanceof Error ? e.message : 'The office could not approve that ask.');
  }
  if (!approved) error(409, 'That ask is answered already');
  return json({ ok: true, session: connected });
};
