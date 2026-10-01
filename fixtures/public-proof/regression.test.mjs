import test from 'node:test';
import assert from 'node:assert/strict';
import {isEven} from './is-even.mjs';

test('non-integers stay rejected', () => {
  assert.throws(() => isEven(2.5), /integer required/);
});
