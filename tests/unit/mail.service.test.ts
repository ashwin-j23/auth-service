// nodemailer must never make a real network call in a unit test —
// `createTestAccount()` (used to mint a throwaway Ethereal account) is
// itself a network call. Mocking the whole module keeps every test in this
// file fully offline.
const createTestAccount = jest.fn();
const sendMailMock = jest.fn();
const createTransport = jest.fn().mockReturnValue({ sendMail: sendMailMock });
const getTestMessageUrl = jest.fn();

jest.mock('nodemailer', () => ({
  createTestAccount,
  createTransport,
  getTestMessageUrl,
}));

describe('mail.service', () => {
  beforeEach(() => {
    // mail.service.ts caches its transporter at module scope (see its
    // comment on `transporterPromise`) — resetting the module registry
    // between tests, and re-requiring it fresh, is what actually exercises
    // "first send mints a transporter" for more than the very first test.
    jest.resetModules();
    createTestAccount.mockReset();
    sendMailMock.mockReset();
    createTransport.mockClear();
    getTestMessageUrl.mockReset();
  });

  it('mints a throwaway Ethereal account on first send and reuses it (cached) on the next', async () => {
    createTestAccount.mockResolvedValue({
      user: 'fresh@ethereal.email',
      pass: 'pw',
      smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
    });
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    getTestMessageUrl.mockReturnValue('https://ethereal.email/message/abc');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mail = require('../../src/services/mail.service');

    const first = await mail.sendMail({ to: 'jane@example.com', subject: 'Hi', text: 't', html: '<p>t</p>' });
    const second = await mail.sendMail({ to: 'jane@example.com', subject: 'Hi again', text: 't', html: '<p>t</p>' });

    expect(first).toBe('https://ethereal.email/message/abc');
    expect(second).toBe('https://ethereal.email/message/abc');
    expect(createTestAccount).toHaveBeenCalledTimes(1); // cached, not re-minted per send
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows a send failure instead of throwing', async () => {
    createTestAccount.mockResolvedValue({
      user: 'fresh@ethereal.email',
      pass: 'pw',
      smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
    });
    sendMailMock.mockRejectedValue(new Error('smtp unavailable'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mail = require('../../src/services/mail.service');

    await expect(
      mail.sendMail({ to: 'jane@example.com', subject: 'Hi', text: 't', html: '<p>t</p>' }),
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('sendVerificationEmail builds a link with the token as a query param', async () => {
    createTestAccount.mockResolvedValue({
      user: 'fresh@ethereal.email',
      pass: 'pw',
      smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
    });
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    getTestMessageUrl.mockReturnValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mail = require('../../src/services/mail.service');

    await mail.sendVerificationEmail('jane@example.com', 'a-raw-token');

    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe('jane@example.com');
    expect(call.text).toContain('token=a-raw-token');
    expect(call.html).toContain('token=a-raw-token');
  });

  it('sendPasswordResetEmail builds a link with the token as a query param', async () => {
    createTestAccount.mockResolvedValue({
      user: 'fresh@ethereal.email',
      pass: 'pw',
      smtp: { host: 'smtp.ethereal.email', port: 587, secure: false },
    });
    sendMailMock.mockResolvedValue({ messageId: 'abc' });
    getTestMessageUrl.mockReturnValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mail = require('../../src/services/mail.service');

    await mail.sendPasswordResetEmail('jane@example.com', 'a-raw-token');

    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe('jane@example.com');
    expect(call.text).toContain('token=a-raw-token');
    expect(call.html).toContain('token=a-raw-token');
  });
});
