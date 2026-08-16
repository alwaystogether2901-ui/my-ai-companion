import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  type Auth,
} from "firebase/auth";

/**
 * Firebase is used for AUTHENTICATION ONLY.
 * No Firestore, no Firebase Storage — Supabase owns all data and files.
 *
 * The web config below is public by design (it identifies, it does not authorize).
 * Env vars override it so the same code runs against another Firebase project.
 */
const firebaseConfig = {
  apiKey: import.meta.env["VITE_FIREBASE_API_KEY"] ?? "AIzaSyBFwDbVeTNPhGLJZ5vwxYQd_k8ltwXEw5g",
  authDomain:
    import.meta.env["VITE_FIREBASE_AUTH_DOMAIN"] ?? "always-together-83a30.firebaseapp.com",
  projectId: import.meta.env["VITE_FIREBASE_PROJECT_ID"] ?? "always-together-83a30",
  storageBucket:
    import.meta.env["VITE_FIREBASE_STORAGE_BUCKET"] ?? "always-together-83a30.firebasestorage.app",
  messagingSenderId: import.meta.env["VITE_FIREBASE_MESSAGING_SENDER_ID"] ?? "941587612584",
  appId:
    import.meta.env["VITE_FIREBASE_APP_ID"] ?? "1:941587612584:web:f1010a80ea6b272004939d",
};

export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (typeof window === "undefined") {
    throw new Error("Firebase is browser-only in this app");
  }
  if (!app) {
    app = getApps()[0] ?? initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(getFirebaseApp());
    // Survive page reloads and browser restarts.
    void setPersistence(authInstance, browserLocalPersistence).catch(() => {});
  }
  return authInstance;
}
