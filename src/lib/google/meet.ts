import { createHash, randomUUID } from "crypto";
import { google, type calendar_v3 } from "googleapis";

const REDIRECT_URI = "http://localhost:3333/oauth2callback";
const CALENDAR_ID = "primary";
const TIME_ZONE = "Asia/Tokyo";

export class GoogleMeetConfigError extends Error {
  missing: string[];

  constructor(missing: string[]) {
    super(`Google Meet credentials are not configured: ${missing.join(", ")}`);
    this.name = "GoogleMeetConfigError";
    this.missing = missing;
  }
}

export class GoogleMeetOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMeetOperationError";
  }
}

/**
 * The stored Calendar event was deleted on the Google side. Calendar answers a
 * patch of a deleted event with 200 + status "cancelled" (not 404/410), so the
 * same event can never be revived by retrying. Only thrown when a replacement
 * could not be created automatically; the message points the user to 再発行.
 */
export class GoogleMeetEventCancelledError extends GoogleMeetOperationError {
  constructor() {
    super("Google カレンダーの予定が削除されています。「再発行」で新しいMeetを発行してください。");
    this.name = "GoogleMeetEventCancelledError";
  }
}

export type MeetEventInput = {
  /** Stable per tenant/deal; retrying an ambiguous insert must reuse the event ID. */
  operationKey: string;
  eventId?: string | null;
  summary: string;
  description?: string | null;
  startAt: Date;
  endAt: Date;
  forceRecreate?: boolean;
};

export type MeetEventResult = {
  status: "ready" | "pending" | "failed";
  meetUrl: string | null;
  eventId: string;
};

function readMeetEnv(requireRefreshToken: boolean) {
  const config = {
    clientId: process.env.GOOGLE_MEET_CLIENT_ID?.trim(),
    clientSecret: process.env.GOOGLE_MEET_CLIENT_SECRET?.trim(),
    refreshToken: process.env.GOOGLE_MEET_REFRESH_TOKEN?.trim(),
  };
  const missing = [
    !config.clientId ? "GOOGLE_MEET_CLIENT_ID" : null,
    !config.clientSecret ? "GOOGLE_MEET_CLIENT_SECRET" : null,
    requireRefreshToken && !config.refreshToken ? "GOOGLE_MEET_REFRESH_TOKEN" : null,
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) throw new GoogleMeetConfigError(missing);
  return config as {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export function getGoogleMeetConfigStatus() {
  const missing = [
    !process.env.GOOGLE_MEET_CLIENT_ID?.trim() ? "GOOGLE_MEET_CLIENT_ID" : null,
    !process.env.GOOGLE_MEET_CLIENT_SECRET?.trim() ? "GOOGLE_MEET_CLIENT_SECRET" : null,
    !process.env.GOOGLE_MEET_REFRESH_TOKEN?.trim() ? "GOOGLE_MEET_REFRESH_TOKEN" : null,
  ].filter((v): v is string => Boolean(v));

  return {
    configured: missing.length === 0,
    missing,
  };
}

export function createMeetOAuthClient(requireRefreshToken = true) {
  const config = readMeetEnv(requireRefreshToken);
  const oauth2Client = new google.auth.OAuth2(config.clientId, config.clientSecret, REDIRECT_URI);
  if (requireRefreshToken) {
    oauth2Client.setCredentials({ refresh_token: config.refreshToken });
  }
  return oauth2Client;
}

export async function upsertMeetEvent(input: MeetEventInput): Promise<MeetEventResult> {
  if (!input.operationKey || !Number.isFinite(input.startAt.getTime()) || !Number.isFinite(input.endAt.getTime())
    || input.endAt.getTime() <= input.startAt.getTime()) {
    throw new GoogleMeetOperationError("meetingEndAt must be after meetingStartAt");
  }

  const auth = createMeetOAuthClient(true);
  const calendar = google.calendar({ version: "v3", auth });
  const requestBody = buildEventRequest(input);

  async function update(eventId: string) {
    const updated = await calendar.events.patch({
      calendarId: CALENDAR_ID, eventId, conferenceDataVersion: 1, requestBody,
    });
    const event = updated.data;
    // A deleted event cannot be reused; the caller decides whether to replace it.
    if (event.status === "cancelled") throw new GoogleMeetEventCancelledError();
    // A failed/missing conference can be retried on the existing Calendar event.
    // Never replace a pending request or an existing working Meet URL.
    if (!readMeetUrl(event)
      && event.conferenceData?.createRequest?.status?.statusCode !== "pending") {
      const retried = await calendar.events.patch({
        calendarId: CALENDAR_ID, eventId, conferenceDataVersion: 1,
        requestBody: { conferenceData: conferenceRequest() },
      });
      return resultFromEvent(retried.data);
    }
    return resultFromEvent(event);
  }

  if (input.eventId && !input.forceRecreate) {
    try {
      return await update(input.eventId);
    } catch (error) {
      // Deleted on Google's side (404/410, or 200 with status "cancelled"):
      // create a replacement exactly like a missing event. Nobody is invited.
      if (!(error instanceof GoogleMeetEventCancelledError) && ![404, 410].includes(statusCode(error))) throw error;
    }
  }

  // Hex characters satisfy Calendar's base32hex event-ID constraint.
  const eventId = "luma" + createHash("sha256")
    .update(JSON.stringify([input.operationKey, input.eventId ?? "initial", Boolean(input.forceRecreate)]))
    .digest("hex");
  try {
    const created = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      conferenceDataVersion: 1,
      requestBody: {
        ...requestBody, id: eventId,
        conferenceData: conferenceRequest(),
      },
    });
    return resultFromEvent(created.data);
  } catch (error) {
    // The previous insert may have succeeded even when its response was lost.
    if (statusCode(error) !== 409) throw error;
    return update(eventId);
  }
}

function conferenceRequest(): calendar_v3.Schema$ConferenceData {
  return { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
}

function buildEventRequest(input: MeetEventInput): calendar_v3.Schema$Event {
  return {
    summary: input.summary,
    description: input.description ?? undefined,
    start: { dateTime: input.startAt.toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: input.endAt.toISOString(), timeZone: TIME_ZONE },
  };
}

function resultFromEvent(event: calendar_v3.Schema$Event): MeetEventResult {
  const eventId = event.id;
  if (event.status === "cancelled") throw new GoogleMeetEventCancelledError();
  if (!eventId) throw new GoogleMeetOperationError("Google カレンダーの予定を確認できませんでした。再試行してください。");
  const meetUrl = readMeetUrl(event);
  if (event.conferenceData?.createRequest?.status?.statusCode === "failure") return { eventId, meetUrl: null, status: "failed" };
  if (event.conferenceData?.createRequest?.status?.statusCode === "pending") return { eventId, meetUrl: null, status: "pending" };
  if (meetUrl) return { eventId, meetUrl, status: "ready" };
  return { eventId, meetUrl: null, status: "failed" };
}

function readMeetUrl(event: calendar_v3.Schema$Event): string | null {
  const candidate = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "meet.google.com" && !url.username && !url.password
      && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname) ? url.toString() : null;
  } catch { return null; }
}

function statusCode(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const value = error as { code?: unknown; response?: { status?: unknown } };
  return Number(value.response?.status ?? value.code) || 0;
}
