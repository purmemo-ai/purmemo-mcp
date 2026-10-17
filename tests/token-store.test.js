import { describe, it } from 'node:test';
import assert from 'node:assert';

import TokenStore from '../dist/auth/token-store.js';

describe('TokenStore', () => {
    it('can encrypt and decrypt correctly', () => {
      const store = new TokenStore();
      const data = { user: { id: "test", email: "test@example.com" } };
      const encrypted = store.encrypt(data);
      assert.ok(encrypted.iv);
      assert.ok(encrypted.data);

      const decrypted = store.decrypt(encrypted);
      assert.deepStrictEqual(decrypted.user.id, 'test');
      assert.deepStrictEqual(decrypted.user.email, 'test@example.com');
    });
});
