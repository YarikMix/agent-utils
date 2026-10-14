export interface Greeter { greet(): string; }
export class Friendly implements Greeter { greet() { return "hello"; } }
