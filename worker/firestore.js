// Firebase Admin SDK initialization for the worker.
//
// Auth resolution order:
//   1. GOOGLE_APPLICATION_CREDENTIALS env var → service account JSON path
//   2. ./service-account.json next to this file
//   3. Application Default Credentials (gcloud auth application-default login)
//
// Project ID falls back to "toto-lab" (matches .firebaserc).

import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectId = process.env.FIREBASE_PROJECT_ID || "toto-lab";

if (!getApps().length) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const localKey = join(__dirname, "service-account.json");

  let credential;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = cert(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } else if (existsSync(localKey)) {
    credential = cert(localKey);
  } else {
    credential = applicationDefault();
  }

  initializeApp({ credential, projectId });
}

export const db = getFirestore();
