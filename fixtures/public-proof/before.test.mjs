import test from 'node:test';
import assert from 'node:assert/strict';
import {isEven} from './is-even.mjs';

test('2 is even', () => {
  assert.equal(isEven(2), true);
});
