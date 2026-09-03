// ---------------------------------------------------------------------------
// Firebase configuration
// ---------------------------------------------------------------------------
// The Web API key is read from the `apiKey` project environment variable
// (injected as import.meta.env.VITE_FIREBASE_API_KEY by vite.config.js).
// Firebase Web API keys are safe to expose on the client; real security is
// enforced by Firebase Auth settings and Firestore security rules.
// ---------------------------------------------------------------------------

import { initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"
import { getFirestore } from "firebase/firestore"

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: "lumip-13021.firebaseapp.com",
  projectId: "lumip-13021",
  storageBucket: "lumip-13021.firebasestorage.app",
  messagingSenderId: "34745474722",
  appId: "1:34745474722:web:150f1034d92048af5d81fb",
  measurementId: "G-ZWT60CNV86",
}

// True once a real API key is present.
export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("YOUR_"),
)

let auth = null
let db = null

if (isFirebaseConfigured) {
  const app = initializeApp(firebaseConfig)
  auth = getAuth(app)
  db = getFirestore(app)
}

export { auth, db }
