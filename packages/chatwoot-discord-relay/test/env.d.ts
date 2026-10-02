declare namespace Cloudflare {
  interface Env {
    /** Test-only: private half of the throwaway key pair generated in vitest.config.ts. */
    TEST_DISCORD_PRIVATE_JWK: string;
  }
}
