import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readObjectRecord } from './record-safety';

test('readObjectRecord accepts non-array objects only', () => {
  const object = { name: 'nullbuilder' };

  assert.equal(readObjectRecord(object), object);
  assert.equal(readObjectRecord(Object.create(null)) !== null, true);

  for (const value of [null, undefined, 'object', 42, true, [], ['name']]) {
    assert.equal(readObjectRecord(value), null);
  }
});
