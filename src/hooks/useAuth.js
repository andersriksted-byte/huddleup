import { useEffect, useState, useCallback } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase.js";

// Erstatter det gamle mock-login (INITIAL_USERS + generatePassword) med rigtig Firebase
// Authentication. "profile" er det tilhørende Firestore-dokument i collection'en "profiles"
// (navn, telefon, avatar mv. — alt det som IKKE er en del af selve login-identiteten).
export function useAuth() {
  const [fbUser, setFbUser] = useState(undefined); // undefined = endnu ikke afklaret, null = logget ud
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setFbUser(u || null);
      if (u) {
        const ref = doc(db, "profiles", u.uid);
        const snap = await getDoc(ref);
        setProfile(snap.exists() ? { id: u.uid, ...snap.data() } : { id: u.uid, name: u.email, email: u.email, phone: "" });
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const signIn = useCallback((email, password) => signInWithEmailAndPassword(auth, email, password), []);

  const signUp = useCallback(async ({ name, email, phone, password, avatarEmoji, avatarImage }) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const profileDoc = {
      name: name || email,
      email,
      phone: phone || "",
      avatarEmoji: avatarEmoji || null,
      avatarImage: avatarImage || null,
    };
    await setDoc(doc(db, "profiles", cred.user.uid), profileDoc);
    setProfile({ id: cred.user.uid, ...profileDoc });
    return cred.user;
  }, []);

  const signOutUser = useCallback(() => firebaseSignOut(auth), []);

  const resetPassword = useCallback((email) => sendPasswordResetEmail(auth, email), []);

  // Skift adgangskode mens man er logget ind — Firebase kræver "reauthentication" med den
  // nuværende adgangskode, før den vil acceptere en ny (sikkerhedsforanstaltning i Firebase Auth).
  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const user = auth.currentUser;
    if (!user) throw new Error("Ikke logget ind.");
    const cred = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, cred);
    await updatePassword(user, newPassword);
  }, []);

  const saveProfile = useCallback(async (partial) => {
    const user = auth.currentUser;
    if (!user) throw new Error("Ikke logget ind.");
    await setDoc(doc(db, "profiles", user.uid), partial, { merge: true });
    setProfile((prev) => ({ ...(prev || { id: user.uid }), ...partial }));
  }, []);

  return {
    firebaseUser: fbUser,
    currentUser: profile,
    loading,
    signIn,
    signUp,
    signOut: signOutUser,
    resetPassword,
    changePassword,
    saveProfile,
  };
}
