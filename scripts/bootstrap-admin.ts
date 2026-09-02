import bcrypt from 'bcrypt';
import postgres from 'postgres';

const usernamePattern = /^[A-Za-z0-9._-]{3,50}$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validatePassword(password: string, username: string): void {
  const valid =
    Array.from(password).length >= 12 &&
    Buffer.byteLength(password, 'utf8') <= 72 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z\d]/.test(password) &&
    !password.toLocaleLowerCase('en-US').includes(username.toLocaleLowerCase('en-US'));
  if (!valid) {
    throw new Error(
      'BOOTSTRAP_ADMIN_PASSWORD must be 12+ characters with upper/lower/digit/symbol and must not contain the username',
    );
  }
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.PGDATABASE_URL ?? process.env.COZE_SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('PGDATABASE_URL or DATABASE_URL is required');

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin';
  const password = requiredEnvironment('BOOTSTRAP_ADMIN_PASSWORD');
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || null;
  const tenantCode = process.env.BOOTSTRAP_TENANT_CODE?.trim() || 'legacy';
  const applicationCode = process.env.BOOTSTRAP_APPLICATION_CODE?.trim() || 'default';
  if (!usernamePattern.test(username)) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME contains unsupported characters');
  }
  validatePassword(password, username);

  const passwordHash = await bcrypt.hash(password, 12);
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client.begin(async (transaction) => {
      const existing = await transaction<{ id: string }[]>`
        SELECT id FROM users WHERE username = ${username} LIMIT 1
      `;
      if (existing.length > 0) {
        throw new Error('Bootstrap administrator already exists; use the authenticated password reset flow');
      }
      const [scope] = await transaction<{ tenantId: string; applicationId: string }[]>`
        SELECT t.id AS "tenantId", a.id AS "applicationId"
        FROM tenants t
        JOIN applications a ON a.tenant_id = t.id
        WHERE t.code = ${tenantCode}
          AND a.code = ${applicationCode}
          AND t.status = 'active'
          AND a.status = 'active'
        LIMIT 1
      `;
      if (!scope) {
        throw new Error('Bootstrap tenant/application scope was not found or is inactive');
      }

      const [created] = await transaction<{ id: string }[]>`
        INSERT INTO users (
          username, nickname, email, password, role, status,
          token_version, failed_login_count, login_count,
          must_change_password, password_changed_at, created_at, updated_at
        ) VALUES (
          ${username}, ${'系统管理员'}, ${email}, ${passwordHash}, ${'SYSTEM_ADMIN'}, ${'active'},
          0, 0, 0, FALSE, NOW(), NOW(), NOW()
        )
        RETURNING id
      `;
      await transaction`
        INSERT INTO tenant_memberships (
          tenant_id, user_id, default_application_id, status
        ) VALUES (
          ${scope.tenantId}, ${created.id}, ${scope.applicationId}, 'active'
        )
      `;
    });
    process.stdout.write(`Bootstrap administrator created: ${username}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown bootstrap error';
  process.stderr.write(`Bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
