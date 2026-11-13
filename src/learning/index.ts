import { reference } from './reference.js';
import { learner } from './exercises.js';
import type { Algorithms, Mode } from '../core/types.js';
export function algorithms(mode: Mode): Algorithms { return mode === 'learner' ? learner : reference; }
