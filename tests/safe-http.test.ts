import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { MAX_RESPONSE_BYTES, readResponseBody } from '../packages/domain/src/safe-http';

test('response reader accepts article bodies larger than the previous 1 MiB limit', async () => {
 const body = Buffer.from('<article>'+'a'.repeat(2*1024*1024)+'</article>');
 assert.equal(await readResponseBody(Readable.from([body])),body.toString('utf8'));
});

test('response reader retains only the first 5 MiB of an oversized chunk and stops reading', async () => {
 const body = Buffer.concat([Buffer.alloc(MAX_RESPONSE_BYTES, 'a'),Buffer.from('discarded tail')]);
 const stream = Readable.from([body]);
 const result = await readResponseBody(stream);
 assert.equal(Buffer.byteLength(result),MAX_RESPONSE_BYTES);
 assert.equal(result,'a'.repeat(MAX_RESPONSE_BYTES));
 assert.equal(stream.destroyed,true);
});

test('streamed responses preserve earlier chunks and truncate the crossing chunk at 5 MiB', async () => {
 const stream = new PassThrough();
 const result = readResponseBody(stream);
 stream.write(Buffer.alloc(MAX_RESPONSE_BYTES-3,'a'));
 stream.write(Buffer.from('xyz discarded tail'));
 assert.equal(await result,'a'.repeat(MAX_RESPONSE_BYTES-3)+'xyz');
 assert.equal(stream.destroyed,true);
});

test('response reader resolves and closes at exactly 5 MiB without waiting for the server to end', async () => {
 const stream = new PassThrough();
 const result = readResponseBody(stream);
 stream.write(Buffer.alloc(MAX_RESPONSE_BYTES,'b'));
 assert.equal((await result).length,MAX_RESPONSE_BYTES);
 assert.equal(stream.destroyed,true);
});

test('response reader joins UTF-8 chunks before decoding and preserves pre-cap stream failures', async () => {
 const text = 'ব্র্যান্ডের নতুন খবর';
 const body = Buffer.from(text);
 assert.equal(await readResponseBody(Readable.from([body.subarray(0,2),body.subarray(2)])),text);
 const stream = new PassThrough();
 const result = readResponseBody(stream);
 stream.write(Buffer.from('partial article'));
 stream.destroy(new Error('Connection reset'));
 await assert.rejects(result,/Connection reset/);
});
