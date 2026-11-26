import { create } from "zustand";
import { AuthUser, fetchMe, signInUrl, signOut } from "@/api/auth";

/** unknown: not asked yet; unavailable: the API cannot be reached (not deployed, offline) -> no account UI */
type Status = "unknown" | "signedOut" | "signedIn" | "unavailable";

const RESULT_NOTICE: Record<string, string> = {
  denied: "Sign-in was cancelled",
  error: "Sign-in failed, please try again",
  banned: "This account cannot sign in",
};

type AuthStore = {
  status: Status;
  user: AuthUser | null;
  /** one-off message after coming back from GitHub */
  notice: string | null;

  init: () => Promise<void>;
  signIn: () => void;
  signOut: () => Promise<void>;
  clearNotice: () => void;
  /** a short message under the account button */
  notify: (message: string) => void;
  /** the ODbL agreement was given with a contribution */
  setAcceptedTerms: () => void;
};

export const useAuthStore = create<AuthStore>((set) => ({
  status: "unknown",
  user: null,
  notice: null,

  init: async () => {
    // the API appends ?auth=<result> when it sends the browser back; read it once and drop it from the URL
    const url = new URL(window.location.href);
    const result = url.searchParams.get("auth");
    if (result) {
      url.searchParams.delete("auth");
      window.history.replaceState(null, "", url.toString());
    }
    try {
      const user = await fetchMe();
      set({
        status: user ? "signedIn" : "signedOut",
        user,
        notice: result === "ok" && user ? `Signed in as @${user.login}` : result ? (RESULT_NOTICE[result] ?? null) : null,
      });
    } catch (err) {
      console.warn("account service unavailable:", err);
      set({ status: "unavailable", user: null });
    }
  },
  signIn: () => {
    window.location.assign(signInUrl());
  },
  signOut: async () => {
    await signOut().catch(() => {});
    set({ status: "signedOut", user: null, notice: "Signed out" });
  },
  clearNotice: () => set({ notice: null }),
  notify: (notice) => set({ notice }),
  setAcceptedTerms: () => set((s) => ({ user: s.user && { ...s.user, acceptedTerms: true } })),
}));
