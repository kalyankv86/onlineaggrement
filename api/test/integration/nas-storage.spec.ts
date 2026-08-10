import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FilesystemStorageDriver, objectKey } from '../../src/documents/storage/storage.driver';
import { sha256 } from '../../src/common/util/crypto.util';

jest.setTimeout(60_000);

/**
 * The production storage path: a NAS export mounted on the application server.
 *
 * These tests target the failure modes specific to network storage rather than
 * the happy path — an unmounted share, a partially written file, a concurrent
 * write, a full volume. Those are the ways a legal document store loses evidence.
 */
const makeDriver = (root: string, env: 'development' | 'production') =>
  new FilesystemStorageDriver({
    get: (key: string) =>
      ({
        'storage.fsRoot': root,
        'storage.signedUrlTtlSeconds': 300,
        'auth.jwtSecret': 'test-secret',
        apiBaseUrl: 'http://localhost:3100',
        env,
      })[key],
  } as unknown as ConfigService);

describe('NAS-backed storage', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtids-nas-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('the unmounted-share guard', () => {
    it('refuses to start in production when the NAS marker is absent', async () => {
      // The export is not mounted: the mountpoint is an empty local directory.
      const driver = makeDriver(root, 'production');
      await expect(driver.onModuleInit()).rejects.toThrow(/marker file/);
    });

    it('starts once the marker is present', async () => {
      await fs.writeFile(path.join(root, '.gtids-storage-root'), '');
      const driver = makeDriver(root, 'production');
      await expect(driver.onModuleInit()).resolves.toBeUndefined();
      expect((await driver.health()).ok).toBe(true);
    });

    it('reports unhealthy if the share disappears while running', async () => {
      await fs.writeFile(path.join(root, '.gtids-storage-root'), '');
      const driver = makeDriver(root, 'production');
      await driver.onModuleInit();
      expect((await driver.health()).ok).toBe(true);

      // The NAS goes away mid-flight.
      await fs.unlink(path.join(root, '.gtids-storage-root'));

      const health = await driver.health();
      expect(health.ok).toBe(false);
      expect(health.detail).toMatch(/not mounted/);
    });

    it('refuses to write to an unmounted share rather than writing to local disk', async () => {
      const driver = makeDriver(root, 'production');
      // This is the whole point: without the guard these bytes would land on the
      // server's local disk and disappear from view when the NAS remounted.
      await expect(driver.put('agreements/x.pdf', Buffer.from('%PDF-'))).rejects.toThrow(
        /Refusing to write/,
      );
      await expect(driver.exists('agreements/x.pdf')).resolves.toBe(false);
    });

    it('does not require the marker in development', async () => {
      const driver = makeDriver(root, 'development');
      await expect(driver.onModuleInit()).resolves.toBeUndefined();
      await expect(driver.put('a/b.pdf', Buffer.from('x'))).resolves.toBeDefined();
    });
  });

  describe('write semantics', () => {
    let driver: FilesystemStorageDriver;

    beforeEach(async () => {
      await fs.writeFile(path.join(root, '.gtids-storage-root'), '');
      driver = makeDriver(root, 'production');
      await driver.onModuleInit();
    });

    it('stores and returns bytes unchanged', async () => {
      const payload = Buffer.from('%PDF-1.4\n% executed agreement\n%%EOF\n');
      const key = objectKey('GTIDS/2026-27/SVCAGR/000042', 1, 'final-md-signed.pdf');

      const stored = await driver.put(key, payload);
      expect(stored.sizeBytes).toBe(payload.length);

      const fetched = await driver.get(key);
      expect(sha256(fetched)).toBe(sha256(payload));
    });

    it('is write-once — a second write to the same key is refused', async () => {
      await driver.put('a/doc.pdf', Buffer.from('original'));
      await expect(driver.put('a/doc.pdf', Buffer.from('replacement'))).rejects.toThrow(
        /write-once/,
      );
      expect((await driver.get('a/doc.pdf')).toString()).toBe('original');
    });

    it('leaves exactly one winner when the same key is written concurrently', async () => {
      // Two workers reconciling the same signing transaction at once.
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => driver.put('a/race.pdf', Buffer.from(`writer-${i}`))),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((r) => r.status === 'rejected')) {
        expect((r as PromiseRejectedResult).reason.message).toMatch(/write-once/);
      }
    });

    it('leaves no temporary files behind', async () => {
      await driver.put('a/one.pdf', Buffer.from('x'));
      await driver.put('a/two.pdf', Buffer.from('y'));
      await driver.put('a/one.pdf', Buffer.from('z')).catch(() => undefined); // rejected

      const entries = await fs.readdir(path.join(root, 'a'));
      expect(entries.sort()).toEqual(['one.pdf', 'two.pdf']);
    });

    it('writes files and directories with restrictive permissions', async () => {
      await driver.put('secure/doc.pdf', Buffer.from('x'));
      const file = await fs.stat(path.join(root, 'secure/doc.pdf'));
      const dir = await fs.stat(path.join(root, 'secure'));
      // Readable by the service user and its group only; never world-readable.
      expect(file.mode & 0o007).toBe(0);
      expect(dir.mode & 0o007).toBe(0);
    });

    it('refuses path traversal out of the storage root', async () => {
      await expect(driver.put('../../escape.pdf', Buffer.from('x'))).rejects.toThrow(
        /illegal object key/,
      );
      await expect(driver.get('../../../etc/passwd')).rejects.toThrow(/illegal object key/);
    });
  });

  describe('download URLs', () => {
    let driver: FilesystemStorageDriver;

    beforeEach(async () => {
      await fs.writeFile(path.join(root, '.gtids-storage-root'), '');
      driver = makeDriver(root, 'production');
      await driver.onModuleInit();
    });

    it('issues a URL that verifies', async () => {
      const url = await driver.signedUrl('a/doc.pdf', 300);
      const params = new URL(url).searchParams;
      expect(
        driver.verifySignedUrl('a/doc.pdf', Number(params.get('expires')), params.get('sig')!),
      ).toBe(true);
    });

    it('rejects a tampered signature', async () => {
      const url = await driver.signedUrl('a/doc.pdf', 300);
      const params = new URL(url).searchParams;
      expect(driver.verifySignedUrl('a/doc.pdf', Number(params.get('expires')), 'deadbeef')).toBe(
        false,
      );
    });

    it('rejects a URL reused for a different object', async () => {
      const url = await driver.signedUrl('a/doc.pdf', 300);
      const params = new URL(url).searchParams;
      expect(
        driver.verifySignedUrl('b/other.pdf', Number(params.get('expires')), params.get('sig')!),
      ).toBe(false);
    });

    it('rejects an expired URL', async () => {
      const expired = Math.floor(Date.now() / 1000) - 10;
      const url = await driver.signedUrl('a/doc.pdf', -10);
      const sig = new URL(url).searchParams.get('sig')!;
      expect(driver.verifySignedUrl('a/doc.pdf', expired, sig)).toBe(false);
    });
  });
});
