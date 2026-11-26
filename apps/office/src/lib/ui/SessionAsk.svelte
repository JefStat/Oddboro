<script lang="ts">
  // The open Claude Code session an Odd asked for (`ask_to_connect_session`),
  // on its card on the Desk. Connect has the office connect it as Projects
  // does and share it with that Odd. A session running outside the office
  // moves in: Claude there closes and the conversation continues in Projects.
  import type { SessionRequest } from '@oddboro/ledger';

  type Props = {
    /** The Odd that asked, by name. */
    name: string;
    session: SessionRequest;
  };
  let { name, session }: Props = $props();
</script>

<div>
  <dt class="text-xs text-muted">The session</dt>
  <dd class="mt-1 flex flex-col gap-1 text-sm">
    <span class="font-medium">{session.title}</span>
    <span class="font-mono text-xs break-all text-muted">{session.folder}</span>
  </dd>
</div>
<div>
  <dt class="text-xs text-muted">If you connect</dt>
  <dd class="mt-1 flex flex-col gap-1.5 text-sm">
    <p class="rounded-lg bg-ember/15 px-2.5 py-1.5">
      Connect closes Claude in {session.kind === 'interactive'
        ? 'your terminal window'
        : 'its background job'} and continues the same conversation in Oddboro's Projects, once any turn
      in progress ends, with your own shell's settings.
    </p>
    <p>
      The office shares it with {name}. The session works as you, with your own sign-ins. Each piece
      of work {name} sends it still waits for your Take over and send.
    </p>
    <p class="text-[11px] text-faint">
      A session is shared with one Odd at a time, so this moves it from any other Odd.
    </p>
  </dd>
</div>
