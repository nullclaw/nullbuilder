import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readArray, readBoundedArray, readObjectRecord } from './record-safety';

test('readObjectRecord accepts plain data records only', () => {
  const object = { name: 'nullbuilder' };
  const nullPrototypeObject = Object.create(null) as Record<string, unknown>;
  nullPrototypeObject.name = 'nullbuilder';

  assert.equal(readObjectRecord(object), object);
  assert.equal(readObjectRecord(nullPrototypeObject), nullPrototypeObject);

  class CustomRecord {
    name = 'nullbuilder';
  }
  const inherited = Object.create({ name: 'inherited' });

  for (const value of [
    null,
    undefined,
    'object',
    42,
    true,
    [],
    ['name'],
    new Date(),
    new Map(),
    new CustomRecord(),
    inherited
  ]) {
    assert.equal(readObjectRecord(value), null);
  }
});

test('readArray accepts arrays only', () => {
  const array = ['nullbuilder'];

  assert.equal(readArray(array), array);

  for (const value of [null, undefined, 'array', 42, true, { 0: 'value', length: 1 }]) {
    assert.deepEqual(readArray(value), []);
  }
});

test('readBoundedArray returns a safe prefix only', () => {
  const values = ['a', 'b', 'c'];

  assert.deepEqual(readBoundedArray(values, 2), ['a', 'b']);
  assert.deepEqual(readBoundedArray(values, values.length), values);
  assert.deepEqual(readBoundedArray(values, 0), []);
  assert.deepEqual(readBoundedArray(values, -1), []);
  assert.deepEqual(readBoundedArray(values, 1.5), []);
  assert.deepEqual(readBoundedArray(values, Number.MAX_SAFE_INTEGER + 1), []);
  assert.deepEqual(readBoundedArray('not-array', 2), []);
});

test('readBoundedArray does not read past the configured prefix', () => {
  const values = ['a', 'b', 'c'];
  Object.defineProperty(values, 2, {
    get() {
      throw new Error('read past bounded prefix');
    }
  });

  assert.deepEqual(readBoundedArray(values, 2), ['a', 'b']);
});

test('readBoundedArray does not call user-controlled array methods', () => {
  class CustomArray<T> extends Array<T> {
    override slice(): T[] {
      throw new Error('slice should not be called');
    }
  }
  const values = new CustomArray('a', 'b', 'c');

  assert.deepEqual(readBoundedArray(values, 2), ['a', 'b']);
});
