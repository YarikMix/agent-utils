export function double(value: number) { return value * 2; }
export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number) { return value; }
