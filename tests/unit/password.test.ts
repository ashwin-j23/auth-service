import { hashPassword, comparePassword } from '../../src/utils/password';

describe('password utils', () => {
  it('hashes a password to something other than the plain text', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toBe('correct horse battery staple');
    expect(hash.length).toBeGreaterThan(20);
  });

  it('produces a different hash each time (random salt)', async () => {
    const hashA = await hashPassword('same-password');
    const hashB = await hashPassword('same-password');
    expect(hashA).not.toBe(hashB);
  });

  it('comparePassword returns true for the matching plain text', async () => {
    const hash = await hashPassword('my-secret-password');
    await expect(comparePassword('my-secret-password', hash)).resolves.toBe(true);
  });

  it('comparePassword returns false for a wrong password', async () => {
    const hash = await hashPassword('my-secret-password');
    await expect(comparePassword('totally-wrong', hash)).resolves.toBe(false);
  });
});
