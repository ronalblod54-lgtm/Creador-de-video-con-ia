// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "@hatch/space-sdk/client";

// ------------------------------------------------------------ login session
//
// After signing in, the server hands the client a session token. It
// lives in localStorage (30-day server-side expiry) and EVERY action
// call carries it as `auth`, so the server resolves the caller's own
// account from the login — each person lands in their own space and
// library. Calls that pass an explicit `auth` (the session probe)
// keep theirs untouched.
const TOKEN_STORAGE_KEY = "creador-clips-auth-token";

export function getStoredAuthToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): the session then lasts only
    // until the page is closed, which the login screen accepts.
  }
}

const baseApi = createActionClient<typeof Actions>();

export const api = new Proxy(baseApi, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") return value;
    return (args?: Record<string, unknown>) => {
      const token = getStoredAuthToken();
      if (token && args && typeof args === "object" && !("auth" in args)) {
        return (value as (a: Record<string, unknown>) => unknown)({ ...args, auth: token });
      }
      return (value as (a?: Record<string, unknown>) => unknown)(args);
    };
  },
}) as typeof baseApi;

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
