import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { safeEqual } from '../../common/util/crypto.util';

export interface StoredObject {
  fileKey: string;
  sizeBytes: number;
  contentType: string;
}

export interface StorageHealth {
  ok: boolean;
  detail: string;
  freeBytes?: number;
}

/**
 * Private object storage (SDD v1.1 §B8).
 *
 * Objects are write-once: `put` refuses to overwrite an existing key. That is
 * what makes "a new state produces a new object" structural rather than a
 * convention someone can forget.
 *
 * There is no `delete`. Retention is managed by the NAS snapshot and backup
 * policy (DEC-013), not by application code, so a bug cannot destroy evidence.
 */
export abstract class StorageDriver {
  abstract put(fileKey: string, data: Buffer, contentType?: string): Promise<StoredObject>;
  abstract get(fileKey: string): Promise<Buffer>;
  abstract exists(fileKey: string): Promise<boolean>;
  /** Short-lived, authorization-checked download URL (SRS §12). */
  abstract signedUrl(fileKey: string, ttlSeconds?: number): Promise<string>;
  abstract health(): Promise<StorageHealth>;
}

/**
 * Marker file that must exist in the storage root.
 *
 * This is the guard against the defining NAS failure mode. If the export is not
 * mounted, the mountpoint is simply an empty directory on the server's local
 * disk — writes succeed, and signed agreements land somewhere that vanishes from
 * view the moment the NAS comes back. A sentinel that lives *on the NAS* makes an
 * unmounted share detectable instead of silent.
 */
const MOUNT_SENTINEL = '.gtids-storage-root';

/** Refuse to write when the share is nearly full; a truncated agreement is worse than a refusal. */
const MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * NAS-backed object storage.
 *
 * GTIDS hosts its own infrastructure and its documents live on a NAS export
 * mounted on the application server. That makes this the production driver, not
 * a development convenience, so it carries the durability properties a legal
 * document store needs: an unmounted-share guard, atomic exclusive creation, and
 * an fsync of both file and directory before a write is reported as done.
 */
@Injectable()
export class FilesystemStorageDriver extends StorageDriver implements OnModuleInit {
  private readonly log = new Logger(FilesystemStorageDriver.name);
  private readonly root: string;
  private readonly urlSecret: string;
  private readonly baseUrl: string;
  private readonly defaultTtl: number;
  private readonly requireSentinel: boolean;
  private readonly requireMountpoint: boolean;

