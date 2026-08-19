import { useEffect, useRef, useState, useCallback } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "../lib/firebase.js";

// Synkroniserer ÉT samlet stykke state (fx hele "avail"-objektet, eller "friends"-objektet)
// mod ét enkelt Firestore-dokument — og opfører sig udadtil som useState(defaultValue):
//   const [avail, setAvail] = useFirestoreDocState("state/availability", {});
//
// Bruges til de dele af app-state der er ét sammenhængende objekt/Set/array, i modsætning til
// useFirestoreCollection (som er til lister af selvstændige poster med hvert sit id).
//
// toFirestore/fromFirestore konverterer til/fra noget Firestore kan gemme (JSON-agtige typer —
// Firestore forstår ikke JS Set, så fx {playerId: Set([...])}-objekter serialiseres til
// {playerId: [...]} og tilbage igen automatisk her.
export function useFirestoreDocState(path, defaultValue, { toFirestore, fromFirestore } = {}) {
  const [value, setValue] = useState(defaultValue);
  const latestRef = useRef(value);
  latestRef.current = value;
  const loadedRef = useRef(false);

  useEffect(() => {
    const ref = doc(db, path);
    const unsub = onSnapshot(ref, (snap) => {
      loadedRef.current = true;
      if (!snap.exists()) { setValue(defaultValue); latestRef.current = defaultValue; return; }
      const raw = snap.data();
      const next = fromFirestore ? fromFirestore(raw) : raw;
      latestRef.current = next;
      setValue(next);
    }, (err) => console.error(`Firestore-fejl (${path}):`, err));
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const setValueAndSync = useCallback((updater) => {
    const prev = latestRef.current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    latestRef.current = next;
    setValue(next);
    const payload = toFirestore ? toFirestore(next) : next;
    setDoc(doc(db, path), payload).catch((e) => console.error("Gem fejlede:", e));
  }, [path, toFirestore]);

  return [value, setValueAndSync];
}

// ── Hjælpere til at (de)serialisere Set-baseret state (avail, templates, lockedPlayers) ──
// { playerId: Set<string> }  <->  { byPlayer: { playerId: string[] } }
export const setMapToFirestore = (obj) => ({
  byPlayer: Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, [...(v || [])]])),
});
export const setMapFromFirestore = (raw) => {
  const byPlayer = raw?.byPlayer || {};
  return Object.fromEntries(Object.entries(byPlayer).map(([k, v]) => [k, new Set(v || [])]));
};

// Set<string>  <->  { ids: string[] }
export const setToFirestore = (set) => ({ ids: [...(set || [])] });
export const setFromFirestore = (raw) => new Set(raw?.ids || []);

// { playerId: string[] }  <->  { byPlayer: { playerId: string[] } }  (fx "friends")
export const plainMapToFirestore = (obj) => ({ byPlayer: obj || {} });
export const plainMapFromFirestore = (raw) => raw?.byPlayer || {};

// array  <->  { list: array }  (fx "matches")
export const listToFirestore = (arr) => ({ list: arr || [] });
export const listFromFirestore = (raw) => raw?.list || [];
