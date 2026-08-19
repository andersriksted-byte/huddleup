# HuddleUp

HuddleUp er en app til at planlægge holdaktiviteter: spillere svarer på tilgængelighed, kaptajnen laver kampe/invitationer, og alt gemmes centralt så hele holdet ser det samme.

Projektet er bygget med **Vite + React**, bruger **Firebase Authentication** (Email/Password) til login, og gemmer alt data (spillere, invitationer, tilgængelighed, venner) i **Firestore**, så det er permanent og delt mellem alle brugere — ikke længere kun i browserens hukommelse.

---

## 1. Kom i gang lokalt

```bash
npm install
npm run dev
```

Åbn linket der vises i terminalen (typisk `http://localhost:5173`).

> Bemærk: appen kan ikke logge nogen ind eller vise/gemme data, før Firebase-opsætningen nedenfor (afsnit 3) er lavet — selve koden er allerede sat op med dit projekts `firebaseConfig`, men Firebase-projektet skal aktiveres for Auth og Firestore skal have sine sikkerhedsregler.

## 2. Byg til produktion

```bash
npm run build
```

Dette laver en færdig, statisk version af sitet i mappen `dist/`. Du kan se den lokalt med:

```bash
npm run preview
```

## 3. Firebase-opsætning (skal gøres én gang)

Appens `firebaseConfig` (i `src/lib/firebase.js`) peger allerede på dit Firebase-projekt (`huddleup-bb710`). Der er to ting du skal slå til i [Firebase Console](https://console.firebase.google.com/):

1. **Aktivér Email/Password-login**
   Gå til *Build → Authentication → Sign-in method* → aktivér **Email/Password**.

2. **Opret Firestore-databasen og upload sikkerhedsreglerne**
   Gå til *Build → Firestore Database* → opret databasen (hvis den ikke findes endnu, vælg produktionstilstand).
   Kopiér indholdet af filen `firestore.rules` (i roden af dette projekt) ind under *Firestore Database → Rules* i konsollen, og klik **Publicér**. Disse regler sikrer bl.a. at brugere kun kan redigere deres egen profil, men at hele holdet kan læse/skrive delte data som tilgængelighed og invitationer (samme model som appen allerede brugte).

Det er alt — der skal ikke oprettes Cloud Functions eller tilføjes betalingskort til dette (se afsnit 5 om mail).

## 4. Deploy til GitHub Pages

Projektet er sat op til **automatisk deploy via GitHub Actions** — hver gang du pusher til `main`, bygges og udgives sitet automatisk.

**Første gang:**

1. Opret et nyt, tomt repository på GitHub, som skal hedde **`huddleup`** (præcis dette navn — `vite.config.js` har `base: "/huddleup/"`, som skal matche repo-navnet, for at billeder/scripts kan findes på GitHub Pages. Hedder dit repo noget andet, så ret `base` i `vite.config.js` til `/dit-repo-navn/` først).

2. Push dette projekt op:
   ```bash
   git init
   git add .
   git commit -m "Første version af HuddleUp"
   git branch -M main
   git remote add origin https://github.com/DIT-BRUGERNAVN/huddleup.git
   git push -u origin main
   ```

3. Gå til repoet på GitHub → **Settings → Pages** → under *Build and deployment* skal *Source* sættes til **GitHub Actions** (ikke "Deploy from a branch").

4. Gå til fanen **Actions** i repoet — workflowet "Deploy til GitHub Pages" starter automatisk og bygger/udgiver sitet. Efter et minuts tid er sitet klar på:
   `https://DIT-BRUGERNAVN.github.io/huddleup/`

**Efterfølgende opdateringer:** bare push til `main` — GitHub Actions bygger og opdaterer sitet automatisk hver gang.

*(Alternativ manuel metode, hvis du hellere vil deploye uden GitHub Actions: `npm run deploy` bruger `gh-pages`-pakken til at bygge og pushe `dist/`-mappen direkte til en `gh-pages`-branch. Så skal Pages-kilden i stedet sættes til "Deploy from a branch" → `gh-pages`.)*

## 5. E-mail (invitationer af nye spillere)

Firebase Auth sender selv "glemt adgangskode"-mails uden yderligere opsætning.

Men når en kaptajn inviterer en helt ny spiller (som endnu ikke har en konto), skal appen sende en almindelig e-mail med et link til at oprette sig — det er der ikke noget indbygget i Firebase til fra en ren klient-app uden server. Til det bruger appen **EmailJS**, fordi:

- Firebase Cloud Functions kunne også løse det, men kræver **Blaze-planen** (betalingsplan) og et betalingskort på Firebase-projektet, selv hvis man aldrig kommer over gratis-kvoten.
- EmailJS kører **helt fra browseren**, har en gratis plan (ca. 200 mails/måned), og kræver ikke server, backend eller betalingskort — perfekt til et statisk site på GitHub Pages.

Koden er allerede sat op til at bruge EmailJS (`src/lib/emailjs.js`), men med **pladsholder-værdier**, da du endnu ikke har en EmailJS-konto. Sådan aktiverer du det:

1. Opret en gratis konto på [emailjs.com](https://www.emailjs.com/).
2. Opret en **Email Service** (fx forbundet til din egen Gmail) → du får et **Service ID**.
3. Opret en **Email Template** med disse variabler i skabelonen: `to_email`, `to_name`, `from_name`, `invitation_title`, `signup_url` → du får et **Template ID**.
4. Find din **Public Key** under *Account → API Keys*.
5. Åbn `src/lib/emailjs.js` og udskift de tre pladsholder-konstanter øverst i filen med dine egne værdier:
   ```js
   export const EMAILJS_SERVICE_ID = "dit_service_id";
   export const EMAILJS_TEMPLATE_ID = "dit_template_id";
   export const EMAILJS_PUBLIC_KEY = "din_public_key";
   ```
6. Byg og deploy igen (`git push`, eller `npm run build` hvis du deployer manuelt).

Indtil disse er udfyldt, vil "Inviter en ny spiller" vise en tydelig fejl om at EmailJS ikke er sat op endnu — resten af appen fungerer upåvirket.

---

## Vigtige ændringer i forhold til den gamle prototype

Appen er lavet om fra en ren frontend-demo (med fup-login og data der forsvandt ved genindlæsning) til en rigtig, delt app. Et par ting er derfor bevidst ændret undervejs — værd at kende til:

- **"Log ind som en spiller" (impersonation) er fjernet.** Den fandtes i den gamle kode, men blev reelt aldrig brugt — appens rigtige funktioner til "hjælp en holdkammerat med at udfylde kalenderen" og "udfyld din egen kalender" virker præcis som før, de brugte bare aldrig denne mekanisme i praksis. Med rigtig Firebase-login er det desuden ikke teknisk muligt for en klient-app at logge ind som en anden bruger uden en server, så den blev fjernet helt.
- **At invitere en helt ny spiller opretter ikke længere en konto med det samme.** Der bliver i stedet sendt en rigtig e-mail med et link til at oprette sig selv (se afsnit 5). Når personen opretter sig med den e-mailadresse, bliver vedkommende automatisk tilføjet som ven og til den invitation, de blev inviteret til.
- **Tvungen adgangskode-skift ved "første login" er fjernet** — med rigtigt login vælger man selv sin adgangskode med det samme, når man opretter sin konto.
- **E-mailadressen kan ikke længere redigeres i profilen** — den er nu bundet til selve login-kontoen hos Firebase.