  constructor(config: ConfigService) {
    super();
    this.root = path.resolve(config.get<string>('storage.fsRoot') ?? './storage');
    this.urlSecret = config.get<string>('auth.jwtSecret') ?? randomBytes(16).toString('hex');
    this.baseUrl = config.get<string>('apiBaseUrl') ?? 'http://localhost:3100';
    this.defaultTtl = config.get<number>('storage.signedUrlTtlSeconds') ?? 300;
    // Development runs on a local directory with no NAS behind it.
    this.requireSentinel = config.get<string>('env') === 'production';
    this.requireMountpoint =
      this.requireSentinel && config.get<boolean>('storage.requireMountpoint') !== false;
  }

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o750 });

    if (this.requireSentinel) {
      const health = await this.health();
      if (!health.ok) {
        // Fail at boot rather than at the moment someone signs. A running
        // instance that cannot see the NAS is worse than one that never started.
        throw new Error(
          `Storage is not usable: ${health.detail}. ` +
            `Expected the marker file ${MOUNT_SENTINEL} in ${this.root}. ` +
            `If the NAS export is mounted and this is a first install, create it with:\n` +
            `  touch ${path.join(this.root, MOUNT_SENTINEL)}`,
        );
      }
      this.log.log(`storage root ${this.root} verified (NAS marker present)`);
    }
  }

  async health(): Promise<StorageHealth> {
    try {
      await fs.access(this.root, fsSync.constants.R_OK | fsSync.constants.W_OK);
    } catch {
      return { ok: false, detail: `storage root ${this.root} is not readable/writable` };
    }

    if (this.requireSentinel) {
      try {
        await fs.access(path.join(this.root, MOUNT_SENTINEL));
      } catch {
        return {
          ok: false,
          detail: 'NAS marker file missing — the export is probably not mounted',
        };
      }

      /*
       * The marker alone is not enough. Someone creating it by hand on local disk
       * — an easy mistake while the NAS is still pending — would satisfy the check
       * while the share is absent, and every agreement written would be hidden the
       * moment the export is finally mounted over the top.
       *
       * A mountpoint sits on a different device from its parent directory, so
       * comparing the two catches a marker that is not actually on the NAS.
       */
      if (this.requireMountpoint) try {
        const [here, parent] = await Promise.all([
          fs.stat(this.root),
          fs.stat(path.dirname(this.root)),
        ]);
        if (here.dev === parent.dev) {
          return {
            ok: false,
            detail:
              `${this.root} is not a mountpoint — the marker file is on local disk. ` +
              'Mount the NAS export before starting in production.',
          };
        }
      } catch {
        // Cannot stat the parent (root directory, permissions). The marker check
        // above still applies; do not fail on an inconclusive probe.
      }
    }

    try {
      const stat = await fs.statfs(this.root);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes < MIN_FREE_BYTES) {
        return {
          ok: false,
          detail: `only ${Math.round(freeBytes / 1024 / 1024)} MB free on the storage volume`,
          freeBytes,
        };
      }
      return { ok: true, detail: `${Math.round(freeBytes / 1024 / 1024 / 1024)} GB free`, freeBytes };
    } catch {
      return { ok: true, detail: 'available (free space unknown)' };
    }
  }

  private resolve(fileKey: string): string {
    // Reject traversal before it reaches the filesystem.
    const target = path.resolve(this.root, fileKey);
    if (!target.startsWith(this.root + path.sep)) {
      throw new Error(`illegal object key: ${fileKey}`);
    }
    return target;
  }

  /**
   * Write atomically and exclusively.
   *
   * The sequence is: write a temporary file, fsync it, hard-link it into place,
   * unlink the temporary, then fsync the containing directory.
   *
   * `link()` fails with EEXIST if the destination is present, which gives an
   * atomic exclusive create that holds over NFS — where `O_EXCL` on open has
   * historically been unreliable. It also means a reader can never observe a
   * partially written agreement: the name appears only once the bytes are
   * complete and flushed.
   */
  async put(fileKey: string, data: Buffer, contentType = 'application/pdf'): Promise<StoredObject> {
    const health = await this.health();
    if (!health.ok) {
      throw new Error(`Refusing to write: ${health.detail}`);
    }

    const target = this.resolve(fileKey);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true, mode: 0o750 });

    const temp = path.join(dir, `.tmp-${randomBytes(12).toString('hex')}`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temp, 'wx', 0o640);
      await handle.writeFile(data);
      await handle.sync(); // bytes are on the NAS, not just in a client cache
      await handle.close();
      handle = undefined;

      await fs.link(temp, target); // atomic; EEXIST if the object already exists
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`object ${fileKey} already exists — storage objects are write-once`);
      }
      throw e;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temp).catch(() => undefined);
    }

    // Without this, a crash can lose the directory entry even though the file
    // contents were flushed — the object would exist but be unreachable.
    await this.fsyncDir(dir);

    return { fileKey, sizeBytes: data.length, contentType };
  }

  private async fsyncDir(dir: string): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(dir, 'r');
      await handle.sync();
    } catch {
      // Some network filesystems refuse to fsync a directory handle. The write
      // itself was already synced, so this is a durability improvement we do not
      // insist on.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async get(fileKey: string): Promise<Buffer> {
    return fs.readFile(this.resolve(fileKey));
  }

  async exists(fileKey: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(fileKey));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(fileKey: string, ttlSeconds = this.defaultTtl): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac('sha256', this.urlSecret).update(`${fileKey}:${expires}`).digest('hex');
    const q = new URLSearchParams({ key: fileKey, expires: String(expires), sig });
    return `${this.baseUrl}/api/v1/documents/download?${q.toString()}`;
  }

  /** Companion to signedUrl, used by the download controller. */
  verifySignedUrl(fileKey: string, expires: number, sig: string): boolean {
    if (Number.isNaN(expires) || expires * 1000 < Date.now()) return false;
    const expected = createHmac('sha256', this.urlSecret)
      .update(`${fileKey}:${expires}`)
      .digest('hex');
    return safeEqual(expected, sig);
  }
}

/** Agreement-centric object layout (SDD v1.1 §B8). */
export function objectKey(
  agreementNumber: string,
  version: number,
  name: string,
  createdAt: Date = new Date(),
): string {
  const year = createdAt.getFullYear();
  const month = String(createdAt.getMonth() + 1).padStart(2, '0');
  const safeNumber = agreementNumber.replace(/\//g, '-');
  return `agreements/${year}/${month}/${safeNumber}/v${version}/${name}`;
}
