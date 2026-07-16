import { createHash, createHmac } from "node:crypto";

import { v7 as uuidv7 } from "uuid";

import type { AppDatabase } from "../database.js";
import { AppError, conflict, forbidden, unauthorized } from "../errors.js";
import {
  createOpaqueToken,
  createSessionCredential,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyTokenHash,
} from "../security.js";

const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;
const GENERIC_LOGIN_ERROR = "用户名或密码错误";

export type AccountRole = "host" | "viewer";

interface AccountRow {
  readonly id: string;
  readonly username: string;
  readonly role: AccountRole;
  readonly password_hash: string;
  readonly enabled: number;
}

export interface AccountIdentity {
  readonly id: string;
  readonly username: string;
  readonly role: AccountRole;
}

export interface AccountSession {
  readonly id_hash: string;
  readonly account_id: string;
  /** 兼容现有管理服务的字段名；值始终等于 account_id。 */
  readonly admin_id: string;
  readonly username: string;
  readonly role: AccountRole;
  readonly csrf_hash: string;
  readonly device_id: string;
  readonly idle_expires_at: number;
  readonly absolute_expires_at: number;
  readonly last_seen_at: number;
  readonly rotated_at: number;
  /** 内容URL只能活到会话绝对期限。 */
  readonly expires_at: number;
}

