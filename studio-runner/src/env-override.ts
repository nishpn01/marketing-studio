/** Environment variables that redirect code or executables (role registry, model binary) are refused unless the operator opts in. */
export function envOverride(name: string): string | undefined {
  const v = process.env[name];
  if (v && process.env.STUDIO_ALLOW_ENV_OVERRIDES !== '1') throw new Error(`${name} is set but ignored for safety; set STUDIO_ALLOW_ENV_OVERRIDES=1 to allow it (trusted launchers and tests only)`);
  return v || undefined;
}
