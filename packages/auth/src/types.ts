export type AuthKind = "api_key" | "oauth";

export interface Credential {
  readonly providerId: string;
  readonly kind: AuthKind;
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
}

export interface AuthStatus {
  readonly providerId: string;
  readonly label: string;
  readonly kind: AuthKind | "none";
  readonly configured: boolean;
  readonly expiresAt?: string;
}