export interface LoginResult {
  readonly account: AccountIdentity;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

export interface ResumeResult {
  readonly session: AccountSession;
  readonly sessionToken?: string;
  readonly csrfToken: string;
}

export interface ProvisionedAccount {
  readonly username: string;
  readonly role: AccountRole;
  readonly password: string;
}

export class AuthService {
  private dummyPasswordHash: Promise<string> | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly database: AppDatabase,
    private readonly now: () => number = Date.now,
    private readonly passwordPepper = "test-password-pepper-not-for-production",
    sleep?: (milliseconds: number) => Promise<void>,
  ) {
    this.sleep =
      sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** 测试夹具兼容入口；生产部署只允许使用 accounts:provision。 */
  public async bootstrapAdmin(
    username: string,
    password: string,
  ): Promise<AccountIdentity> {
    const timestamp = this.now();
    const id = uuidv7();
    const passwordHash = await hashPassword(this.pepper(password));
    const normalized = normalizeUsername(username);
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO accounts(
            id, username, username_folded, role, password_hash, enabled,
            created_at, password_changed_at
          ) VALUES (?, ?, ?, 'host', ?, 1, ?, ?)`,
        )
        .run(
          id,
          normalized,
          foldUsername(normalized),
          passwordHash,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO admin_users(id, username, password_hash, created_at, password_changed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, normalized, passwordHash, timestamp, timestamp);
    })();
    return { id, username: normalized, role: "host" };
  }

  public async provisionAccounts(
    requested: readonly ProvisionedAccount[],
  ): Promise<AccountIdentity[]> {
    const normalized = requested.map((account) => ({
      username: normalizeUsername(account.username),
      folded: foldUsername(account.username),
      role: account.role,
      password: account.password,
    }));
    const names = new Set(normalized.map((account) => account.folded));
    if (names.size !== normalized.length)
      throw conflict("DUPLICATE_ACCOUNT", "账户名重复");
    for (const account of normalized) requireStrongPassword(account.password);

    const prepared = await Promise.all(
      normalized.map(async (account) => ({
        ...account,
        passwordHash: await hashPassword(this.pepper(account.password)),
      })),
    );
    const timestamp = this.now();
    const identities: AccountIdentity[] = [];
    this.database.transaction(() => {
      for (const account of prepared) {
        const existing = this.database
          .prepare("SELECT id FROM accounts WHERE username_folded = ?")
          .get(account.folded) as { readonly id: string } | undefined;
        const id = existing?.id ?? uuidv7();
        this.database
          .prepare(
            `INSERT INTO accounts(
              id, username, username_folded, role, password_hash, enabled,
              created_at, password_changed_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(username_folded) DO UPDATE SET
              username = excluded.username,
              role = excluded.role,
              password_hash = excluded.password_hash,
              enabled = 1,
              password_changed_at = excluded.password_changed_at`,
          )
          .run(
            id,
            account.username,
            account.folded,
            account.role,
            account.passwordHash,
            timestamp,
            timestamp,
          );
        identities.push({ id, username: account.username, role: account.role });

        // 历史 rooms.created_by / uploads.owner_admin_id 外键仍指向 admin_users。
        // Host 保留一条仅用于外键兼容的影子记录，新认证代码不再读取它。
        if (account.role === "host") {
          this.database
            .prepare(
              `INSERT INTO admin_users(id, username, password_hash, created_at, password_changed_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET username = excluded.username,
                 password_hash = excluded.password_hash,
                 password_changed_at = excluded.password_changed_at`,
            )
            .run(
              id,
              account.username,
              account.passwordHash,
              timestamp,
              timestamp,
            );
        }
      }

      const placeholders = prepared.map(() => "?").join(", ");
      this.database
        .prepare(
          `UPDATE accounts SET enabled = 0
           WHERE username_folded NOT IN (${placeholders})`,
        )
        .run(...prepared.map((account) => account.folded));
      this.database
        .prepare(
          "UPDATE account_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
        )
        .run(timestamp);
      this.database
        .prepare(
          "UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
        )
        .run(timestamp);
      this.database
        .prepare(
          "UPDATE room_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE token_jti SET revoked_at = ?
           WHERE revoked_at IS NULL AND subject_id IN (
             SELECT member_id FROM room_members
             WHERE room_id IN (SELECT id FROM rooms WHERE status = 'active')
           )`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE media_transport_sessions SET closed_at = ?
           WHERE closed_at IS NULL
             AND room_id IN (SELECT id FROM rooms WHERE status = 'active')`,
        )
        .run(timestamp);
      this.database
        .prepare(
          `UPDATE room_members SET left_at = COALESCE(left_at, ?), last_seen_at = ?
           WHERE room_id IN (SELECT id FROM rooms WHERE status = 'active')
             AND kicked_at IS NULL`,
        )
        .run(timestamp, timestamp);
      this.database
        .prepare(
          "UPDATE rooms SET status = 'closed', closed_at = ? WHERE status = 'active'",
        )
        .run(timestamp);
      this.database.prepare("DELETE FROM room_wait_queue").run();
      this.database.prepare("DELETE FROM room_device_leases").run();
    })();
    return identities;
  }

  public async manageAccount(input: {
    readonly username: string;
    readonly password?: string;
    readonly enabled?: boolean;
  }): Promise<AccountIdentity> {
    if (input.password === undefined && input.enabled === undefined) {
      throw new Error("必须指定新密码或启用状态");
    }
    if (input.password !== undefined) requireStrongPassword(input.password);
    const row = this.database
      .prepare(
        "SELECT id, username, role FROM accounts WHERE username_folded = ?",
      )
      .get(foldUsername(input.username)) as AccountIdentity | undefined;
    if (!row) throw unauthorized("账户不存在");
    const passwordHash = input.password
      ? await hashPassword(this.pepper(input.password))
      : undefined;
    const timestamp = this.now();
    this.database.transaction(() => {
      const activeMembers = this.database
        .prepare(
          `SELECT member_id, room_id, role FROM room_members
           WHERE account_id = ? AND left_at IS NULL AND kicked_at IS NULL`,
        )
        .all(row.id) as Array<{
        readonly member_id: string;
        readonly room_id: string;
        readonly role: "host" | "member";
      }>;
      if (passwordHash) {
        this.database
          .prepare(
            "UPDATE accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?",
          )
          .run(passwordHash, timestamp, row.id);
      }
      if (input.enabled !== undefined) {
        this.database
          .prepare("UPDATE accounts SET enabled = ? WHERE id = ?")
          .run(input.enabled ? 1 : 0, row.id);
      }
      this.database
        .prepare(
          "UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
        )
        .run(timestamp, row.id);
      this.database
        .prepare("DELETE FROM room_wait_queue WHERE account_id = ?")
        .run(row.id);
      this.database
        .prepare(
          `DELETE FROM room_device_leases WHERE member_id IN (
             SELECT member_id FROM room_members WHERE account_id = ?
           )`,
        )
        .run(row.id);
      for (const member of activeMembers) {
        if (member.role === "member") {
          this.database
            .prepare(
              "UPDATE room_members SET left_at = ?, last_seen_at = ? WHERE member_id = ?",
            )
            .run(timestamp, timestamp, member.member_id);
        }
        this.database
          .prepare(
            "UPDATE token_jti SET revoked_at = ? WHERE subject_id = ? AND revoked_at IS NULL",
          )
          .run(timestamp, member.member_id);
        const sessionIds = this.database
          .prepare(
            `SELECT mediamtx_session_id FROM media_transport_sessions
             WHERE member_id = ? AND closed_at IS NULL
               AND mediamtx_session_id IS NOT NULL`,
          )
          .all(member.member_id)
          .map(
            (item) =>
              (item as { readonly mediamtx_session_id: string })
                .mediamtx_session_id,
          );
        if (sessionIds.length > 0) {
          this.database
            .prepare(
              `INSERT INTO service_outbox(
                id, kind, dedupe_key, payload_json, state, attempts,
                not_before, lease_until, last_error, created_at, completed_at
              ) VALUES (?, 'mediamtx.kick-sessions', ?, ?, 'pending', 0,
                ?, NULL, NULL, ?, NULL)`,
            )
            .run(
              uuidv7(),
              `account-media-revoke:${uuidv7()}`,
              JSON.stringify({
                roomId: member.room_id,
                memberId: member.member_id,
                sessionIds,
              }),
              timestamp,
              timestamp,
            );
        }
        this.database
          .prepare(
            `INSERT INTO service_outbox(
              id, kind, dedupe_key, payload_json, state, attempts,
              not_before, lease_until, last_error, created_at, completed_at
            ) VALUES (?, 'rtc.remove-participant', ?, ?, 'pending', 0,
              ?, NULL, NULL, ?, NULL)`,
          )
          .run(
            uuidv7(),
            `account-rtc-revoke:${uuidv7()}`,
            JSON.stringify({
              roomId: member.room_id,
              memberId: member.member_id,
            }),
            timestamp,
            timestamp,
          );
      }
    })();
    return row;
  }

  public async login(
    usernameInput: string,
    password: string,
    requestIp: string,
  ): Promise<LoginResult> {
    const usernameFolded = foldUsername(usernameInput);
    this.requireLoginAllowed(usernameFolded, requestIp);
    const row = this.database
      .prepare(
        `SELECT id, username, role, password_hash, enabled
         FROM accounts WHERE username_folded = ? LIMIT 1`,
      )
      .get(usernameFolded) as AccountRow | undefined;

    const candidateHash =
      row?.password_hash ?? (await this.getDummyPasswordHash());
    const valid = await verifyPassword(candidateHash, this.pepper(password));
    if (!row || row.enabled !== 1 || !valid) {
      this.recordLoginFailure(usernameFolded, requestIp);
      await this.sleep(250 + Math.floor(Math.random() * 1751));
      throw unauthorized(GENERIC_LOGIN_ERROR);
    }

    this.clearLoginFailures(usernameFolded, requestIp);
    const credential = createSessionCredential();
    const createdAt = this.now();
    const idleExpiresAt = createdAt + IDLE_TTL_MS;
    const absoluteExpiresAt = createdAt + ABSOLUTE_TTL_MS;
    const deviceId = uuidv7();
    this.database
      .prepare(
        `INSERT INTO account_sessions(
          id_hash, account_id, csrf_hash, device_id, idle_expires_at,
          absolute_expires_at, last_seen_at, rotated_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        credential.tokenHash,
        row.id,
        credential.csrfHash,
        deviceId,
        idleExpiresAt,
        absoluteExpiresAt,
        createdAt,
        createdAt,
        createdAt,
      );
    return {
      account: { id: row.id, username: row.username, role: row.role },
      sessionToken: credential.token,
      csrfToken: credential.csrfToken,
      idleExpiresAt,
      absoluteExpiresAt,
    };
  }

  public authenticate(sessionToken: string | undefined): AccountSession {
    if (!sessionToken) throw unauthorized();
    const timestamp = this.now();
    const row = this.database
      .prepare(
        `SELECT s.id_hash, s.account_id, a.username, a.role, s.csrf_hash,
                s.device_id, s.idle_expires_at, s.absolute_expires_at,
                s.last_seen_at, s.rotated_at
         FROM account_sessions s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id_hash = ? AND s.revoked_at IS NULL AND a.enabled = 1
           AND s.idle_expires_at > ? AND s.absolute_expires_at > ?`,
      )
      .get(hashToken(sessionToken), timestamp, timestamp) as
      | Omit<AccountSession, "admin_id" | "expires_at">
      | undefined;
    if (!row) throw unauthorized();
    if (timestamp - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      const idleExpiresAt = Math.min(
        row.absolute_expires_at,
        timestamp + IDLE_TTL_MS,
      );
      this.database
        .prepare(
          `UPDATE account_sessions
           SET last_seen_at = ?, idle_expires_at = ?
           WHERE id_hash = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, idleExpiresAt, row.id_hash);
      return {
        ...row,
        admin_id: row.account_id,
        last_seen_at: timestamp,
        idle_expires_at: idleExpiresAt,
        expires_at: row.absolute_expires_at,
      };
    }
    return {
      ...row,
      admin_id: row.account_id,
      expires_at: row.absolute_expires_at,
    };
  }

  public resume(sessionToken: string | undefined): ResumeResult {
    const session = this.authenticate(sessionToken);
    const credential = createSessionCredential();
    const timestamp = this.now();
    if (timestamp - session.rotated_at < ROTATE_AFTER_MS) {
      this.database
        .prepare("UPDATE account_sessions SET csrf_hash = ? WHERE id_hash = ?")
        .run(credential.csrfHash, session.id_hash);
      return {
        session: { ...session, csrf_hash: credential.csrfHash },
        csrfToken: credential.csrfToken,
      };
    }

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO account_sessions(
            id_hash, account_id, csrf_hash, device_id, idle_expires_at,
            absolute_expires_at, last_seen_at, rotated_at, revoked_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          credential.tokenHash,
          session.account_id,
          credential.csrfHash,
          session.device_id,
          session.idle_expires_at,
          session.absolute_expires_at,
          timestamp,
          timestamp,
          session.absolute_expires_at - ABSOLUTE_TTL_MS,
        );
      this.database
        .prepare(
          "UPDATE room_wait_queue SET session_hash = ? WHERE session_hash = ?",
        )
        .run(credential.tokenHash, session.id_hash);
      this.database
        .prepare(
          "UPDATE room_device_leases SET session_hash = ? WHERE session_hash = ?",
        )
        .run(credential.tokenHash, session.id_hash);
      this.database
        .prepare("DELETE FROM account_sessions WHERE id_hash = ?")
        .run(session.id_hash);
    })();
    return {
      session: {
        ...session,
        id_hash: credential.tokenHash,
        csrf_hash: credential.csrfHash,
        last_seen_at: timestamp,
        rotated_at: timestamp,
      },
      sessionToken: credential.token,
      csrfToken: credential.csrfToken,
    };
  }

  public requireHost(session: AccountSession): void {
    if (session.role !== "host") throw forbidden("仅放映管理员可以执行此操作");
  }

  public requireCsrf(
    session: AccountSession,
    csrfToken: string | undefined,
  ): void {
    if (!csrfToken || !verifyTokenHash(csrfToken, session.csrf_hash)) {
      throw unauthorized("CSRF Token 无效");
    }
  }

  public rotateCsrf(session: AccountSession): string {
    const token = createOpaqueToken();
    const result = this.database
      .prepare(
        "UPDATE account_sessions SET csrf_hash = ? WHERE id_hash = ? AND revoked_at IS NULL",
      )
      .run(hashToken(token), session.id_hash);
    if (result.changes !== 1) throw unauthorized();
    return token;
  }

  public logout(sessionToken: string): void {
    const tokenHash = hashToken(sessionToken);
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE account_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
        )
        .run(this.now(), tokenHash);
      this.database
        .prepare("DELETE FROM room_wait_queue WHERE session_hash = ?")
        .run(tokenHash);
      this.database
        .prepare("DELETE FROM room_device_leases WHERE session_hash = ?")
        .run(tokenHash);
    })();
  }

  private requireLoginAllowed(username: string, requestIp: string): void {
    const timestamp = this.now();
    const checks = [
      { key: `${username}|${requestIp}`, seconds: 15 * 60, limit: 5 },
      { key: requestIp, seconds: 60 * 60, limit: 20 },
    ];
    for (const check of checks) {
      const row = this.database
        .prepare(
          `SELECT attempts, window_started_at FROM auth_rate_limits
           WHERE key_hash = ? AND window_seconds = ?`,
        )
        .get(rateKey(check.key), check.seconds) as
        | { readonly attempts: number; readonly window_started_at: number }
        | undefined;
      if (
        row &&
        timestamp - row.window_started_at < check.seconds * 1000 &&
        row.attempts >= check.limit
      ) {
        throw new AppError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
      }
    }
  }

  private recordLoginFailure(username: string, requestIp: string): void {
    const timestamp = this.now();
    for (const item of [
      { key: `${username}|${requestIp}`, seconds: 15 * 60 },
      { key: requestIp, seconds: 60 * 60 },
    ]) {
      const keyHash = rateKey(item.key);
      this.database
        .prepare(
          `INSERT INTO auth_rate_limits(key_hash, window_seconds, window_started_at, attempts)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(key_hash, window_seconds) DO UPDATE SET
             attempts = CASE
               WHEN ? - window_started_at >= window_seconds * 1000 THEN 1
               ELSE attempts + 1
             END,
             window_started_at = CASE
               WHEN ? - window_started_at >= window_seconds * 1000 THEN ?
               ELSE window_started_at
             END`,
        )
        .run(keyHash, item.seconds, timestamp, timestamp, timestamp, timestamp);
    }
  }

  private clearLoginFailures(username: string, requestIp: string): void {
    this.database
      .prepare(`DELETE FROM auth_rate_limits WHERE key_hash IN (?, ?)`)
      .run(rateKey(`${username}|${requestIp}`), rateKey(requestIp));
  }

  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword(this.pepper(createOpaqueToken(32)));
    return this.dummyPasswordHash;
  }

  private pepper(password: string): string {
    return createHmac("sha256", this.passwordPepper)
      .update(password, "utf8")
      .digest("base64url");
  }
}

function normalizeUsername(input: string): string {
  const username = input.normalize("NFC").trim();
  if (username.length < 1 || username.length > 64) {
    throw new Error("用户名长度必须为1–64个字符");
  }
  return username;
}

function foldUsername(input: string): string {
  return normalizeUsername(input).toLocaleLowerCase("en-US");
}

function requireStrongPassword(password: string): void {
  if (password.length < 20 || password.length > 128) {
    throw new Error("固定账户密码长度必须为20–128个字符");
  }
}

function rateKey(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
