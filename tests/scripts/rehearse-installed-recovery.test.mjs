import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectSection8States } from '../../scripts/rehearse-installed-recovery.mjs';

const ids = [
  'S08-L01-suite-ownership',
  'S08-L02-affected-selection',
  'S08-L03-cache-integrity',
  'S08-final',
];

test('selects exactly four private draft Section 8 states in recovery order', () => {
  const states = ids.map((id) => ({ id, status: 'draft', sha256: 'a'.repeat(64) }));
  assert.deepEqual(selectSection8States({ states }).map(({ id }) => id), ids);
  assert.throws(() => selectSection8States({ states: states.slice(0, 3) }), /four/i);
  assert.throws(() => selectSection8States({ states: [...states, states[0]] }), /four/i);
  assert.throws(() => selectSection8States({ states: states.map((state, index) => index === 0 ? { ...state, status: 'published' } : state) }), /draft/i);
});
