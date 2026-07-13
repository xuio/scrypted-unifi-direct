import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aacOnlySerializerParameters } from '../src/controller-emulator';

test('AAC-only serializers never carry an Opus sample-rate hint', () => {
    assert.deepEqual(aacOnlySerializerParameters(), { withOpus: false });
    assert.deepEqual(aacOnlySerializerParameters('stream-token'), {
        streamName: 'stream-token',
        withOpus: false,
    });
    assert.equal('opusSampleRate' in aacOnlySerializerParameters('stream-token'), false);
});
