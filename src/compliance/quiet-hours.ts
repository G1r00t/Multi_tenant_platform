const QUIET_START = 20;
const QUIET_END = 8;
const TIMEZONE = 'Asia/Kolkata';

export function getLocalHour(date: Date, timeZone = TIMEZONE): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  return parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
}

export function isQuietHours(date: Date = new Date(), timeZone = TIMEZONE): boolean {
  const hour = getLocalHour(date, timeZone);
  return hour >= QUIET_START || hour < QUIET_END;
}

export function assertAgentMessageAllowed(sender: string, at: Date = new Date()): void {
  if (sender === 'agent' && isQuietHours(at)) {
    throw new QuietHoursViolationError();
  }
}

export class QuietHoursViolationError extends Error {
  readonly code = 'quiet_hours_violation';

  constructor() {
    super('Outbound agent messages are blocked during quiet hours (8 PM–8 AM IST)');
    this.name = 'QuietHoursViolationError';
  }
}
