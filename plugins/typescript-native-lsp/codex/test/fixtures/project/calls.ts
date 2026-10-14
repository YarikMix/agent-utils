export function leaf(value: number) { return value + 1; }
export function branch(value: number) { return leaf(value); }
export function entry() { return branch(3); }
