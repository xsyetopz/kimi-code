/**
 * `auth` domain — OpenAI Codex ChatGPT account id extraction from OAuth JWTs.
 */

export interface CodexIdTokenClaims {
  readonly chatgpt_account_id?: string;
  readonly organizations?: ReadonlyArray<{ readonly id: string }>;
  readonly "https://api.openai.com/auth"?: {
    readonly chatgpt_account_id?: string;
  };
}

type CodexTokenResponse = {
  readonly id_token?: string;
  readonly access_token?: string;
};

export function parseJwtClaims(token: string): CodexIdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString(),
    ) as CodexIdTokenClaims;
  } catch {
    return undefined;
  }
}

export function extractAccountIdFromClaims(
  claims: CodexIdTokenClaims,
): string | undefined {
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  );
}

export function extractAccountIdFromTokens(
  tokens: CodexTokenResponse,
): string | undefined {
  if (tokens.id_token !== undefined) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId =
      claims === undefined ? undefined : extractAccountIdFromClaims(claims);
    if (accountId !== undefined) return accountId;
  }
  if (tokens.access_token === undefined) return undefined;
  const claims = parseJwtClaims(tokens.access_token);
  return claims === undefined ? undefined : extractAccountIdFromClaims(claims);
}
