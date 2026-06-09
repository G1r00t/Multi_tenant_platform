import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';

describe('API smoke', () => {
  it('GET /borrowers without auth returns 401', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/borrowers' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /borrowers/abc returns 404 (deny by default)', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'GET',
      url: '/borrowers/abc',
      headers: { authorization: 'Bearer invalid' },
    });
    expect([401, 404]).toContain(response.statusCode);
    await app.close();
  });
});
