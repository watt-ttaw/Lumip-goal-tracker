import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  // Load every env var (empty prefix) from .env files + process.env so we can
  // read the unprefixed `apiKey` project variable.
  const env = loadEnv(mode, process.cwd(), "")

  return {
    server: {
      host: true,
      port: 3000,
    },
    define: {
      // The Firebase Web API key lives in the `apiKey` project env var.
      // Firebase Web API keys are safe to expose on the client; access is
      // controlled by Firebase Auth settings and Firestore security rules.
      "import.meta.env.VITE_FIREBASE_API_KEY": JSON.stringify(env.apiKey),
    },
  }
})
