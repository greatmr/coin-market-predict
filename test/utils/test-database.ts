/**
 * The dedicated test database. Refuses any database whose name does not contain "test", so a
 * misconfigured run can never truncate the operator's data.
 */
export function testDbUrl(): string {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // optional
  }
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const base =
      process.env.DATABASE_URL ??
      postgresUrlFromEnv() ??
      'postgresql://coins:coins_dev_password@127.0.0.1:5433/coins';
    const u = new URL(base);
    u.pathname = '/coins_test';
    url = u.toString();
  }
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name))
    throw new Error(`Refusing to run DB tests against non-test database "${name}"`);
  return url;
}

/** Build a URL from the POSTGRES_* variables when DATABASE_URL is not used. */
function postgresUrlFromEnv(): string | null {
  const {
    POSTGRES_HOST: host,
    POSTGRES_PORT: port,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
  } = process.env;
  if (!host || !user || !password) return null;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port ?? 5432}/coins`;
}
