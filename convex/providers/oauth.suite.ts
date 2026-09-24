/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { pkceChallengeS256, randomToken } from "../lib/crypto";
import { isProviderError } from "./errors";
import type { OAuthClientConfig, OAuthSpec } from "./oauth";

/**
 * Reusable contract for OAuth specs: the mock specs now, the real Meta /
 * Google specs (with recorded HTTP fixtures) in Phases 8-9.
 * Two dots in the file name: never deployed by Convex.
 */
export type OAuthContractOptions<C> = {
  name: string;
  create: () => OAuthSpec<C>;
  config: OAuthClientConfig;
  /** Produces a code the spec will accept for the given authorize URL + verifier. */
  validCode: (authorizeUrl: string, challenge: string | undefined) => Promise<string> | string;
  /** A code the spec must reject. */
  invalidCode: string;
};

const REDIRECT = "https://marketing-tests.convex.site/oauth/callback";
const NOW = 1_790_000_000_000;

export function runOAuthSpecContract<C>(options: OAuthContractOptions<C>) {
  describe(`${options.name}: OAuthSpec contract`, () => {
    const spec = options.create();

    it("declares scopes, requiring only requested scopes", () => {
      expect(spec.requestedScopes.length).toBeGreaterThan(0);
      for (const scope of spec.requiredScopes) expect(spec.requestedScopes).toContain(scope);
    });

    it("builds an authorization URL carrying the exact state and PKCE challenge", async () => {
      const state = randomToken();
      const verifier = randomToken();
      const challenge = spec.usesPkce ? await pkceChallengeS256(verifier) : undefined;
      const url = new URL(
        spec.buildAuthorizationUrl({
          state,
          redirectUri: REDIRECT,
          ...(challenge ? { codeChallenge: challenge } : {}),
          config: options.config,
        }),
      );
      expect(url.protocol).toBe("https:");
      expect(url.searchParams.get("state")).toBe(state);
      if (challenge) {
        expect(url.searchParams.get("code_challenge")).toBe(challenge);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      }
    });

    it("exchanges a valid code for a tenant-free grant", async () => {
      const verifier = randomToken();
      const challenge = spec.usesPkce ? await pkceChallengeS256(verifier) : undefined;
      const url = spec.buildAuthorizationUrl({
        state: "s",
        redirectUri: REDIRECT,
        ...(challenge ? { codeChallenge: challenge } : {}),
        config: options.config,
      });
      const grant = await spec.exchangeCode({
        code: await options.validCode(url, challenge),
        redirectUri: REDIRECT,
        ...(spec.usesPkce ? { codeVerifier: verifier } : {}),
        config: options.config,
        now: NOW,
      });
      expect(grant.identity.externalUserId).toMatch(/\S/);
      expect(grant.credential).toBeDefined();
      expect(Array.isArray(grant.grantedScopes)).toBe(true);
      if (grant.expiresAt !== undefined) expect(grant.expiresAt).toBeGreaterThan(NOW);
      const serialized = JSON.stringify(grant);
      for (const forbidden of ["orgId", "adAccountId", "connectionId", "tenant"]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it("rejects invalid codes with a typed, non-retryable ProviderError", async () => {
      let caught: unknown;
      try {
        await spec.exchangeCode({
          code: options.invalidCode,
          redirectUri: REDIRECT,
          config: options.config,
          now: NOW,
        });
      } catch (error) {
        caught = error;
      }
      expect(isProviderError(caught)).toBe(true);
      expect(isProviderError(caught) && caught.retryable).toBe(false);
    });

    if (spec.usesPkce) {
      it("rejects a valid code presented with the wrong PKCE verifier", async () => {
        const challenge = await pkceChallengeS256(randomToken());
        const url = spec.buildAuthorizationUrl({
          state: "s",
          redirectUri: REDIRECT,
          codeChallenge: challenge,
          config: options.config,
        });
        await expect(
          spec.exchangeCode({
            code: await options.validCode(url, challenge),
            redirectUri: REDIRECT,
            codeVerifier: randomToken(),
            config: options.config,
            now: NOW,
          }),
        ).rejects.toMatchObject({ kind: "auth" });
      });
    }
  });
}
