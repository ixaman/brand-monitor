import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManage } from '../apps/web/lib/access';
test('viewer is read-only; admin and analyst can manage', () => {
 assert.equal(canManage('viewer'), false);
 assert.equal(canManage('analyst'), true);
 assert.equal(canManage('admin'), true);
});
