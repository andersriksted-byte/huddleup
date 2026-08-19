// Firebase-initialisering (modular SDK v9+, npm-pakken "firebase" — ingen script-tags).
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Din Firebase-projekt-konfiguration.
const firebaseConfig = {
  apiKey: "AIzaSyBGRW8DqutSuiZvsIbORj9ClWhEM9SCt3o",
  authDomain: "huddleup-bb710.firebaseapp.com",
  projectId: "huddleup-bb710",
  storageBucket: "huddleup-bb710.firebasestorage.app",
  messagingSenderId: "808728885224",
  appId: "1:808728885224:web:34041397e2b09cd0ad565d",
  measurementId: "G-QPPSZEP634",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Genererer et nyt, unikt dokument-id i en given collection uden at skrive noget endnu.
// Bruges i stedet for de gamle lokale tællere (newId/newInvId/newFriendReqId), som ikke
// er sikre når flere brugere/enheder arbejder i appen samtidig.
import { collection, doc } from "firebase/firestore";
export const newDocId = (collectionName) => doc(collection(db, collectionName)).id;
