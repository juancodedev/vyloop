export function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function envOptional(
  key: string,
  defaultValue?: string,
): string | undefined {
  return process.env[key] ?? defaultValue;
}
