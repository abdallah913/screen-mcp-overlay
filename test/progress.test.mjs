import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgress } from '../dist-test/progress.js';

test('an n/N prefix is progress, and the rest is the prompt', () => {
    assert.deepEqual(parseProgress('2/5 Click Export'), { n: 2, of: 5, rest: 'Click Export' });
    assert.deepEqual(parseProgress(' 10 / 12  Pick PNG'), { n: 10, of: 12, rest: 'Pick PNG' });
});

test('things that only look like progress are not', () => {
    assert.equal(parseProgress('Click Export'), null);
    assert.equal(parseProgress('1/2'), null, 'no prompt after it');
    assert.equal(parseProgress('6/5 Over'), null, 'n beyond N');
    assert.equal(parseProgress('0/3 Zero'), null);
    assert.equal(parseProgress('2/5ths of the way'), null, 'needs a space');
    assert.equal(parseProgress('Set 1/2 cup'), null, 'only as a prefix');
});
