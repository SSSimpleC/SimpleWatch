import { v7 as uuidv7 } from "uuid";

import type { AppDatabase } from "../database.js";
import { conflict, unauthorized } from "../errors.js";
import {
  createSessionCredential,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyTokenHash,
} from "../security.js";

interface AdminRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
}

interface AdminSessionRow {
  readonly id_hash: string;
  readonly admin_id: string;
  readonly username: string;
  readonly csrf_hash: string;
  readonly expires_at: number;
}

export interface AdminIdentity {
  readonly id: string;
  readonly username: string;
}

export interface AdminLoginResult {
  readonly admin: AdminIdentity;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export class AuthService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  public async bootstrapAdmin(
    usernameInput: string,
    code: string,
  ): Promise<AdminIdentity> {
    const username = usernameInput.trim();
    if (username.length === 0 || username.length > 64) {
      throw new Error("管理员用户名长度必须为 1–64 个字符");
    }
    requireAccessCode(code);

    const existing = this.database
      .prepare("SELECT COUNT(*) AS count FROM admin_users")
      .get() as {
      readonly count: number;
    };
    if (existing.count > 0) {
      throw conflict("ADMIN_ALREADY_EXISTS", "管理员账户已经初始化");
    }

    const passwordHash = await hashPassword(code);
    const admin = { id: uuidv7(), username };
    const timestamp = this.now();

    this.database
      .prepare(
        `INSERT INTO admin_users(
          id, username, password_hash, created_at, password_changed_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(admin.id, admin.username, passwordHash, timestamp, timestamp);

    return admin;
  }

  public async login(code: string): Promise<AdminLoginResult> {
    requireAccessCode(code);
    const row = this.database
      .prepare(
        "SELECT id, username, password_hash FROM admin_users ORDER BY created_at ASC LIMIT 1",
      )
      .get() as AdminRow | undefined;
    if (!row || !(await verifyPassword(row.password_hash, code))) {
      throw unauthorized("放映口令错误");
    }

    const credential = createSessionCredential();
    const createdAt = this.now();
    const expiresAt = createdAt + 12 * 60 * 60 * 1000;
    this.database
      .prepare(
        `INSERT INTO admin_sessions(
          id_hash, admin_id, csrf_hash, expires_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        credential.tokenHash,
        row.id,
        credential.csrfHash,
        expiresAt,
        createdAt,
      );

    return {
      admin: { id: row.id, username: row.username },
      sessionToken: credential.token,
      csrfToken: credential.csrfToken,
      expiresAt,
    };
  }

  public async configureAccessCode(code: string): Promise<AdminIdentity> {
    requireAccessCode(code);
    const rows = this.database
      .prepare(
        "SELECT id, username, password_hash FROM admin_users ORDER BY created_at ASC",
      )
      .all() as AdminRow[];
    if (rows.length === 0) return this.bootstrapAdmin("projectionist", code);
    if (rows.length > 1) {
      throw conflict("MULTIPLE_ADMINS", "检测到多个管理员，拒绝修改放映口令");
    }
    const admin = rows[0]!;
    const passwordHash = await hashPassword(code);
    const timestamp = this.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE admin_users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
        )
        .run(passwordHash, timestamp, admin.id);
      this.database
        .prepare(
          "UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL",
        )
        .run(timestamp, admin.id);
    })();
    return { id: admin.id, username: admin.username };
  }

  public authenticate(sessionToken: string | undefined): AdminSessionRow {
    if (!sessionToken) throw unauthorized();
    const row = this.database
      .prepare(
        `SELECT s.id_hash, s.admin_id, u.username, s.csrf_hash, s.expires_at
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.admin_id
         WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(hashToken(sessionToken), this.now()) as AdminSessionRow | undefined;
    if (!row) throw unauthorized();
    return row;
  }

  public requireCsrf(
    session: AdminSessionRow,
    csrfToken: string | undefined,
  ): void {
    if (!csrfToken || !verifyTokenHash(csrfToken, session.csrf_hash)) {
      throw unauthorized("CSRF Token 无效");
    }
  }

  public logout(sessionToken: string): void {
    this.database
      .prepare(
        "UPDATE admin_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
      )
      .run(this.now(), hashToken(sessionToken));
  }
}

function requireAccessCode(code: string): void {
  if (!/^\d{6}$/.test(code)) throw new Error("放映口令必须为 6 位数字");
}
