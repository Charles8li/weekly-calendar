// src/lib/schedule.ts (add overlap helper)
import { DateTime } from 'luxon';

export const SNAP_MIN = 15; // 分钟
export const MINUTES_PER_DAY = 24 * 60;

export function minutesSinceMidnight(dt: DateTime) {
  return dt.hour * 60 + dt.minute;
}
export function durationMinutes(a: DateTime, b: DateTime) {
  return Math.max(0, Math.round(b.toMillis()/60000 - a.toMillis()/60000));
}
export function snapMinutes(mins: number, step = SNAP_MIN) {
  return Math.max(0, Math.round(mins / step) * step);
}
export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
export function isoForDayAndMinutes(weekStartISO: string, dayIndex: number, minutes: number) {
  const d = DateTime.fromISO(weekStartISO).plus({ days: dayIndex }).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  const mm = clamp(minutes, 0, MINUTES_PER_DAY);
  return d.plus({ minutes: mm }).toISO()!;
}

export function isoForDateAndMinutes(dateISO: string, minutes: number) {
  const d = DateTime.fromISO(dateISO).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  const mm = clamp(minutes, 0, MINUTES_PER_DAY);
  return d.plus({ minutes: mm }).toISO()!;
}

// 判断两个时间段（分钟）是否重叠
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

export function timeStringToMinutes(time: string) {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return clamp(h * 60 + m, 0, MINUTES_PER_DAY);
}

export function minutesToTimeString(mins: number) {
  const mm = Math.round(Math.max(0, mins));
  const h = Math.floor(mm / 60) % 24;
  const m = mm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
