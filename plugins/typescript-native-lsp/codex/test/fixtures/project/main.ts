import { double } from './barrel.js';
import { overloaded } from './lib.js';
export const result = double(3);
export const result2 = overloaded(3);
export const broken: number = 'wrong';
