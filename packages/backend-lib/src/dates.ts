import { add, getUnixTime } from "date-fns";
import { getTimezoneOffset, zonedTimeToUtc } from "date-fns-tz";
import { find as findTz } from "geo-tz";
import { DEFAULT_USER_PROPERTY_DELAY_OFFSET_DIRECTION } from "isomorphic-lib/src/constants";

import logger from "./logger";
import { LocalTimeDelayVariantFields, UserWorkflowTrackEvent } from "./types";
import { getTrackEventsById } from "./userEvents";
import {
  findAllUserPropertyAssignments,
  findAllUserPropertyAssignmentsById,
} from "./userProperties";

const DEFAULT_TIMEZONE = "UTC";
const EVERY_DAY_IN_WEEK = new Set([0, 1, 2, 3, 4, 5, 6]);

/**
 * Derives a timezone from a "lat,lon" string.
 * @returns The IANA timezone, or null if the string can't be parsed.
 */
export function getTimezoneFromLatLon(latLon: string): string | null {
  const splitStr = latLon.split(",");
  const lat = Number(splitStr[0]);
  const lon = Number(splitStr[1]);
  if (
    Number.isNaN(lat) ||
    Number.isNaN(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null;
  }
  return findTz(lat, lon)[0] ?? null;
}

function getTimezone({ latLon }: { latLon: string }): string {
  return getTimezoneFromLatLon(latLon) ?? DEFAULT_TIMEZONE;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    // throws a RangeError for unknown timezones
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a user's timezone from their user property values.
 *
 * Priority: valid timezone user property > latLon-derived timezone > defaultTimezone.
 * Unlike the localized delay, a timezone or latLon value that can't be
 * resolved falls back to the default timezone rather than UTC.
 */
export function resolveUserTimezone({
  userTimezone,
  latLon,
  defaultTimezone,
}: {
  userTimezone?: unknown;
  latLon?: unknown;
  defaultTimezone: string;
}): string {
  if (typeof userTimezone === "string" && isValidTimezone(userTimezone)) {
    return userTimezone;
  }
  if (typeof latLon === "string") {
    const timezone = getTimezoneFromLatLon(latLon);
    if (timezone) {
      return timezone;
    }
  }
  return defaultTimezone;
}

export function findNextLocalizedTimeInner({
  latLon,
  userTimezone,
  defaultTimezone,
  now,
  hour,
  minute = 0,
  allowedDaysOfWeek,
}: LocalTimeDelayVariantFields & {
  latLon?: string;
  userTimezone?: string;
  now: number;
}): number {
  // Priority: user property timezone > latLon-derived timezone > defaultTimezone > UTC
  let timezone: string;
  if (userTimezone) {
    timezone = userTimezone;
  } else if (typeof latLon === "string") {
    timezone = getTimezone({ latLon });
  } else if (defaultTimezone) {
    timezone = defaultTimezone;
  } else {
    timezone = DEFAULT_TIMEZONE;
  }

  const offset = getTimezoneOffset(timezone, now);
  const zoned = offset + now;

  let adjusted = new Date(zoned);
  adjusted.setUTCHours(hour, minute, 0, 0);

  const allowedDays = allowedDaysOfWeek
    ? new Set(allowedDaysOfWeek)
    : EVERY_DAY_IN_WEEK;

  for (let i = 0; i < 8; i++) {
    const local = adjusted.getTime() - offset;
    if (
      adjusted.getTime() > zoned &&
      allowedDays.has(new Date(local).getUTCDay())
    ) {
      return local;
    }
    adjusted = add(adjusted, { days: 1 });
  }

  throw new Error("Could not find next localized time");
}

/**
 * @deprecated Use findNextLocalizedTimeV2 instead. This function hardcodes hour to 5
 * and doesn't support custom minutes or allowedDaysOfWeek parameters.
 * Kept for backwards compatibility with existing temporal workflows.
 */
export async function findNextLocalizedTime({
  workspaceId,
  userId,
  now,
}: {
  workspaceId: string;
  userId: string;
  now: number;
}): Promise<number> {
  const { latLon } = await findAllUserPropertyAssignments({
    workspaceId,
    userId,
    userProperties: ["latLon"],
  });
  return findNextLocalizedTimeInner({
    latLon: typeof latLon === "string" ? latLon : undefined,
    now,
    hour: 5,
  });
}

export async function findNextLocalizedTimeV2({
  workspaceId,
  userId,
  now,
  hour,
  minute,
  allowedDaysOfWeek,
  defaultTimezone,
}: {
  workspaceId: string;
  userId: string;
  now: number;
} & LocalTimeDelayVariantFields): Promise<number> {
  const { latLon, timezone } = await findAllUserPropertyAssignments({
    workspaceId,
    userId,
    userProperties: ["latLon", "timezone"],
  });
  return findNextLocalizedTimeInner({
    latLon: typeof latLon === "string" ? latLon : undefined,
    userTimezone: typeof timezone === "string" ? timezone : undefined,
    defaultTimezone,
    now,
    hour,
    minute,
    allowedDaysOfWeek,
  });
}

export interface BaseGetUserPropertyDelayParams {
  workspaceId: string;
  userId: string;
  userProperty: string;
  now: number;
  offsetSeconds?: number;
  offsetDirection?: "before" | "after";
}

export interface GetUserPropertyDelayParamsV1
  extends BaseGetUserPropertyDelayParams {
  events?: UserWorkflowTrackEvent[];
}

export interface GetUserPropertyDelayParamsV2
  extends BaseGetUserPropertyDelayParams {
  eventIds: string[];
  version: "v2";
}

export type GetUserPropertyDelayParams =
  | GetUserPropertyDelayParamsV1
  | GetUserPropertyDelayParamsV2;

/**
 * Returns the delay in milliseconds to wait for a user property delay.
 * Returns null if the user property is not a date.
 *
 * @param now - The current time in milliseconds since epoch.
 * @param userProperty - The user property to get the delay for. Will try to
 * parse as a date accepting ISO 8601 strings, unix timestamps in seconds, and
 * unix timestamps in milliseconds.
 * @param offsetSeconds - The number of seconds to offset the delay by.
 * @param offsetDirection - The direction to offset the delay.
 */
export async function getUserPropertyDelay({
  workspaceId,
  userId,
  userProperty,
  now,
  offsetSeconds = 0,
  offsetDirection = DEFAULT_USER_PROPERTY_DELAY_OFFSET_DIRECTION,
  ...rest
}: GetUserPropertyDelayParams): Promise<number | null> {
  let events: UserWorkflowTrackEvent[] | undefined;
  if ("version" in rest) {
    events = await getTrackEventsById({
      workspaceId,
      eventIds: rest.eventIds,
    });
  } else {
    events = rest.events;
  }
  const assignments = await findAllUserPropertyAssignmentsById({
    workspaceId,
    userId,
    userPropertyIds: [userProperty],
    context: events?.flatMap((e) => e.properties ?? []),
  });

  const assignment = assignments[userProperty];
  if (!assignment) {
    return null;
  }

  // Try parsing different date formats
  let date: Date | null = null;

  if (typeof assignment === "string") {
    // Try ISO string
    const parsedDate = new Date(assignment);
    if (!Number.isNaN(parsedDate.getTime())) {
      date = parsedDate;
    }
  } else if (typeof assignment === "number") {
    // Try unix timestamp (seconds or milliseconds)
    const timestamp = assignment < 1e12 ? assignment * 1000 : assignment;
    const parsedDate = new Date(timestamp);
    if (!Number.isNaN(parsedDate.getTime())) {
      date = parsedDate;
    }
  }

  if (!date) {
    return null;
  }

  const offsetMs = offsetSeconds * 1000;
  const targetTime =
    offsetDirection === "before"
      ? date.getTime() - offsetMs
      : date.getTime() + offsetMs;

  const delay = targetTime - now;
  return delay > 0 ? delay : null;
}
