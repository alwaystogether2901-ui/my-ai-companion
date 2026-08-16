import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { useQueryClient } from "@tanstack/react-query";
import { getFirebaseAuth } from "./firebase";
import { explainSupabaseError, getSupabase, loadPublicConfig, resolveSupabaseIdentity } from "./supabase";

export type AuthLayerStatus = "unknown" | "ok" | "failed";

export type AuthState = {
  loading: boolean;
  /** Layer 1 — Firebase */
  firebaseUser: User | null;
  firebaseTokenPresent: boolean;
  /** Layer 2/3/4 — Supabase bridge, session and identity */
  supabaseUid: string | null;
  supabaseRole: string | null;
  bridgeStatus: AuthLayerStatus;
  bridgeError: string | null;
  supabaseConfigured: boolean;
  /** True only when every layer lines up — the gate for any data/storage call. */
  authorized: boolean;
  refreshIdentity: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [firebaseTokenPresent, setFirebaseTokenPresent] = useState(false);
  const [supabaseUid, setSupabaseUid] = useState<string | null>(null);
  const [supabaseRole, setSupabaseRole] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<AuthLayerStatus>("unknown");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [supabaseConfigured, setSupabaseConfigured] = useState(true);

  const verifyBridge = useCallback(
    async (user: User | null) => {
      if (!user) {
        setSupabaseUid(null);
        setSupabaseRole(null);
        setBridgeStatus("unknown");
        setBridgeError(null);
        return;
      }
      const config = await loadPublicConfig();
      setSupabaseConfigured(config.configured);
      if (!config.configured) {
        setBridgeStatus("failed");
        setBridgeError("Supabase publishable key is missing from the server configuration.");
        return;
      }
      const identity = await resolveSupabaseIdentity();
      if (identity.error) {
        setBridgeStatus("failed");
        setBridgeError(explainSupabaseError(new Error(identity.error)));
        setSupabaseUid(null);
        setSupabaseRole(null);
        return;
      }
      setSupabaseUid(identity.uid);
      setSupabaseRole(identity.role);
      if (!identity.uid) {
        setBridgeStatus("failed");
        setBridgeError(
          "Firebase is signed in but Supabase resolved no identity (auth.jwt()->>'sub' is null). Register this Firebase project under Supabase Auth → Third-Party Auth.",
        );
        return;
      }
      if (identity.uid !== user.uid) {
        setBridgeStatus("failed");
        setBridgeError("Supabase identity does not match the Firebase UID.");
        return;
      }
      setBridgeStatus("ok");
      setBridgeError(null);

      // Layer 5 smoke test + profile upsert (idempotent, never duplicates).
      try {
        const supabase = await getSupabase();
        await supabase.from("profiles").upsert(
          {
            user_id: user.uid,
            display_name: user.displayName ?? user.email?.split("@")[0] ?? "You",
            email: user.email,
            avatar_url: user.photoURL,
          },
          { onConflict: "user_id" },
        );
      } catch (error) {
        console.error("[auth] profile upsert failed", error);
      }
    },
    [],
  );

  useEffect(() => {
    const auth = getFirebaseAuth();
    const unsubscribe = onIdTokenChanged(auth, async (user) => {
      setFirebaseUser(user);
      setFirebaseTokenPresent(Boolean(user));
      await verifyBridge(user);
      setLoading(false);
    });
    return unsubscribe;
  }, [verifyBridge]);

  const refreshIdentity = useCallback(async () => {
    await verifyBridge(getFirebaseAuth().currentUser);
  }, [verifyBridge]);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
  }, []);

  const signUpWithEmail = useCallback(
    async (email: string, password: string, displayName: string) => {
      const credential = await createUserWithEmailAndPassword(
        getFirebaseAuth(),
        email.trim(),
        password,
      );
      if (displayName.trim()) {
        await updateProfile(credential.user, { displayName: displayName.trim() });
      }
    },
    [],
  );

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(getFirebaseAuth(), provider);
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(getFirebaseAuth(), email.trim());
  }, []);

  const signOut = useCallback(async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await firebaseSignOut(getFirebaseAuth());
    setSupabaseUid(null);
    setSupabaseRole(null);
    setBridgeStatus("unknown");
    setFirebaseTokenPresent(false);
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      firebaseUser,
      firebaseTokenPresent,
      supabaseUid,
      supabaseRole,
      bridgeStatus,
      bridgeError,
      supabaseConfigured,
      authorized: Boolean(firebaseUser && supabaseUid && supabaseUid === firebaseUser.uid),
      refreshIdentity,
      signInWithEmail,
      signUpWithEmail,
      signInWithGoogle,
      resetPassword,
      signOut,
    }),
    [
      loading,
      firebaseUser,
      firebaseTokenPresent,
      supabaseUid,
      supabaseRole,
      bridgeStatus,
      bridgeError,
      supabaseConfigured,
      refreshIdentity,
      signInWithEmail,
      signUpWithEmail,
      signInWithGoogle,
      resetPassword,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}

/** Guard every data/storage call: refuses when the bridge is not established. */
export function assertAuthorized(auth: AuthState): string {
  if (!auth.firebaseUser) throw new Error("You are signed out. Sign in to continue.");
  if (!auth.supabaseUid || auth.supabaseUid !== auth.firebaseUser.uid) {
    throw new Error(
      auth.bridgeError ??
        "Supabase authorization is not established yet. Open Diagnostics to inspect the auth bridge.",
    );
  }
  return auth.supabaseUid;
}
