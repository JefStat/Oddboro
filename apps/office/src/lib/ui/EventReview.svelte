<script lang="ts">
  // One Google Calendar event an Odd's call would make or change (a `call`
  // ask whose call carries `event`), reviewed on the Desk like an email
  // reply: the account and calendar, then the event to edit, and who Google
  // emails. The office makes it, with the owner's changes, only on their
  // click, and only then may Google email anyone. Back and Next, and the
  // arrow keys outside a field, step through the open events, oldest first.
  import type { AskRow, HeldCall, HeldEvent } from '@oddboro/ledger';
  import { untrack } from 'svelte';
  import Markdown from './Markdown.svelte';
  import ReviewNav from './ReviewNav.svelte';
  import { call } from './api.ts';
  import { after, around } from './review-steps.ts';
  import type { StaffProfile } from '../staff/roster.ts';

  type Props = {
    ask: AskRow & { call: HeldCall & { event: HeldEvent } };
    /** Every open event on the desk, oldest first. */
    events: AskRow[];
    staff: StaffProfile[];
    /** The ask this one reworks, when the owner sent that one back. */
    reworks: AskRow | null;
    /** Open another event by its ask id, or go back to the desk with none. */
    ongo: (id: number | undefined) => void;
    /** Open an Odd's card. */
    onstaff: (id: string) => void;
  };
  let { ask: a, events, staff, reworks, ongo, onstaff }: Props = $props();

  const nameOf = (id: string | null) => staff.find((p) => p.id === id)?.name ?? id ?? 'the Odd';
  const from = $derived(nameOf(a.staffId));
  const next = $derived(around(events, a.id).next);

  // The parent keys this view on the ask, so each event starts from the
  // Odd's call, and a desk reload never undoes the owner's edits.
  const held = untrack(() => a.call);
  const args = held.arguments;
  const event = held.event;
  const isNew = held.tool === 'create_event';
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const listOf = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const guestsKey = isNew ? 'attendees' : 'added_attendees';

  const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** A time as the inputs hold it: its wall clock in `tz`, to the minute. */
  function wall(iso: string, tz: string): string {
    if (!OFFSET.test(iso)) return iso.slice(0, 16);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(iso));
    const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
    return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
  }

  const hasTimes = isNew || args.start_time !== undefined;
  const startWas = text(args.start_time);
  const endWas = text(args.end_time);
  const allDayWas = args.all_day === true;
  const zoneWas = text(args.time_zone) || here;
  const inputOf = (v: string) => (allDayWas ? v.slice(0, 10) : v ? wall(v, zoneWas) : '');
  const firstTimes = { start: inputOf(startWas), end: inputOf(endWas), allDay: allDayWas };

  let summary = $state(text(args.summary));
  let start = $state(firstTimes.start);
  let end = $state(firstTimes.end);
  let allDay = $state(allDayWas);
  let zone = $state(zoneWas);
  let location = $state(text(args.location));
  let description = $state(text(args.description));
  let guests = $state(listOf(args[guestsKey]).join(', '));
  let busy = $state(false);
  let problem = $state('');
  /** Ask for changes or Discard, waiting for its note. */
  let mode = $state<'changes' | 'discard' | undefined>();
  let note = $state('');

  const split = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const own = event.account?.toLowerCase();
  const unique = (list: string[]) => [...new Map(list.map((e) => [e.toLowerCase(), e])).values()];
  /** The people the owner's version invites: everyone in Guests but the owner. */
  const invited = $derived(unique(split(guests).filter((e) => e.toLowerCase() !== own)));
  /** For a change: everyone already on the event, whom Google emails about it. */
  const told = $derived(
    event.others.filter((e) => !invited.some((i) => i.toLowerCase() === e.toLowerCase()))
  );
  const emails = $derived(invited.length + told.length > 0);

  /** A wall-clock time or a date as words, read as written: no zone moves it. */
  function said(v: string, withDay: boolean): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
    if (!m) return v;
    const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)));
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      ...(withDay ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' } : {}),
      ...(m[4] ? { hour: 'numeric', minute: '2-digit' } : {})
    }).format(at);
  }
  /** The zone's own long name around that time, and its id: "Pacific Standard Time (America/Los_Angeles)". */
  function zoneSaid(v: string, tz: string): string {
    try {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      const at = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date();
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value;
      return name && name !== tz ? `${name} (${tz})` : tz;
    } catch {
      return tz;
    }
  }
  /** The event's time written out, with its zone. */
  const when = $derived.by(() => {
    if (!start || !end) return '';
    if (allDay) {
      // Google's all-day end is the day after the last day.
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(end);
      const last = m
        ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - 1)).toISOString().slice(0, 10)
        : end;
      return last <= start.slice(0, 10)
        ? `All day, ${said(start, true)}`
        : `All day, ${said(start, true)} to ${said(last, true)}`;
    }
    const sameDay = start.slice(0, 10) === end.slice(0, 10);
    return `${said(start, true)} to ${said(end, !sameDay)}, ${zoneSaid(start, zone)}`;
  });

  /** The owner's version of the fields they may change. The office keeps the rest as the Odd called it. */
  function version(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      summary: summary.trim(),
      location: location.trim(),
      description,
      [guestsKey]: split(guests)
    };
    const moved =
      start !== firstTimes.start ||
      end !== firstTimes.end ||
      allDay !== firstTimes.allDay ||
      zone !== zoneWas;
    if (!moved) {
      for (const k of ['start_time', 'end_time', 'all_day', 'time_zone'])
        if (args[k] !== undefined) out[k] = args[k];
    } else if (allDay) {
      Object.assign(out, {
        start_time: start.slice(0, 10),
        end_time: end.slice(0, 10),
        all_day: true
      });
    } else {
      Object.assign(out, {
        start_time: `${start.slice(0, 16)}:00`,
        end_time: `${end.slice(0, 16)}:00`,
        time_zone: zone.trim()
      });
    }
    return out;
  }

  async function act(fn: () => Promise<unknown>, then: number | undefined) {
    busy = true;
    problem = '';
    try {
      await fn();
      ongo(then);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  const go = () =>
    act(() => call(`/api/asks/${a.id}/call`, { arguments: version() }), after(events, a.id));
  const decide = (decision: 'iterate' | 'deny') =>
    act(() => call(`/api/asks/${a.id}`, { decision, reason: note.trim() }), after(events, a.id));
  /** Skip leaves it on the desk and moves on, round to the first. */
  const skip = () => ongo((next ?? (events[0]?.id !== a.id ? events[0] : undefined))?.id);
  /** A switch between a day and a time keeps the date. */
  function setAllDay(on: boolean) {
    allDay = on;
    start = on ? start.slice(0, 10) : start ? `${start.slice(0, 10)}T09:00` : '';
    end = on ? end.slice(0, 10) : end ? `${end.slice(0, 10)}T10:00` : '';
  }
  const goLabel = $derived(
    emails
      ? isNew
        ? 'Send invites'
        : 'Save and email them'
      : isNew
        ? 'Add to calendar'
        : 'Save the change'
  );

  /** The description grows with what it holds. */
  function grow(el: HTMLTextAreaElement) {
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    el.addEventListener('input', fit);
    return { destroy: () => el.removeEventListener('input', fit) };
  }
  const field = 'min-w-0 flex-1 rounded-lg bg-raise px-2.5 py-1.5 outline-none';
</script>

<ReviewNav label="Event" ask={a} list={events} {staff} {busy} {ongo} {onstaff}>
  {#if reworks}
    <div class="mt-3 rounded-lg bg-sea/10 px-2.5 py-2 text-xs">
      <div class="text-muted">Reworks “{reworks.title}”</div>
      {#if reworks.reason}<div class="mt-0.5">You asked: {reworks.reason}</div>{/if}
    </div>
  {/if}

  <h2 class="mt-2 text-base leading-snug font-medium">{a.title}</h2>

  <div class="mt-3 text-sm">
    <div class="text-xs text-muted">Why</div>
    <div class="mt-0.5"><Markdown text={a.why} staff={a.staffId} /></div>
  </div>

  <div class="mt-3 flex flex-col gap-2 text-sm">
    {#if event.account}
      <div class="flex items-center gap-2">
        <span class="w-16 shrink-0 text-xs text-muted">Account</span>
        <span class="min-w-0 flex-1 truncate px-2.5">{event.account}</span>
      </div>
    {/if}
    <div class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-xs text-muted">Calendar</span>
      <span class="min-w-0 flex-1 truncate px-2.5"
        >{!args.calendar_id || args.calendar_id === 'primary'
          ? 'Primary calendar'
          : text(args.calendar_id)}</span
      >
    </div>
    {#if !isNew}
      <div class="flex items-center gap-2">
        <span class="w-16 shrink-0 text-xs text-muted">Changes</span>
        <span class="min-w-0 flex-1 truncate px-2.5">{event.now || 'An event with no title'}</span>
      </div>
    {/if}
    <label class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-xs text-muted">Title</span>
      <input
        class={field}
        bind:value={summary}
        disabled={busy}
        placeholder={isNew ? '' : 'Unchanged'}
      />
    </label>
    {#if hasTimes}
      <label class="flex items-center gap-2">
        <span class="w-16 shrink-0 text-xs text-muted">Starts</span>
        {#if allDay}
          <input type="date" class={field} bind:value={start} disabled={busy} />
        {:else}
          <input type="datetime-local" class={field} bind:value={start} disabled={busy} />
        {/if}
      </label>
      <label class="flex items-center gap-2">
        <span class="w-16 shrink-0 text-xs text-muted">Ends</span>
        {#if allDay}
          <input type="date" class={field} bind:value={end} disabled={busy} />
        {:else}
          <input type="datetime-local" class={field} bind:value={end} disabled={busy} />
        {/if}
      </label>
      {#if !allDay}
        <label class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-xs text-muted">Time zone</span>
          <input class={field} bind:value={zone} disabled={busy} />
        </label>
      {/if}
      <label class="flex items-center gap-2 ps-[4.5rem] text-xs text-muted">
        <input
          type="checkbox"
          checked={allDay}
          disabled={busy}
          onchange={(e) => setAllDay(e.currentTarget.checked)}
        /> All day
      </label>
      {#if when}
        <p class="ps-[4.5rem] text-xs text-ink">{when}</p>
      {/if}
    {/if}
    <label class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-xs text-muted">Where</span>
      <input
        class={field}
        bind:value={location}
        disabled={busy}
        placeholder={isNew ? 'No place' : 'Unchanged'}
      />
    </label>
    <label class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-xs text-muted">{isNew ? 'Guests' : 'Add guests'}</span>
      <input
        class={field}
        bind:value={guests}
        disabled={busy}
        placeholder="Nobody. Addresses, separated by commas."
      />
    </label>
    <textarea
      aria-label="The description"
      rows="3"
      class="w-full resize-none overflow-hidden rounded-lg bg-raise px-3 py-2 leading-relaxed outline-none placeholder:text-faint"
      placeholder={isNew ? 'No description' : 'Description unchanged'}
      bind:value={description}
      disabled={busy}
      use:grow></textarea>
    <div class="rounded-lg bg-raise px-2.5 py-2 text-xs">
      {#if invited.length}
        <p>Google will email an invite to: {invited.join(', ')}</p>
      {/if}
      {#if told.length}
        <p class={invited.length ? 'mt-1' : ''}>
          Google will email this change to: {told.join(', ')}
        </p>
      {/if}
      {#if !emails}
        <p class="text-muted">Nobody else gets an email. It goes on your calendar only.</p>
      {/if}
    </div>
  </div>

  {#if mode}
    <label class="mt-3 block text-xs text-muted" for="event-note"
      >{mode === 'changes'
        ? `What should ${from} change?`
        : 'Why, if you want to say (optional)'}</label
    >
    <textarea
      id="event-note"
      rows="3"
      class="mt-1 w-full resize-y rounded-lg bg-raise px-3 py-2 text-sm outline-none placeholder:text-faint"
      placeholder={mode === 'changes' ? 'Say what to change.' : `${from} reads it for next time.`}
      bind:value={note}></textarea>
    <div class="mt-2 flex gap-2">
      <button
        class="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink disabled:opacity-40"
        disabled={busy}
        onclick={() => ((mode = undefined), (note = ''))}>Cancel</button
      >
      {#if mode === 'changes'}
        <button
          class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
          disabled={busy || !note.trim()}
          onclick={() => decide('iterate')}>Send back to {from}</button
        >
      {:else}
        <button
          class="flex-1 rounded-lg bg-raise px-3 py-2 text-sm font-medium hover:bg-coral/25 disabled:opacity-40"
          disabled={busy}
          onclick={() => decide('deny')}>Discard it</button
        >
      {/if}
    </div>
  {:else}
    <div class="mt-3 flex gap-2">
      <button
        class="flex-1 rounded-lg bg-sea px-3 py-2 text-sm font-medium text-night disabled:opacity-40"
        disabled={busy || (isNew && (!summary.trim() || !start || !end))}
        onclick={go}>{busy ? 'Working' : goLabel}</button
      >
    </div>
    <div class="mt-2 flex gap-2">
      <button
        class="flex-1 rounded-lg bg-raise px-3 py-1.5 text-xs hover:bg-sea/25 disabled:opacity-40"
        disabled={busy}
        onclick={() => (mode = 'changes')}>Ask for changes</button
      >
      <button
        class="flex-1 rounded-lg bg-raise px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-40"
        disabled={busy}
        onclick={skip}>Skip</button
      >
      <button
        class="flex-1 rounded-lg bg-raise px-3 py-1.5 text-xs hover:bg-coral/25 disabled:opacity-40"
        disabled={busy}
        onclick={() => (mode = 'discard')}>Discard</button
      >
    </div>
    <p class="mt-1.5 text-[11px] text-faint">
      {emails
        ? `Nothing changes and nobody gets an email until you click ${goLabel}.`
        : `Nothing changes in your calendar until you click ${goLabel}.`}
    </p>
  {/if}
  {#if problem}
    <p class="mt-3 rounded-lg bg-coral/15 px-3 py-2 text-xs text-coral">{problem}</p>
  {/if}
</ReviewNav>
