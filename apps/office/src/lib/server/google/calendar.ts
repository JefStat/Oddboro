// The calendar for one connected Google account. Each reply keeps Google's
// time zones, all-day dates and page tokens so an Odd can read the next page.
// With write, an Odd creates and changes events (`create_event`,
// `update_event`, Google's own names). There is no tool to delete an event or
// a calendar. Google emails everyone on an event it creates or changes, so a
// call that would email anyone besides the owner goes only on the owner's
// click on their desk (`OWNER_META`): the gateway holds it at any level
// (`eventHold`), and the tool refuses it from a run.
import type { HeldEvent } from '@oddboro/ledger';
import { z } from 'zod';
import { accountServer, DATA_NOTE, google, id, run, send, untrusted, type Token } from './http.ts';

const API = 'https://www.googleapis.com/calendar/v3';
const read = { readOnlyHint: true };
const calendar = z
  .string()
  .min(1)
  .refine((v) => v !== '.' && v !== '..', 'Use a Google calendar ID.');
const when = z.string().datetime({ offset: true }).describe('A date and time with its UTC offset.');
const period = { time_min: when, time_max: when };
const page = {
  page_token: z.string().optional().describe('nextPageToken from the previous page.')
};
const events = (calendarId: string) => `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
const eventFields =
  'id,etag,status,htmlLink,summary,description,location,start,end,recurringEventId,originalStartTime,attendeesOmitted,organizer,attendees(email,self,responseStatus)';

function checkPeriod(start: string, end: string) {
  if (Date.parse(end) <= Date.parse(start)) throw new Error('The end must be after the start.');
}

export function calendarServer(token: Token, account?: string) {
  const server = accountServer('google-calendar', account, 'the Google Calendar account');
  const result = (data: unknown) => untrusted('calendar', JSON.stringify(data));

  server.registerTool(
    'list_calendars',
    {
      description: `List this account's calendars, their IDs, time zones and access levels. Follow nextPageToken for more. ${DATA_NOTE}`,
      inputSchema: page,
      annotations: read
    },
    run(async ({ page_token }) => {
      const params = new URLSearchParams({
        fields: 'nextPageToken,items(id,summary,summaryOverride,primary,timeZone,accessRole)',
        maxResults: '100'
      });
      if (page_token) params.set('pageToken', page_token);
      return result(await google(token, `${API}/users/me/calendarList?${params}`));
    })
  );

  server.registerTool(
    'list_events',
    {
      description: `Read events overlapping a time range on one calendar. Recurring events appear as individual occurrences. Follow nextPageToken for more. ${DATA_NOTE}`,
      inputSchema: { calendar_id: calendar, ...period, ...page },
      annotations: read
    },
    run(async ({ calendar_id, time_min, time_max, page_token }) => {
      checkPeriod(time_min, time_max);
      const params = new URLSearchParams({
        timeMin: time_min,
        timeMax: time_max,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        fields:
          'nextPageToken,timeZone,items(id,etag,status,summary,start,end,originalStartTime,recurringEventId,htmlLink)'
      });
      if (page_token) params.set('pageToken', page_token);
      return result(await google(token, `${events(calendar_id)}?${params}`));
    })
  );

  server.registerTool(
    'get_event',
    {
      description: `Read one event and the invitation responses on its calendar. Use the event ID from list_events. ${DATA_NOTE}`,
      inputSchema: { calendar_id: calendar, event_id: id },
      annotations: read
    },
    run(async ({ calendar_id, event_id }) =>
      result(
        await google(
          token,
          `${events(calendar_id)}/${event_id}?${new URLSearchParams({ fields: eventFields })}`
        )
      )
    )
  );

  server.registerTool(
    'check_availability',
    {
      description: `Read busy intervals for up to 50 calendar IDs. If Google returns an error for a calendar, its availability is unknown. ${DATA_NOTE}`,
      inputSchema: { calendar_ids: z.array(calendar).min(1).max(50), ...period },
      annotations: read
    },
    run(async ({ calendar_ids, time_min, time_max }) => {
      checkPeriod(time_min, time_max);
      return result(
        await google(
          token,
          `${API}/freeBusy`,
          send('POST', {
            timeMin: time_min,
            timeMax: time_max,
            items: calendar_ids.map((id) => ({ id }))
          })
        )
      );
    })
  );
  const write = { readOnlyHint: false, destructiveHint: false };

  server.registerTool(
    'create_event',
    {
      description: `Create an event on one of this account's calendars. Google emails an invite to everyone in attendees, so an event with anyone besides the owner waits on the owner's desk until they click, whatever your level: say so in your reply. Without attendees it follows your level. The office ends the description with a line "${EVENT_FOOTER}", which the owner may delete: never write it yourself.`,
      inputSchema: createInput,
      annotations: write
    },
    run(async (args: CreateArgs, _odd, ownerSaidYes) => {
      const emailed = others(
        (args.attendees ?? []).map((email) => ({ email })),
        account
      );
      if (emailed.length && !ownerSaidYes) throw new Error(waits(emailed));
      const body = {
        summary: args.summary,
        ...times(args),
        ...(args.location ? { location: args.location } : {}),
        // The line goes in where the text is first written; on the owner's
        // click the description is theirs, so a line they removed stays out.
        ...(ownerSaidYes
          ? args.description
            ? { description: args.description }
            : {}
          : { description: withEventFooter(args.description) }),
        ...(args.attendees?.length
          ? { attendees: unique(args.attendees).map((email) => ({ email })) }
          : {})
      };
      const made = await google<{ id: string }>(
        token,
        `${events(args.calendar_id ?? 'primary')}?${sendUpdates(ownerSaidYes)}`,
        send('POST', body)
      );
      return `Event ${made.id} is on the calendar. ${told(emailed, 'an invite')}`;
    })
  );

  server.registerTool(
    'update_event',
    {
      description: `Change one event: only the fields you give change. Google emails everyone on the event about a change, so a change to an event with anyone besides the owner on it, or one that adds someone, waits on the owner's desk until they click, whatever your level: say so in your reply. Use the event ID from list_events.`,
      inputSchema: updateInput,
      annotations: write
    },
    run(async (args: UpdateArgs, _odd, ownerSaidYes) => {
      const plan = await planChange(token, account, args);
      if (plan.emailed.length && !ownerSaidYes) throw new Error(waits(plan.emailed));
      const patch: Record<string, unknown> = {};
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.location !== undefined) patch.location = args.location;
      if (args.description !== undefined) patch.description = args.description;
      if (args.start_time !== undefined || args.end_time !== undefined) {
        if (!args.start_time || !args.end_time)
          throw new Error('Give start_time and end_time together.');
        Object.assign(
          patch,
          times({ ...args, start_time: args.start_time, end_time: args.end_time })
        );
      } else if (args.all_day !== undefined || args.time_zone !== undefined)
        throw new Error('all_day and time_zone go with start_time and end_time.');
      if (plan.attendees) patch.attendees = plan.attendees;
      if (!Object.keys(patch).length) throw new Error('Say what to change.');
      const made = await google<{ id: string }>(
        token,
        `${events(args.calendar_id ?? 'primary')}/${args.event_id}?${sendUpdates(ownerSaidYes)}`,
        send('PATCH', patch)
      );
      return `Event ${made.id} is changed. ${told(plan.emailed, 'the change')}`;
    })
  );
  return server;
}

