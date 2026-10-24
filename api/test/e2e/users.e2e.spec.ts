import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import { createTestApp, seedFixtures, resetData, type SeededFixtures } from '../helpers/test-app';

jest.setTimeout(180_000);

/**
 * User administration.
 *
 * The rule under test is the agent/bank pairing. Everything about which text is
 * executed and who countersigns follows from it, and it cannot be a database
 * constraint because a user's roles live in another table.
 */
describe('User administration', () => {
  let app: INestApplication;
  let http: request.SuperTest<request.Test>;
  let knex: Knex;
  let fixtures: SeededFixtures;
  let close: () => Promise<void>;
  let tokens: Record<string, string>;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const unique = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  beforeAll(async () => {
    ({ app, knex, close } = await createTestApp());
    http = request(app.getHttpServer()) as unknown as request.SuperTest<request.Test>;
    fixtures = await seedFixtures(knex);

    tokens = {};
    for (const who of ['admin', 'ops', 'agent', 'employee', 'md']) {
      const res = await http
        .post('/api/v1/auth/login')
        .send({ email: fixtures.users[who].email, password: fixtures.password })
        .expect(200);
      tokens[who] = res.body.accessToken;
    }
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    await resetData(knex);
    // Accounts this file creates are outside the fixture set, so they survive
    // resetData and would otherwise accumulate across runs.
    await knex('users').whereLike('email', '%@usertest.local').del();
  });

  async function makeBank(name = 'Union Bank of India') {
    const res = await http
      .post('/api/v1/banks')
      .set(auth('ops'))
      .send({ code: unique('B').slice(0, 20), name: `${name} ${unique('')}`.slice(0, 190) })
      .expect(201);
    return res.body;
  }

  describe('who may administer users', () => {
    it('lets an agreement administrator look but not change', async () => {
      await http.get('/api/v1/users').set(auth('ops')).expect(200);
      await http
        .post('/api/v1/users')
        .set(auth('ops'))
        .send({
          email: `x@usertest.local`,
          fullName: 'X',
          roles: ['AUDITOR'],
        })
        .expect(403);
    });

    it('refuses an agent entirely', async () => {
      await http.get('/api/v1/users').set(auth('agent')).expect(403);
    });
  });

  describe('the agent/bank pairing (DEC-031)', () => {
    it('creates an agent attached to a bank, and returns a password once', async () => {
      const bank = await makeBank();
      const email = `ramesh@usertest.local`;

      const res = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Ramesh Kumar', roles: ['AGENT'], bankId: bank.id })
        .expect(201);

      expect(res.body.user.bank_id).toBe(bank.id);
      expect(res.body.user.roles).toEqual(['AGENT']);
      expect(res.body.generatedPassword).toMatch(/^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/);
      // Unambiguous characters only, so it survives being read aloud.
      expect(res.body.generatedPassword).not.toMatch(/[O0Il1]/);

      // And it actually works.
      await http
        .post('/api/v1/auth/login')
        .send({ email, password: res.body.generatedPassword })
        .expect(200);
    });

    it('refuses an agent with no bank', async () => {
      const res = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email: `nobank@usertest.local`, fullName: 'No Bank', roles: ['AGENT'] })
        .expect(422);
      expect(res.body.error.message).toMatch(/must belong to a bank/i);
    });

    it('refuses GTIDS staff attached to a bank', async () => {
      const bank = await makeBank();
      /*
       * Not cosmetic: `banks` treats anyone carrying a bank_id as a counterparty,
       * so an employee with one could never be designated as a countersigner and
       * the reason would not be obvious from the screen.
       */
      const res = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({
          email: `staff@usertest.local`,
          fullName: 'Staff',
          roles: ['EMPLOYEE'],
          bankId: bank.id,
        })
        .expect(422);
      expect(res.body.error.message).toMatch(/Only agents belong to a bank/i);
    });

    it('refuses an agent who also holds a GTIDS role', async () => {
      const bank = await makeBank();
      const res = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({
          email: `both@usertest.local`,
          fullName: 'Both Sides',
          roles: ['AGENT', 'EMPLOYEE'],
          bankId: bank.id,
        })
        .expect(422);
      expect(res.body.error.message).toMatch(/same side of the agreement/i);
    });
  });

  describe('updating an existing account', () => {
    it('replaces the role set rather than adding to it', async () => {
      const email = `rolechange@usertest.local`;
      await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Role Change', roles: ['AUDITOR', 'EMPLOYEE'] })
        .expect(201);

      // Roles are the authorisation boundary. One left behind is a permission
      // nobody intended to keep.
      const res = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Role Change', roles: ['AUDITOR'] })
        .expect(201);
      expect(res.body.user.roles).toEqual(['AUDITOR']);
    });

    it('does not reset the password when none is supplied', async () => {
      const email = `keeppw@usertest.local`;
      const created = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Keep Password', roles: ['AUDITOR'] })
        .expect(201);
      const password = created.body.generatedPassword;

      await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Keep Password', roles: ['AUDITOR', 'EMPLOYEE'] })
        .expect(201);

      // Adding a role must not silently lock the person out.
      await http.post('/api/v1/auth/login').send({ email, password }).expect(200);
    });
  });

  describe('deactivation', () => {
    it('refuses to deactivate a bank\'s designated countersigner', async () => {
      const bank = await makeBank();
      await http
        .patch(`/api/v1/banks/${bank.id}`)
        .set(auth('ops'))
        .send({ employeeSignerUserId: fixtures.users.employee.id })
        .expect(200);

      /*
       * Otherwise every agreement at that bank fails at creation, reporting a
       * missing designation rather than the deactivation that caused it.
       */
      const res = await http
        .post(`/api/v1/users/${fixtures.users.employee.id}/active`)
        .set(auth('admin'))
        .send({ isActive: false })
        .expect(409);
      expect(res.body.error.message).toMatch(/designated countersigner/i);
    });

    it('refuses to deactivate your own account', async () => {
      const res = await http
        .post(`/api/v1/users/${fixtures.users.admin.id}/active`)
        .set(auth('admin'))
        .send({ isActive: false })
        .expect(403);
      expect(res.body.error.message).toMatch(/your own account/i);
    });

    it('clears a lockout on reactivation', async () => {
      const email = `locked@usertest.local`;
      const created = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Locked Out', roles: ['AUDITOR'] })
        .expect(201);
      const id = created.body.user.id;

      await knex('users')
        .where('id', id)
        .update({ locked_until: new Date(Date.now() + 3_600_000), failed_login_count: 9 });

      await http
        .post(`/api/v1/users/${id}/active`)
        .set(auth('admin'))
        .send({ isActive: false })
        .expect(201);
      await http
        .post(`/api/v1/users/${id}/active`)
        .set(auth('admin'))
        .send({ isActive: true })
        .expect(201);

      // A reactivated account that is still locked out would be refused with
      // nothing on screen explaining why.
      const row = await knex('users').where('id', id).first();
      expect(row.locked_until).toBeNull();
      await http
        .post('/api/v1/auth/login')
        .send({ email, password: created.body.generatedPassword })
        .expect(200);
    });
  });

  describe('password reset', () => {
    it('issues a working password and clears any lockout', async () => {
      const email = `resetme@usertest.local`;
      const created = await http
        .post('/api/v1/users')
        .set(auth('admin'))
        .send({ email, fullName: 'Reset Me', roles: ['AUDITOR'] })
        .expect(201);
      const id = created.body.user.id;

      await knex('users')
        .where('id', id)
        .update({ locked_until: new Date(Date.now() + 3_600_000) });

      const reset = await http
        .post(`/api/v1/users/${id}/reset-password`)
        .set(auth('admin'))
        .expect(201);

      expect(reset.body.password).not.toBe(created.body.generatedPassword);
      await http
        .post('/api/v1/auth/login')
        .send({ email, password: reset.body.password })
        .expect(200);
    });
  });
});
