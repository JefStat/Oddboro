// The calendar for one connected Google account. Each reply keeps Google's
// time zones, all-day dates and page tokens so an Odd can read the next page.
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
  return server;
}