/** The last line of an event the office creates. The owner may delete it, and it stays deleted. */
export const EVENT_FOOTER = 'Added by Oddboro: https://oddboro.com';

/** The description with a blank line and the footer after it, unless a line already says it. */
export function withEventFooter(description: string | undefined): string {
  const text = (description ?? '').trimEnd();
  if (text.split('\n').some((line) => /^added by oddboro\b/i.test(line.trim()))) return text;
  return text ? `${text}\n\n${EVENT_FOOTER}` : EVENT_FOOTER;
}

/** The tools that can make Google email someone. */
export const EVENT_TOOLS: readonly string[] = ['create_event', 'update_event'];

const email = z.email().max(320);
const zone = z
  .string()
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone, like America/Los_Angeles.')
  .describe('An IANA time zone, like America/Los_Angeles. The times are in it.');
const moment = z.string().min(10).max(40);
const eventInput = {
  calendar_id: calendar
    .optional()
    .describe('The calendar, from list_calendars. Leave out for the primary calendar.'),
  summary: z.string().trim().min(1).max(1024).describe("The event's title."),
  start_time: moment.describe(
    'When it starts: 2026-11-20T10:00:00 with time_zone, or with its UTC offset, like 2026-11-20T10:00:00-08:00. For an all-day event, the first day: 2026-11-20.'
  ),
  end_time: moment.describe(
    'When it ends, after the start. For an all-day event, the day after the last day: 2026-11-21 for one day.'
  ),
  all_day: z.boolean().optional().describe('An all-day event: the times are dates.'),
  time_zone: zone.optional(),
  location: z.string().max(1024).optional(),
  description: z.string().max(8000).optional().describe('Plain text.')
};
const createInput = {
  ...eventInput,
  attendees: z
    .array(email)
    .max(50)
    .optional()
    .describe('Email addresses to invite. Google emails each one an invite.')
};
const updateInput = {
  event_id: id.describe('The event ID, from list_events.'),
  ...eventInput,
  summary: eventInput.summary.optional(),
  start_time: eventInput.start_time.optional(),
  end_time: eventInput.end_time.optional(),
  added_attendees: z
    .array(email)
    .max(50)
    .optional()
    .describe('Email addresses to add. Google emails each one an invite.'),
  removed_attendee_emails: z
    .array(email)
    .max(50)
    .optional()
    .describe('Email addresses to take off. Google emails each one that it is cancelled.')
};
const CreateArgs = z.object(createInput);
const UpdateArgs = z.object(updateInput);
type CreateArgs = z.infer<typeof CreateArgs>;
type UpdateArgs = z.infer<typeof UpdateArgs>;

