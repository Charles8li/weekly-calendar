declare module 'luxon' {
  export class DateTime {
    static now(): DateTime;
    static local(): DateTime;
    static fromISO(iso: string): DateTime;
    static fromMillis(ms: number): DateTime;
    static fromObject(obj: Record<string, unknown>): DateTime;
    static fromJSDate(date: Date): DateTime;

    readonly isValid: boolean;
    readonly weekday: number;
    readonly hour: number;
    readonly minute: number;
    readonly millisecond: number;

    plus(values: Record<string, number>): DateTime;
    minus(values: Record<string, number>): DateTime;
    diff(other: DateTime, unit?: string | string[]): { minutes: number } & Record<string, number>;
    set(values: Record<string, number>): DateTime;
    startOf(unit: string): DateTime;
    endOf(unit: string): DateTime;
    toISO(): string | null;
    toISODate(): string | null;
    toFormat(fmt: string): string;
    toMillis(): number;
  }
}
