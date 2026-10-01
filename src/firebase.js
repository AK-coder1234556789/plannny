import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
} from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  memoryLocalCache,
  collection,
  doc,
  addDoc as firestoreAddDoc,
  updateDoc as firestoreUpdateDoc,
  deleteDoc as firestoreDeleteDoc,
  setDoc as firestoreSetDoc,
  onSnapshot as firestoreOnSnapshot,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize or reuse live Firebase App
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

// Initialize Firestore with robust local cache persistence fallback for iframes and browsers
function createFirestoreInstance() {
  const dbId = firebaseConfig.firestoreDatabaseId;

  // Attempt 1: Multi-tab persistent local cache
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      dbId
    );
  } catch (e1) {
    console.warn('[Firestore] Multi-tab persistence not supported in this frame, trying single-tab...', e1?.message);
  }

  // Attempt 2: Single-tab persistent local cache (widely supported in iframes)
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentSingleTabManager(),
        }),
      },
      dbId
    );
  } catch (e2) {
    console.warn('[Firestore] Single-tab persistence failed, trying default local cache...', e2?.message);
  }

  // Attempt 3: Default persistent cache
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache(),
      },
      dbId
    );
  } catch (e3) {
    console.warn('[Firestore] Persistent cache failed, trying memory cache...', e3?.message);
  }

  // Attempt 4: In-memory local cache
  try {
    return initializeFirestore(
      app,
      {
        localCache: memoryLocalCache(),
      },
      dbId
    );
  } catch (e4) {
    console.warn('[Firestore] initializeFirestore failed, falling back to getFirestore...', e4?.message);
  }

  // Attempt 5: Standard getFirestore
  return getFirestore(app, dbId);
}

export const db = createFirestoreInstance();

export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

export const configured = true;

// Operation types for error handling
export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    code: error?.code || 'unknown',
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
    },
    operationType,
    path,
  };
  console.warn('[Firestore Notice]:', JSON.stringify(errInfo));
  // Note: Do not throw from async listeners to avoid crashing the React UI
  return errInfo;
}

// Wrapped Firestore mutations with safe error handling
export async function addDoc(colRef, data) {
  try {
    return await firestoreAddDoc(colRef, data);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, colRef.path || 'collection');
    throw err;
  }
}

export async function updateDoc(docRef, patch) {
  try {
    return await firestoreUpdateDoc(docRef, patch);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, docRef.path || 'document');
    throw err;
  }
}

export async function deleteDoc(docRef) {
  try {
    return await firestoreDeleteDoc(docRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docRef.path || 'document');
    throw err;
  }
}

export async function setDoc(docRef, data) {
  try {
    return await firestoreSetDoc(docRef, data);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, docRef.path || 'document');
    throw err;
  }
}

export function onSnapshot(targetRef, optionsOrCb, maybeCb) {
  const path = targetRef.path || 'snapshot';
  if (typeof optionsOrCb === 'function') {
    return firestoreOnSnapshot(
      targetRef,
      optionsOrCb,
      (err) => handleFirestoreError(err, OperationType.GET, path)
    );
  }
  return firestoreOnSnapshot(
    targetRef,
    optionsOrCb,
    maybeCb,
    (err) => handleFirestoreError(err, OperationType.GET, path)
  );
}

export {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  collection,
  doc,
  arrayUnion,
  arrayRemove,
};
