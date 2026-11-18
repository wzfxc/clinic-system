/** Same stored format as apps/api auth/password.ts (`salt:key`, base64, scrypt), so seeded demo logins verify. */
import { randomBytes, scrypt } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, key) => {
      if (err) reject(err);
      else resolve(`${salt.toString('base64')}:${key.toString('base64')}`);
    });
  });
}