/** What the owner may change on the desk, per tool. The rest stays as the Odd called it. */
const EDITABLE: Record<string, readonly string[]> = {
  create_event: [
    'summary',
    'start_time',
    'end_time',
    'all_day',
    'time_zone',
    'location',
    'description',
    'attendees'
  ],
  update_event: [
    'summary',
    'start_time',
    'end_time',
    'all_day',
    'time_zone',
    'location',
    'description',
    'added_attendees'
  ]
};

/**
 * A held event call as the owner left it on the desk: their values for the
 * fields they may change, and the rest (which calendar, which event) as the
 * Odd called it. A field they emptied goes; the tool checks the rest.
 */
export function ownerEdit(
  tool: string,
  held: Record<string, unknown>,
  edited: Record<string, unknown>
): Record<string, unknown> {
  const fields = EDITABLE[tool];
  if (!fields) throw new Error('Only a calendar event takes changes on the desk.');
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(held).filter(([k]) => !fields.includes(k))
  );
  for (const k of fields) {
    const v = edited[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

type Attendee = { email?: string; self?: boolean; resource?: boolean };

const unique = (list: string[]) => [
  ...new Map(list.map((e) => [e.trim().toLowerCase(), e.trim()])).values()
];

/** The addresses on an event Google emails: everyone but the owner's own account and rooms. */
function others(list: Attendee[] | undefined, account: string | undefined): string[] {
  const own = account?.toLowerCase();
  return unique(
    (list ?? [])
      .filter((a) => a.email && !a.self && !a.resource && a.email.toLowerCase() !== own)
      .map((a) => a.email!)
  );
}

const sendUpdates = (ownerSaidYes: boolean | undefined) =>
  `sendUpdates=${ownerSaidYes ? 'all' : 'none'}`;

const waits = (emailed: string[]) =>
  `Google would email ${emailed.join(', ')}, and that goes only when the owner clicks it on their desk. Call it again with oddboro_title and oddboro_why, and the office puts it there.`;

const told = (emailed: string[], what: string) =>
  emailed.length ? `Google emailed ${what} to ${emailed.join(', ')}.` : 'Nobody was emailed.';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** One end of an event as Google takes it: a date, or a time with its zone or offset. */
function slot(v: string, allDay: boolean | undefined, tz: string | undefined) {
  if (allDay) {
    const day = v.slice(0, 10);
    if (!DATE.test(day) || Number.isNaN(Date.parse(day)))
      throw new Error('An all-day event takes dates, like 2026-11-20.');
    return { date: day };
  }
  if (!DATE_TIME.test(v) || Number.isNaN(Date.parse(OFFSET.test(v) ? v : `${v}Z`)))
    throw new Error(`"${v}" is not a time like 2026-11-20T10:00:00.`);
  if (!tz && !OFFSET.test(v))
    throw new Error(
      'Give time_zone, or the UTC offset on the time, like 2026-11-20T10:00:00-08:00.'
    );
  return { dateTime: v, ...(tz ? { timeZone: tz } : {}) };
}

/** Both ends of an event, the end after the start. */
function times(a: { start_time: string; end_time: string; all_day?: boolean; time_zone?: string }) {
  const start = slot(a.start_time, a.all_day, a.time_zone);
  const end = slot(a.end_time, a.all_day, a.time_zone);
  const at = (s: { date?: string; dateTime?: string }) =>
    Date.parse(s.date ?? (OFFSET.test(s.dateTime!) ? s.dateTime! : `${s.dateTime}Z`));
  if (at(end) <= at(start)) throw new Error('The end must be after the start.');
  return { start, end };
}

/**
 * What a change does to the people on an event, read from Google now: who
 * Google emails (everyone on it besides the owner, and anyone added), and the
 * attendee list to send when the change adds or takes off someone.
 */
async function planChange(
  token: Token,
  account: string | undefined,
  args: UpdateArgs
): Promise<{ emailed: string[]; others: string[]; now?: string; attendees?: Attendee[] }> {
  const event = await google<{ summary?: string; attendees?: Attendee[] }>(
    token,
    `${events(args.calendar_id ?? 'primary')}/${args.event_id}?fields=summary,attendees`
  );
  const on = others(event.attendees, account);
  const added = others(
    (args.added_attendees ?? []).map((email) => ({ email })),
    account
  );
  const gone = new Set((args.removed_attendee_emails ?? []).map((e) => e.toLowerCase()));
  const attendees =
    args.added_attendees?.length || gone.size
      ? [
          ...(event.attendees ?? []).filter((a) => !gone.has(a.email?.toLowerCase() ?? '')),
          ...unique(args.added_attendees ?? [])
            .filter(
              (e) =>
                !(event.attendees ?? []).some((a) => a.email?.toLowerCase() === e.toLowerCase())
            )
            .map((email) => ({ email }))
        ]
      : undefined;
  return { emailed: unique([...on, ...added]), others: on, now: event.summary, attendees };
}

/** A held event call, ready for the desk. */
export type EventHold = {
  /** Who Google emails if the owner clicks it: anyone at all means it waits for them. */
  emailed: string[];
  /** The call's inputs as the desk shows them: a new event's description ends with the footer. */
  args: Record<string, unknown>;
  /** What it does, from the call alone, for the ask's title. */
  said: string;
  event: HeldEvent;
};

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s);
const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

/**
 * A call to `create_event` or `update_event` as the gateway weighs it: who
 * Google would email, which makes it wait for the owner's click at any
 * level, and what the desk shows. Undefined for any other call, or one
 * whose inputs the tool would refuse anyway.
 */
export async function eventHold(
  token: Token,
  account: string | undefined,
  tool: string,
  given: Record<string, unknown>
): Promise<EventHold | undefined> {
  if (tool === 'create_event') {
    const a = CreateArgs.safeParse(given);
    if (!a.success) return undefined;
    const emailed = others(
      (a.data.attendees ?? []).map((email) => ({ email })),
      account
    );
    return {
      emailed,
      // The footer goes in now, where the owner sees it and may delete it.
      args: { ...given, description: withEventFooter(a.data.description) },
      said: emailed.length
        ? `Invite ${people(emailed.length)} to "${short(a.data.summary)}"`
        : `Add "${short(a.data.summary)}" to the calendar`,
      event: { account, others: [] }
    };
  }
  if (tool === 'update_event') {
    const a = UpdateArgs.safeParse(given);
    if (!a.success) return undefined;
    const plan = await planChange(token, account, a.data);
    const what = a.data.summary ? `"${short(a.data.summary)}"` : 'an event';
    return {
      emailed: plan.emailed,
      args: given,
      said: plan.emailed.length
        ? `Change ${what} and email ${people(plan.emailed.length)}`
        : `Change ${what}`,
      event: { account, now: plan.now, others: plan.others }
    };
  }
  return undefined;
}
