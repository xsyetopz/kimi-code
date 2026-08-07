import type { GlobalAuthFacade } from "@moonshot-ai/klient";

export type EngineAuthStatus = {
  readonly loggedIn: boolean;
  readonly provider?: string;
};

export type EngineOAuthFlowStart =
  | {
      readonly flow_id: string;
      readonly provider: string;
      readonly status: "pending";
      readonly verification_uri: string;
      readonly verification_uri_complete: string;
      readonly user_code: string;
      readonly expires_in: number;
      readonly interval: number;
      readonly expires_at: string;
    }
  | {
      readonly flow_id: string;
      readonly provider: string;
      readonly status: "authenticated";
    };

export type EngineOAuthFlowSnapshot = {
  readonly flow_id: string;
  readonly provider: string;
  readonly status:
    | "pending"
    | "authenticated"
    | "denied"
    | "expired"
    | "cancelled";
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly expires_at: string;
  readonly interval: number;
  readonly resolved_at?: string;
  readonly error_message?: string;
};

export type EngineOAuthLoginCancelResponse = {
  readonly cancelled: boolean;
  readonly status: EngineOAuthFlowSnapshot["status"];
};

export type EngineOAuthLogoutResponse = {
  readonly logged_out: true;
  readonly provider: string;
};

export interface KimiEngineAuthFacade {
  status(provider: string): Promise<EngineAuthStatus>;
  summarize(): Promise<readonly EngineAuthStatus[]>;
  startLogin(provider: string): Promise<EngineOAuthFlowStart>;
  flow(provider: string): Promise<EngineOAuthFlowSnapshot | undefined>;
  cancelLogin(provider: string): Promise<EngineOAuthLoginCancelResponse>;
  logout(provider: string): Promise<EngineOAuthLogoutResponse>;
}

export function createKimiEngineAuthFacade(
  auth: GlobalAuthFacade,
): KimiEngineAuthFacade {
  return {
    status: (provider) => auth.status(provider),
    summarize: () => auth.summarize(),
    startLogin: (provider) => auth.startLogin(provider),
    flow: (provider) => auth.flow(provider),
    cancelLogin: (provider) => auth.cancelLogin(provider),
    logout: (provider) => auth.logout(provider),
  };
}
