import { useEffect, useRef, useState, useCallback } from "react";
import { collection, onSnapshot, query, doc, setDoc, deleteDoc, getDocs } from "firebase/firestore";
import { db } from "../lib/firebase.js";

// Synkroniserer en Firestore-collection som et almindeligt array-of-objects (hvert objekt
// har et "id"-felt = dokument-id'et) — og opfører sig udadtil PRÆCIS som useState([...]):
//   const [invitations, setInvitations] = useFirestoreCollection("invitations");
//   setInvitations(prev => [...prev, nyForespørgsel])   // virker som før
//   setInvitations(prev => prev.filter(i => i.id !== x)) // virker som før
//
// Under motorhjelmen: al læsning sker realtime via onSnapshot (så alle brugere ser hinandens
// ændringer med det samme), og setInvitations(fn) sammenligner "før" og "efter" og skriver kun
// de dokumenter der faktisk er tilføjet/ændret/slettet — ikke hele collection'en for hver ændring.
//
// queryConstraints (valgfrit): fx [where("createdById","==",uid)] for kun at hente egne dokumenter.
export function useFirestoreCollection(collectionName, queryConstraints = [], enabled = true) {
  const [items, setItems] = useState([]);
  const latestRef = useRef(items);
  latestRef.current = items;

  useEffect(() => {
    if (!enabled) { setItems([]); return; }
    const q = query(collection(db, collectionName), ...queryConstraints);
    const unsub = onSnapshot(q, (snap) => {
      const next = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      latestRef.current = next;
      setItems(next);
    }, (err) => {
      console.error(`Firestore-fejl (${collectionName}):`, err);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionName, enabled, JSON.stringify(queryConstraints.map((c) => c?._key ?? String(c)))]);

  // Returnerer et Promise<boolean> — true kun hvis ALLE deraf følgende skrivninger/sletninger blev
  // bekræftet af serveren (se samme mønster og begrundelse i useFirestoreDocState.js). De fleste
  // kaldssteder ignorerer bevidst dette, men submitCalendar() i App.jsx bruger det til at sikre at
  // "Indsend" ikke kan lykkes, hvis selve skrivningen til invitations-dokumentet reelt fejlede.
  const setItemsAndSync = useCallback((updater) => {
    const prev = latestRef.current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    latestRef.current = next;
    setItems(next);

    const prevIds = new Set(prev.map((x) => x.id));
    const nextIds = new Set(next.map((x) => x.id));
    const writes = [];

    // Slettede dokumenter
    for (const p of prev) {
      if (!nextIds.has(p.id)) {
        writes.push(deleteDoc(doc(db, collectionName, p.id)).then(() => true).catch((e) => { console.error("Sletning fejlede:", e); return false; }));
      }
    }
    // Nye/ændrede dokumenter (Set-objekter kan ikke gemmes direkte i Firestore, så de
    // konverteres til arrays her — hvert kald-sted i App.jsx håndterer selv sin egen form).
    for (const n of next) {
      const before = prev.find((p) => p.id === n.id);
      if (!before || JSON.stringify(before) !== JSON.stringify(n)) {
        const { id, ...data } = n;
        writes.push(setDoc(doc(db, collectionName, id), data).then(() => true).catch((e) => { console.error("Gem fejlede:", e); return false; }));
      }
    }
    return Promise.all(writes).then((results) => results.every(Boolean));
  }, [collectionName]);

  return [items, setItemsAndSync];
}

// Engangs-hentning (ikke realtime) — bruges kun hvor det er nødvendigt.
export async function fetchCollectionOnce(collectionName, queryConstraints = []) {
  const q = query(collection(db, collectionName), ...queryConstraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}