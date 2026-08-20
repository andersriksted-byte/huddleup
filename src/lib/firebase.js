// Firebase-initialisering (modular SDK v9+, npm-pakken "firebase" — ingen script-tags).
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

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
// VIGTIGT: Firestores egen holdbare (IndexedDB-baserede) lokale cache og skrive-kø er slået til her.
// Uden dette ligger en skrivning, der laves mens forbindelsen er væk (fx et kort udfald i
// mobilnettet), kun i browserfanens hukommelse — bliver fanen lukket eller lagt i baggrunden (meget
// almindeligt på en telefon, når man skifter app eller låser skærmen), FØR forbindelsen er tilbage,
// forsvinder skrivningen for altid uden fejl og uden advarsel. Det er præcis den slags stille tab af
// en spillers kalenderdata, der har været roden til gentagne "mine tider er væk"-fejl i denne app.
// MED dette slået til bliver en ventende skrivning i stedet gemt holdbart i telefonens/browserens
// egen lagring og sendt automatisk, næste gang appen åbnes med forbindelse igen — uanset om det er
// samme fane, en ny fane, eller efter en genstart af telefonen. persistentMultipleTabManager gør det
// sikkert at have appen åben i flere faner/vinduer på samme enhed samtidig.
//
// Dette redder IKKE en skrivning der bliver aktivt afvist af Firestore (fx forkerte adgangsregler)
// — den slags fejl vises i stedet tydeligt i appen via den røde fejlbjælke (se onError i
// useFirestoreDocState.js). De to rettelser dækker to forskellige fejltyper.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Genererer et nyt, unikt dokument-id i en given collection uden at skrive noget endnu.
// Bruges i stedet for de gamle lokale tællere (newId/newInvId/newFriendReqId), som ikke
// er sikre når flere brugere/enheder arbejder i appen samtidig.
import { collection, doc } from "firebase/firestore";
export const newDocId = (collectionName) => doc(collection(db, collectionName)).id;