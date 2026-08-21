import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  CalendarClock, ChevronRight, ChevronLeft, RefreshCw,
  CheckCircle2, Info, Users, Sparkles, UserPlus,
  Trash2, Send, Bell, X, Calendar, ChevronDown,
  Lock, Eye, EyeOff, LogOut, LogIn, Key, Copy, Shield, Edit2, Check, User, Download, FileSpreadsheet, FileText, MoreVertical,
  Mail, ArrowLeft, RotateCcw, AlertTriangle
} from "lucide-react";
import { where, doc, setDoc, updateDoc, deleteDoc, getDocs, collection, query as fsQuery, arrayUnion, arrayRemove, deleteField } from "firebase/firestore";
import { db, newDocId } from "./lib/firebase.js";
import { useAuth } from "./hooks/useAuth.js";
import { useFirestoreCollection } from "./hooks/useFirestoreCollection.js";
import {
  useFirestoreDocState, useFirestorePartitionedMap,
  setItemToFirestore, setItemFromFirestore,
  setToFirestore, setFromFirestore, plainMapToFirestore, plainMapFromFirestore,
  listToFirestore, listFromFirestore,
} from "./hooks/useFirestoreDocState.js";
import { resizeImageToDataURL } from "./lib/image.js";
import { sendInviteEmail, isEmailJsConfigured } from "./lib/emailjs.js";

/* ═══════════════════════════════════════════════════════════
   HJÆLPERE
═══════════════════════════════════════════════════════════ */
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtShort = (d) => `${d.getDate()}. ${MONTHS[d.getMonth()]}`;
const slotKey = (iso, blk) => `${iso}|${blk}`;
// Nøgle til "state/availability" (se useFirestorePartitionedMap): kalendermarkeringer er unikke
// PR. HUDDLE-FORESPØRGSEL OG SPILLER — at markere/afmarkere en tid på én forespørgsel må aldrig
// kunne ses eller ændre noget på en anden forespørgsel, heller ikke selvom deres perioder
// overlapper. Kun "faste ugentlige tider" (se "templates", som fortsat er pr. spiller alene) er
// beregnet til at blive genbrugt på tværs af forespørgsler — og det sker udelukkende ved et
// aktivt tryk på "Udfyld alle xx uger", som kopierer skabelonen ned i netop den valgte
// forespørgsels egne markeringer. Uden en valgt forespørgsel (fx det fritstående "Kalender"-view
// når man ikke har nogen aktiv forespørgsel) bruges "_none" som nøgle.
const availKey = (invitationId, playerId) => `${invitationId || "_none"}:${playerId}`;

function mondayOf(d) {
  const x = new Date(d); const j = x.getDay();
  x.setDate(x.getDate() + (j===0?-6:1-j)); x.setHours(0,0,0,0); return x;
}
function blockLabel(b) { const h=parseInt(b.slice(0,2),10); return `${b}–${pad((h+1)%24)}:00`; }
function getISOWeek(d) {
  const dt=new Date(d); dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate()+3-((dt.getDay()+6)%7));
  const w1=new Date(dt.getFullYear(),0,4);
  return 1+Math.round(((dt-w1)/864e5-3+(w1.getDay()+6)%7)/7);
}
/* ═══════════════════════════════════════════════════════════
   KONSTANTER
═══════════════════════════════════════════════════════════ */
const DAY_KEYS=["Man","Tir","Ons","Tor","Fre","Lør","Søn"];
const WD_FULL=["Mandag","Tirsdag","Onsdag","Torsdag","Fredag","Lørdag","Søndag"];
const MONTHS=["jan.","feb.","mar.","apr.","maj","jun.","jul.","aug.","sep.","okt.","nov.","dec."];
const MONTHS_FULL=["Januar","Februar","Marts","April","Maj","Juni","Juli","August","September","Oktober","November","December"];
const BLOCKS=Array.from({length:15},(_,i)=>`${pad(8+i)}:00`);
const HORIZON_WEEKS=26;

const initials=(name)=>{const p=(name||"").trim().split(/\s+/).filter(Boolean);return !p.length?"?":(p.length===1?p[0][0]:p[0][0]+p[p.length-1][0]).toUpperCase();};
// Fælles indhold til en profilcirkel: profilbillede > emoji > initialer. Bruges alle steder hvor
// en spillers navn vises sammen med en rund profilcirkel, så billede/emoji altid slår igennem.
function avatarContent(pl){
  if(!pl)return "?";
  if(pl.avatarImage)return <img src={pl.avatarImage} alt="" className="w-full h-full object-cover"/>;
  if(pl.avatarEmoji)return <span>{pl.avatarEmoji}</span>;
  return initials(pl.name);
}
function bestSlots(avail,players,baseMonday,today,threshold){
  const pids=players.map(p=>p.id),out=[];
  for(let w=0;w<HORIZON_WEEKS;w++)for(let i=0;i<7;i++){
    const d=new Date(baseMonday);d.setDate(d.getDate()+w*7+i);
    const iso=isoDate(d);if(iso<isoDate(today))continue;
    for(const b of BLOCKS){const c=pids.filter(pid=>avail[pid]?.has(slotKey(iso,b))).length;if(c>=threshold)out.push({iso,date:new Date(d),wd:i,block:b,count:c});}
  }
  return out.sort((a,b)=>a.iso<b.iso?-1:a.iso>b.iso?1:a.block.localeCompare(b.block));
}
// Finder tider hvor mindst 'threshold' spillere kan sammenhængende i 'hours' timer i træk
function bestConsecutiveSlots(avail,players,baseMonday,today,threshold,hours,startIso,endIso){
  const pids=players.map(p=>p.id),out=[];
  for(let w=0;w<HORIZON_WEEKS;w++)for(let i=0;i<7;i++){
    const d=new Date(baseMonday);d.setDate(d.getDate()+w*7+i);
    const iso=isoDate(d);
    if(iso<isoDate(today))continue;
    if(startIso&&iso<startIso)continue;
    if(endIso&&iso>endIso)continue;
    const di=(d.getDay()+6)%7;
    for(let bi=0;bi<=BLOCKS.length-hours;bi++){
      const run=BLOCKS.slice(bi,bi+hours);
      const can=pids.filter(pid=>run.every(b=>avail[pid]?.has(slotKey(iso,b))));
      if(can.length>=threshold)out.push({iso,date:new Date(d),wd:di,startBlock:BLOCKS[bi],hours,count:can.length,players:can});
    }
  }
  return out.sort((a,b)=>a.iso<b.iso?-1:a.iso>b.iso?1:a.startBlock.localeCompare(b.startBlock));
}
function rangeLabel(startBlock,hours){
  const h=parseInt(startBlock.slice(0,2),10);
  return `${startBlock}–${pad((h+hours)%24)}:00`;
}
// Status for en given spillers respons på en forespørgsel: "pending" | "accepted" | "declined" | null (ikke inviteret).
// Forespørgsler oprettet før dette felt fandtes (eller uden eksplicit status) antages accepteret, så gammel data ikke går i stykker.
function fmtSubmittedAt(iso){
  if(!iso)return"";
  const d=new Date(iso);
  return `d. ${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getFullYear()} kl. ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}
// Fælles metadata-linjer under en forespørgsels/kladdes titel — bruges både af det fulde
// forespørgselskort og af kladdelisten, så de to ser eksakt ens ud. Felter der ikke er sat endnu
// (fx en kladde uden svarfrist) beholder deres label, blot uden værdi efter kolonet — linjen
// forsvinder ikke, og hvert "Label: værdi"-par knækker aldrig midt i teksten (whitespace-nowrap).
function ReqMeta({item,pendingInviteCount=0}){
  const minPlayers=item.minPlayers;
  const consecHours=item.consecHours||1;
  // Kladder har endnu ikke spillere med et reelt svar-/indsendelsesstatus (de felter findes kun
  // på en forespørgsel, der faktisk er afsendt — se "status:'active'" i sendInvitation) — så
  // badges for accept/indsendelse vises kun for rigtige, afsendte forespørgsler.
  const isSentInvitation=item.status==="active";
  // "Inviteret i alt" tæller også folk, der endnu ikke har en konto og derfor stadig kun findes
  // som en afventende mail-invitation (se pendingInviteCount/myPendingInvitesForThis) — ellers
  // ville brevet fx vise "2/2" i stedet for det reelle "2/10", indtil alle otte har oprettet sig.
  const total=(item.playerIds?.length||0)+pendingInviteCount;
  const acceptedCount=isSentInvitation?(item.playerIds||[]).filter(id=>responseFor(item,id)==="accepted").length:0;
  // Indsendelse kan kun ske EFTER accept — så den tælles ud af dem der har accepteret, ikke ud
  // af alle inviterede (se "Indsendelser"-blokken inde på selve kortet, som bruger samme logik).
  const submittedCount=isSentInvitation?(item.submittedIds||[]).length:0;
  return(
    <>
      <div className="text-xs text-slate-400 mt-0.5">Oprettet af {item.createdByName||"ukendt"}</div>
      {/* Hver "Label: værdi ·"-enhed er ét whitespace-nowrap-stykke, inkl. den efterfølgende skilletegn.
          Det sikrer at en linje aldrig knækker med et forældreløst "·" forrest — hver ombrudt linje
          starter altid med selve label-teksten, helt venstrejusteret. */}
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs text-slate-500 mt-1.5">
        <span className="whitespace-nowrap">Periode: <span className="font-medium text-slate-800">{item.startIso?fmtShort(new Date(item.startIso)):""}{item.startIso||item.endIso?"–":""}{item.endIso?fmtShort(new Date(item.endIso)):""}</span> <span className="text-slate-300">·</span></span>
        <span className="whitespace-nowrap">Svarfrist: <span className="font-medium text-slate-800">{item.submitDeadline?fmtShort(new Date(item.submitDeadline)):""}</span> <span className="text-slate-300">·</span></span>
        <span className="whitespace-nowrap">Planlægning afsluttes: <span className="font-medium text-slate-800">{item.deadline?fmtShort(new Date(item.deadline)):""}</span> <span className="text-slate-300">·</span></span>
        <span className="whitespace-nowrap">Krav: <span className="font-medium text-slate-800">{minPlayers?`min. ${minPlayers} spillere, ${consecHours} time${consecHours===1?"":"r"} i træk`:""}</span></span>
      </div>
      {isSentInvitation&&total>0&&(
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5" title={`${acceptedCount} af ${total} inviterede har accepteret invitationen`}>
            <Mail size={11}/> {acceptedCount}/{total}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5" title={`${submittedCount} af ${acceptedCount} der har accepteret, har indsendt deres tider`}>
            <Send size={11}/> {submittedCount}/{acceptedCount}
          </span>
        </div>
      )}
    </>
  );
}
function responseFor(inv,playerId){
  if(!inv||!playerId||!inv.playerIds?.includes(playerId))return null;
  return inv.responses?.[playerId]||"accepted";
}
// Man kan komme til at have flere "invites"-dokumenter for samme e-mail (fx hvis man sender en
// invitation igen). De skal kun vises som ÉT afventende kort — vi beholder den seneste.
function dedupeInvitesByEmail(list){
  const byEmail=new Map();
  for(const iv of list||[]){
    const key=(iv.email||"").trim().toLowerCase();
    const existing=byEmail.get(key);
    if(!existing||(iv.createdAt||"")>(existing.createdAt||""))byEmail.set(key,iv);
  }
  return[...byEmail.values()];
}
// Linket i invitations-mailen skal pege direkte på opret-profil-siden, MED den e-mailadresse
// invitationen blev sendt til — ellers risikerer man at personen opretter sig med en anden
// e-mail end den, kaptajnen inviterede, og så bliver de aldrig automatisk koblet til hverken
// venskabet eller selve huddlen (se handleSignup i App() og LoginScreen's låste e-mail-felt).
//
// Men e-mailen er kun det ene lag af beskyttelse — den anden, vigtigere del er "huddle"-param'en
// herunder: den bærer selve invitations-ID'et (fra "invitations"-collection'en), så linket peger
// direkte på FORESPØRGSLEN, ikke bare på en e-mailadresse. Selvom personen skulle finde på at
// oprette sin profil med en helt anden e-mail end den inviterede, kan handleSignup i App() stadig
// finde og tilknytte den rigtige huddle via dette ID (se dér for detaljerne).
function buildSignupUrl(email,name,invitationId){
  const base=`${window.location.origin}${import.meta.env.BASE_URL}`;
  const params=new URLSearchParams({invite:email||""});
  if(name)params.set("name",name);
  if(invitationId)params.set("huddle",invitationId);
  return`${base}?${params.toString()}`;
}

/* ═══════════════════════════════════════════════════════════
   DELTE KALENDAR-KOMPONENTER
═══════════════════════════════════════════════════════════ */
// Når man bladrer uge for uge gennem en afgrænset periode (fx en huddles 13 uger), viser denne
// en lille proceslinje — én blok pr. uge i perioden — så det er tydeligt hvor langt man er, i
// stedet for at det føles som endeløs scrolling. minWeek/maxWeek er valgfrie: er de ikke sat
// (fri browsing uden en bestemt periode), vises linjen slet ikke.
function WeekProgress({weekOffset,setWeekOffset,minWeek,maxWeek}){
  if(minWeek==null||maxWeek==null||maxWeek<minWeek)return null;
  const total=maxWeek-minWeek+1;
  const currentIdx=Math.min(Math.max(weekOffset,minWeek),maxWeek)-minWeek;
  return(
    <div className="mb-2.5">
      <div className="text-[10px] text-slate-400 font-medium mb-1 text-center">Uge {currentIdx+1} af {total}</div>
      <div className="flex gap-0.5">
        {Array.from({length:total},(_,i)=>{
          const w=minWeek+i;
          const isCurrent=i===currentIdx;
          const isDone=i<currentIdx;
          return(
            <button key={w} type="button" onClick={()=>setWeekOffset(w)} title={`Uge ${i+1} af ${total}`}
              className={`flex-1 h-1.5 rounded-full transition-colors ${isCurrent?"bg-blue-700":isDone?"bg-blue-300":"bg-slate-200 hover:bg-slate-300"}`}/>
          );
        })}
      </div>
    </div>
  );
}
function WeekNav({weekOffset,setWeekOffset,weekDates,minWeek,maxWeek}){
  const ws=weekDates[0],we=weekDates[6];
  return(
    <div className="mb-2">
      <WeekProgress weekOffset={weekOffset} setWeekOffset={setWeekOffset} minWeek={minWeek} maxWeek={maxWeek}/>
      <div className="flex items-center justify-between gap-2">
        <button onClick={()=>setWeekOffset(o=>Math.max(0,o-1))} disabled={weekOffset===0}
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 disabled:opacity-30 hover:bg-slate-100 rounded-lg px-2.5 py-1.5">
          <ChevronLeft size={16}/> Forrige
        </button>
        <div className="text-center">
          <div className="text-sm font-bold text-blue-900">{fmtShort(ws)} – {fmtShort(we)}</div>
          <div className="text-xs text-slate-400">Uge {getISOWeek(ws)}{weekOffset===0?" · denne uge":""}</div>
        </div>
        <button onClick={()=>setWeekOffset(o=>Math.min(HORIZON_WEEKS-1,o+1))} disabled={weekOffset===HORIZON_WEEKS-1}
          className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 disabled:opacity-30 hover:bg-slate-100 rounded-lg px-2.5 py-1.5">
          Næste <ChevronRight size={16}/>
        </button>
      </div>
    </div>
  );
}
function WeekBar({perWeek,weekOffset,setWeekOffset}){
  const max=Math.max(...perWeek.map(x=>x.count),1);
  return(
    <div>
      <div className="flex items-end gap-0.5" style={{height:44}}>
        {perWeek.map(({w,count,start})=>{
          const h=Math.round((count/max)*100),active=w===weekOffset;
          return(<button key={w} onClick={()=>setWeekOffset(w)} title={`Uge ${getISOWeek(start)} · ${fmtShort(start)}`}
            className="flex-1 flex flex-col items-center justify-end group" style={{height:"100%"}}>
            <div className={`w-full rounded-t transition-colors ${count?(active?"bg-blue-700":"bg-lime-400 group-hover:bg-lime-500"):(active?"bg-blue-200":"bg-slate-100 group-hover:bg-slate-200")}`}
              style={{height:`${Math.max(count?6:2,h)}%`}}/>
          </button>);
        })}
      </div>
      <div className="flex gap-0.5 mt-0.5">
        {perWeek.map(({w,start})=>(
          <div key={w} className="flex-1 text-center">
            {w%3===0&&<span className="text-[9px] text-slate-400">U{getISOWeek(start)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LOGIN-SKÆRM
═══════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   HUDDLEUP-LOGO — vektorgengivelse af logoet (tre kalendere,
   den forreste med blåt flueben). Farverne kan tilpasses
   baggrunden via props (fx lys variant til mørk login-baggrund).
═══════════════════════════════════════════════════════════ */
function LogoIcon({size=36,front="#32376E",back="#9BA5E3",checkFill="#0229B8",check="#ffffff"}){
  return(
    <svg width={size} height={size} viewBox="0 0 104 104" fill="none" aria-hidden="true">
      {/* Bagvedliggende, drejede kalendere */}
      <g stroke={back} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" fill="none">
        <g transform="rotate(-14 36 64)">
          <rect x="8" y="32" width="56" height="58" rx="13"/>
          <line x1="8" y1="50" x2="64" y2="50"/>
          <line x1="22" y1="26" x2="22" y2="40"/>
          <line x1="50" y1="26" x2="50" y2="40"/>
        </g>
        <g transform="rotate(11 68 64)">
          <rect x="40" y="34" width="56" height="58" rx="13"/>
          <line x1="40" y1="52" x2="96" y2="52"/>
          <line x1="54" y1="28" x2="54" y2="42"/>
          <line x1="82" y1="28" x2="82" y2="42"/>
        </g>
      </g>
      {/* Forreste kalender */}
      <g stroke={front} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <rect x="24" y="14" width="58" height="62" rx="14"/>
        <line x1="24" y1="33" x2="82" y2="33"/>
        <line x1="38" y1="6" x2="38" y2="21"/>
        <line x1="68" y1="6" x2="68" y2="21"/>
      </g>
      {/* Blåt felt med flueben */}
      <rect x="39" y="42" width="28" height="26" rx="8" fill={checkFill}/>
      <path d="M45.5 55 l5.5 5.5 L61.5 49" stroke={check} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════
   VILKÅR OG PRIVATLIVSPOLITIK — vises som en side/modal man kan
   linke til fra "betingelser"/"privatlivspolitik" ved oprettelse.
   NB: Dette er et redaktionelt udgangspunkt (skabelon) og ikke juridisk
   rådgivning — indholdet bør gennemgås af en jurist og tilpasses den
   dataansvarlige virksomheds reelle navn, CVR, kontaktoplysninger m.v.,
   før det bruges i en rigtig, driftsat udgave af HuddleUp.
═══════════════════════════════════════════════════════════ */
function TermsModal({onClose}){
  const [section,setSection]=useState("vilkaar"); // vilkaar | privatliv
  return(
    <div className="fixed inset-0 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-6 z-50 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-2xl my-4 sm:my-0 shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3 border-b border-slate-100 shrink-0">
          <div>
            <div className="text-lg font-bold text-slate-800">Vilkår og privatliv</div>
            <div className="text-xs text-slate-400">Sidst opdateret 19. august 2026</div>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg shrink-0"><X size={18}/></button>
        </div>
        <div className="flex gap-1.5 px-5 pt-3 shrink-0">
          <button onClick={()=>setSection("vilkaar")}
            className={`text-xs font-semibold rounded-lg px-3 py-1.5 transition-colors ${section==="vilkaar"?"bg-blue-700 text-white":"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>Vilkår for brug</button>
          <button onClick={()=>setSection("privatliv")}
            className={`text-xs font-semibold rounded-lg px-3 py-1.5 transition-colors ${section==="privatliv"?"bg-blue-700 text-white":"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>Privatlivspolitik</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto text-sm text-slate-700 space-y-4 leading-relaxed">
          {section==="vilkaar"?(
            <>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Dette er et redaktionelt udgangspunkt til brug for demoen og bør gennemgås af en jurist og tilpasses jeres konkrete forhold, før det anvendes i en driftsat udgave.
              </p>
              <div>
                <div className="font-semibold text-slate-800 mb-1">1. Om tjenesten</div>
                <p>HuddleUp ("Tjenesten") er en webbaseret løsning, der hjælper hold og deres spillere med at koordinere tilgængelighed og fastlægge spilletider. Tjenesten stilles til rådighed af den dataansvarlige virksomhed, jf. Privatlivspolitikken.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">2. Din profil</div>
                <p>For at bruge Tjenesten skal du oprette en profil med navn, e-mailadresse og adgangskode. Du er ansvarlig for at holde dine loginoplysninger fortrolige og for al aktivitet, der sker via din profil. Kontakt os straks, hvis du har mistanke om, at nogen uberettiget har fået adgang til din profil.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">3. Tilladt brug</div>
                <p>Tjenesten må kun bruges til lovlige formål og i overensstemmelse med disse vilkår. Du må ikke: (a) give urigtige oplysninger om dig selv, (b) oprette eller invitere personer uden deres samtykke til at optræde med navn og kontaktoplysninger, (c) forsøge at skaffe dig uautoriseret adgang til andre brugeres data, eller (d) bruge Tjenesten til at sende uønsket markedsføring eller skadelig kode.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">4. Indhold du deler</div>
                <p>Når du opretter en forespørgsel, udfylder din kalender eller uploader et profilbillede, deles disse oplysninger med de øvrige spillere, der er inviteret til den pågældende forespørgsel. Del kun oplysninger, du er indforstået med at dine holdkammerater kan se.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">5. Immaterielle rettigheder</div>
                <p>Tjenestens design, kildekode, logo og indhold (bortset fra det, brugerne selv uploader) tilhører den dataansvarlige virksomhed eller dennes licensgivere og må ikke kopieres eller genbruges uden forudgående skriftligt samtykke.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">6. Ansvarsfraskrivelse</div>
                <p>Tjenesten stilles til rådighed "som den er og forefindes". Vi tilstræber høj oppetid og driftssikkerhed, men kan ikke garantere fejlfri eller uafbrudt drift, og påtager os intet ansvar for tab, der måtte opstå som følge af aflyste eller forkert planlagte kampe.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">7. Opsigelse og sletning af profil</div>
                <p>Du kan til enhver tid anmode om at få din profil og tilhørende personoplysninger slettet, jf. Privatlivspolitikken. Vi forbeholder os retten til at lukke profiler, der misbruger Tjenesten eller overtræder disse vilkår.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">8. Ændringer</div>
                <p>Vi kan opdatere disse vilkår løbende. Væsentlige ændringer vil blive kommunikeret til dig, f.eks. ved næste login. Fortsat brug af Tjenesten efter en ændring udgør accept af de opdaterede vilkår.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">9. Lovvalg og værneting</div>
                <p>Disse vilkår er underlagt dansk ret. Eventuelle tvister søges løst i mindelighed; kan dette ikke lade sig gøre, anlægges sag ved de danske domstole.</p>
              </div>
            </>
          ):(
            <>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Dette er et redaktionelt udgangspunkt til brug for demoen og bør gennemgås af en jurist og tilpasses jeres konkrete databehandling, før det anvendes i en driftsat udgave.
              </p>
              <div>
                <div className="font-semibold text-slate-800 mb-1">1. Dataansvarlig</div>
                <p>Den dataansvarlige for behandlingen af dine personoplysninger i HuddleUp er den virksomhed, der driver Tjenesten. Kontaktoplysninger på den dataansvarlige og en eventuel databeskyttelsesrådgiver findes på vores kontaktside eller kan oplyses ved henvendelse.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">2. Hvilke oplysninger indsamler vi</div>
                <p>Vi behandler de oplysninger, du selv afgiver ved oprettelse og brug af Tjenesten: navn, e-mailadresse, evt. telefonnummer, adgangskode (krypteret), samt de tidspunkter du angiver, at du kan spille (tilgængeligheds-/kalenderdata). Uploader du et profilbillede, behandler vi også dette. Vi indsamler ikke oplysninger om dig fra andre kilder end dig selv og de holdkammerater, der inviterer dig.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">3. Formål og retsgrundlag</div>
                <p>Vi behandler dine oplysninger for at kunne levere Tjenesten til dig — herunder oprette og administrere din profil, koordinere forespørgsler og kampe med dit hold, samt sende dig relevante notifikationer om forespørgsler, du er en del af. Retsgrundlaget er databeskyttelsesforordningens artikel 6, stk. 1, litra b (opfyldelse af aftalen om brug af Tjenesten) og, hvor relevant, litra f (vores legitime interesse i at drive og forbedre Tjenesten). Er der tale om følsomme oplysninger eller billeder af mindreårige, behandles disse alene på baggrund af samtykke, jf. artikel 6, stk. 1, litra a og artikel 9.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">4. Hvem deler vi oplysninger med</div>
                <p>Dit navn, din tilgængelighed og dine svar på en forespørgsel deles med de øvrige spillere, der er inviteret til samme forespørgsel — det er en forudsætning for, at holdet kan planlægge kampe sammen. Vi videregiver ikke dine oplysninger til tredjepart med henblik på markedsføring, og vi sælger ikke dine data. Vi kan anvende databehandlere (f.eks. hosting- og driftsleverandører) til at understøtte driften af Tjenesten; disse behandler udelukkende oplysningerne efter vores instruks og under en databehandleraftale, jf. artikel 28.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">5. Opbevaring</div>
                <p>Vi opbevarer dine oplysninger, så længe din profil er aktiv, og i det omfang det er nødvendigt for at opfylde de formål, oplysningerne er indsamlet til. Anmoder du om sletning af din profil, sletter eller anonymiserer vi dine personoplysninger, medmindre vi er forpligtet eller berettiget til at opbevare dem længere, f.eks. efter bogføringsloven.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">6. Dine rettigheder</div>
                <p>Du har efter databeskyttelsesforordningen ret til bl.a. at få indsigt i de oplysninger, vi behandler om dig, få urigtige oplysninger rettet, få dine oplysninger slettet eller behandlingen begrænset, gøre indsigelse mod behandlingen, samt modtage dine oplysninger i et almindeligt anvendt format (dataportabilitet). Du kan til enhver tid trække et afgivet samtykke tilbage. Henvend dig til den dataansvarlige for at gøre brug af dine rettigheder. Du kan desuden klage til Datatilsynet, www.datatilsynet.dk.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">7. Sikkerhed</div>
                <p>Vi har gennemført passende tekniske og organisatoriske sikkerhedsforanstaltninger for at beskytte dine oplysninger mod uautoriseret adgang, tab eller misbrug, herunder kryptering af adgangskoder og begrænset adgang til data på et need-to-know-princip.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">8. Cookies og lignende teknologier</div>
                <p>Tjenesten anvender kun teknisk nødvendige cookies/lokal lagring, der er påkrævet for at holde dig logget ind og huske dine indstillinger. Vi anvender ikke cookies til markedsføring eller tredjeparts sporing.</p>
              </div>
              <div>
                <div className="font-semibold text-slate-800 mb-1">9. Kontakt</div>
                <p>Har du spørgsmål til denne privatlivspolitik eller ønsker at gøre brug af dine rettigheder, kan du kontakte os via kontaktoplysningerne på vores hjemmeside.</p>
              </div>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 shrink-0">
          <button onClick={onClose} className="w-full bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-xl py-2.5">Luk</button>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({onLogin,onSignup,onResetPassword}){
  // Kommer man hertil via et invitations-link (se buildSignupUrl), står den e-mail invitationen
  // blev sendt til i URL'en (?invite=...&name=...&huddle=...). Den læses ÉN gang ved indlæsning —
  // ikke i en effekt, da vi kun skal bruge den til at forudfylde/låse formularen med det samme,
  // ikke følge med efterfølgende URL-ændringer. "huddle" er selve invitations-ID'et — det er DEN
  // der binder linket til den rigtige forespørgsel, uanset hvilken e-mail personen ender med at
  // oprette sin profil med (se buildSignupUrl og handleSignup i App() for hvordan det bruges).
  const inviteParams=useState(()=>{
    const p=new URLSearchParams(window.location.search);
    const inviteEmail=(p.get("invite")||"").trim();
    const huddleId=(p.get("huddle")||"").trim();
    return inviteEmail?{email:inviteEmail,name:(p.get("name")||"").trim(),huddleId:huddleId||null}:null;
  })[0];

  // login | signup-form | signup-complete | forgot-form | forgot-sent
  // "signup-sent"/"forgot-reset" (demo-only bekræftelses-genveje) er væk — Firebase Auth
  // klarer selv e-mailbekræftelse og nulstillings-links via rigtige mails.
  const [mode,setMode]=useState(inviteParams?"signup-form":"login");
  const [email,setEmail]=useState("");
  const [pw,setPw]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [err,setErr]=useState("");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [showTerms,setShowTerms]=useState(false);

  const emailValid=(e)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e||"").trim());

  // Oversætter Firebase Auth's engelske fejlkoder til en kort dansk besked.
  const authErrMsg=(e)=>{
    const code=e?.code||"";
    if(code==="auth/invalid-credential"||code==="auth/wrong-password"||code==="auth/user-not-found")return"Forkert e-mail eller adgangskode.";
    if(code==="auth/email-already-in-use")return"Der findes allerede en profil med denne e-mailadresse.";
    if(code==="auth/weak-password")return"Adgangskoden skal have mindst 6 tegn.";
    if(code==="auth/invalid-email")return"Indtast en gyldig e-mailadresse.";
    if(code==="auth/too-many-requests")return"For mange forsøg — prøv igen om lidt.";
    return"Der skete en fejl. Prøv igen.";
  };

  const login=async()=>{
    if(busy)return;
    setErr("");setBusy(true);
    try{ await onLogin(email.trim(),pw); }
    catch(e){ setErr(authErrMsg(e)); }
    finally{ setBusy(false); }
  };

  // ── Opret profil ──
  const [signupName,setSignupName]=useState(inviteParams?.name||"");
  const [signupEmail,setSignupEmail]=useState(inviteParams?.email||"");
  const [signupErr,setSignupErr]=useState("");
  const startSignup=()=>{
    const name=signupName.trim(),em=signupEmail.trim();
    if(!name){setSignupErr("Indtast dit navn.");return;}
    if(!emailValid(em)){setSignupErr("Indtast en gyldig e-mailadresse.");return;}
    setSignupErr("");setMode("signup-complete");
  };
  const [signupPw,setSignupPw]=useState("");
  const [signupPwRep,setSignupPwRep]=useState("");
  const [signupPhone,setSignupPhone]=useState("");
  const [signupPwErr,setSignupPwErr]=useState("");
  const [signupAvatarEmoji,setSignupAvatarEmoji]=useState(null);
  const [signupAvatarImage,setSignupAvatarImage]=useState(null);
  const signupAvatarFileRef=useRef(null);
  const EMOJI_CHOICES=["😀","😎","🦁","⚡","🔥","🐺","🚀","🏆","🎯","🐧","🥅","🦊"];
  const handleSignupPhotoPick=async(file)=>{
    if(!file)return;
    setSignupAvatarImage(await resizeImageToDataURL(file));
    setSignupAvatarEmoji(null);
  };
  const finishSignup=async()=>{
    if(signupPw.length<6){setSignupPwErr("Adgangskoden skal have mindst 6 tegn.");return;}
    if(signupPw!==signupPwRep){setSignupPwErr("Adgangskoderne matcher ikke.");return;}
    setSignupPwErr("");setBusy(true);
    try{
      await onSignup({name:signupName.trim(),email:signupEmail.trim(),phone:signupPhone.trim(),password:signupPw,avatarEmoji:signupAvatarEmoji,avatarImage:signupAvatarImage,huddleId:inviteParams?.huddleId||null});
    }catch(e){ setSignupPwErr(authErrMsg(e)); }
    finally{ setBusy(false); }
  };

  // ── Glemt adgangskode — sendes af Firebase Auth selv (ægte mail, ægte link) ──
  const [forgotEmail,setForgotEmail]=useState("");
  const [forgotErr,setForgotErr]=useState("");
  const startForgot=async()=>{
    const em=forgotEmail.trim();
    if(!emailValid(em)){setForgotErr("Indtast en gyldig e-mailadresse.");return;}
    setForgotErr("");setBusy(true);
    try{ await onResetPassword(em); setMode("forgot-sent"); }
    catch(e){ setForgotErr(authErrMsg(e)); }
    finally{ setBusy(false); }
  };

  const resetAllFlows=()=>{
    setErr("");setNotice("");
    // Kommer man oprindeligt fra et invitations-link, skal navn/e-mail IKKE ryddes her — ellers
    // mister man låsningen, hvis man fx trykker "Tilbage til login" og så "Opret profil" igen.
    setSignupName(inviteParams?.name||"");setSignupEmail(inviteParams?.email||"");setSignupErr("");
    setSignupPw("");setSignupPwRep("");setSignupPhone("");setSignupPwErr("");setSignupAvatarEmoji(null);setSignupAvatarImage(null);
    setForgotEmail("");setForgotErr("");
  };
  const goto=(m)=>{resetAllFlows();setMode(m);};

  return(
    <div className="min-h-screen bg-gradient-to-br from-blue-950 to-blue-800 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        {/* Logo */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/10 mb-3">
            {/* Lys variant af logoet, tilpasset den mørke baggrund */}
            <LogoIcon size={44} front="#ffffff" back="#8fa3f0" checkFill="#3b82f6" check="#ffffff"/>
          </div>
          <h1 className="text-2xl font-bold text-white">HuddleUp</h1>
          <p className="text-blue-200 text-sm mt-1">
            {mode==="login"?"Log ind med din e-mail og adgangskode"
              :mode.startsWith("signup")?"Opret din profil"
              :"Nulstil din adgangskode"}
          </p>
        </div>

        {mode==="login"&&(
          <div className="bg-white rounded-2xl p-6 shadow-xl space-y-4">
            {notice&&<p className="text-xs text-lime-700 bg-lime-50 border border-lime-200 rounded-lg px-3 py-2 font-medium">{notice}</p>}
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">E-mailadresse</label>
              <input type="email" value={email} onChange={e=>{setEmail(e.target.value);setErr("");}}
                onKeyDown={e=>e.key==="Enter"&&login()}
                placeholder="eks. email@email.dk"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-semibold text-slate-500">Adgangskode</label>
                <button onClick={()=>goto("forgot-form")} className="text-xs text-blue-600 hover:underline font-medium">Glemt adgangskode?</button>
              </div>
              <div className="relative">
                <input type={showPw?"text":"password"} value={pw} onChange={e=>{setPw(e.target.value);setErr("");}}
                  onKeyDown={e=>e.key==="Enter"&&login()}
                  placeholder="••••••••"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                <button onClick={()=>setShowPw(v=>!v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showPw?<EyeOff size={16}/>:<Eye size={16}/>}
                </button>
              </div>
            </div>
            {err&&<p className="text-xs text-red-500 font-medium">{err}</p>}
            <button onClick={login} disabled={busy}
              className="w-full bg-blue-700 text-white font-semibold text-sm rounded-xl py-2.5 hover:bg-blue-800 disabled:opacity-60 transition-colors">
              {busy?"Logger ind…":"Log ind"}
            </button>
            <p className="text-xs text-slate-500 text-center pt-1">
              Har du ikke en profil endnu?{" "}
              <button onClick={()=>goto("signup-form")} className="text-blue-600 hover:underline font-medium">Opret profil</button>
            </p>
          </div>
        )}

        {mode==="signup-form"&&(
          <div className="bg-white rounded-2xl p-6 shadow-xl space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Navn</label>
              <input value={signupName} onChange={e=>{setSignupName(e.target.value);setSignupErr("");}}
                placeholder="Fornavn Efternavn"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">E-mailadresse</label>
              <input type="email" value={signupEmail} readOnly={!!inviteParams} disabled={!!inviteParams}
                onChange={e=>{if(inviteParams)return;setSignupEmail(e.target.value);setSignupErr("");}}
                onKeyDown={e=>e.key==="Enter"&&startSignup()}
                placeholder="eks. email@email.dk"
                className={`w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 ${inviteParams?"bg-slate-100 text-slate-500 cursor-not-allowed":""}`}/>
              {inviteParams&&<p className="text-[11px] text-slate-400 mt-1">Denne e-mail hører til invitationen og kan ikke ændres her.</p>}
            </div>
            {signupErr&&<p className="text-xs text-red-500 font-medium">{signupErr}</p>}
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Ved at oprette en profil accepterer du vores{" "}
              <button type="button" onClick={()=>setShowTerms(true)} className="text-blue-600 hover:underline font-medium">betingelser</button>
              {" "}og{" "}
              <button type="button" onClick={()=>setShowTerms(true)} className="text-blue-600 hover:underline font-medium">privatlivspolitik</button>.
            </p>
            <button onClick={startSignup}
              className="w-full bg-blue-700 text-white font-semibold text-sm rounded-xl py-2.5 hover:bg-blue-800 transition-colors">
              Opret
            </button>
            <button onClick={()=>goto("login")} className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 font-medium pt-1">
              <ArrowLeft size={12}/> Tilbage til login
            </button>
          </div>
        )}

        {showTerms&&<TermsModal onClose={()=>setShowTerms(false)}/>}

        {mode==="signup-complete"&&(
          <div className="bg-white rounded-2xl p-6 shadow-xl space-y-4">
            <p className="text-xs text-lime-700 bg-lime-50 border border-lime-200 rounded-lg px-3 py-2 font-medium flex items-center gap-1.5">
              <CheckCircle2 size={13}/> E-mailadresse bekræftet — fuldfør din profil
            </p>

            <div className="flex items-center gap-3">
              <button type="button" onClick={()=>signupAvatarFileRef.current&&signupAvatarFileRef.current.click()}
                className="w-12 h-12 rounded-xl grid place-items-center text-sm font-bold shrink-0 overflow-hidden bg-blue-700 text-white">
                {signupAvatarImage
                  ?<img src={signupAvatarImage} alt="" className="w-full h-full object-cover"/>
                  :signupAvatarEmoji
                    ?<span className="text-lg">{signupAvatarEmoji}</span>
                    :initials(signupName)}
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-800 truncate">{signupName.trim()}</div>
                <div className="text-xs text-slate-400 truncate">{signupEmail.trim()}</div>
              </div>
              <input ref={signupAvatarFileRef} type="file" accept="image/*" className="hidden" onChange={e=>{handleSignupPhotoPick(e.target.files?.[0]);e.target.value="";}}/>
            </div>
            <div className="flex flex-wrap gap-1">
              {EMOJI_CHOICES.map(em=>(
                <button type="button" key={em} onClick={()=>{setSignupAvatarEmoji(em);setSignupAvatarImage(null);}}
                  className={`w-8 h-8 rounded-lg hover:bg-slate-100 text-lg grid place-items-center ${signupAvatarEmoji===em?"bg-slate-100 ring-2 ring-blue-500":""}`}>{em}</button>
              ))}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Telefonnummer <span className="text-slate-300 font-normal">(valgfrit)</span></label>
              <input type="tel" value={signupPhone} onChange={e=>setSignupPhone(e.target.value)} placeholder="Fx 20 10 30 40"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Vælg adgangskode</label>
              <input type="password" value={signupPw} onChange={e=>{setSignupPw(e.target.value);setSignupPwErr("");}}
                placeholder="Mindst 6 tegn"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Gentag adgangskode</label>
              <input type="password" value={signupPwRep} onChange={e=>{setSignupPwRep(e.target.value);setSignupPwErr("");}}
                onKeyDown={e=>e.key==="Enter"&&finishSignup()}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            {signupPwErr&&<p className="text-xs text-red-500 font-medium">{signupPwErr}</p>}
            <button onClick={finishSignup} disabled={busy}
              className="w-full bg-blue-700 text-white font-semibold text-sm rounded-xl py-2.5 hover:bg-blue-800 disabled:opacity-60 transition-colors">
              {busy?"Opretter…":"Opret profil og log ind"}
            </button>
          </div>
        )}

        {mode==="forgot-form"&&(
          <div className="bg-white rounded-2xl p-6 shadow-xl space-y-4">
            <p className="text-sm text-slate-600">Indtast din e-mailadresse, så sender vi dig et link hvor du kan oprette en ny adgangskode.</p>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">E-mailadresse</label>
              <input type="email" value={forgotEmail} onChange={e=>{setForgotEmail(e.target.value);setForgotErr("");}}
                onKeyDown={e=>e.key==="Enter"&&startForgot()}
                placeholder="eks. email@email.dk"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            {forgotErr&&<p className="text-xs text-red-500 font-medium">{forgotErr}</p>}
            <button onClick={startForgot} disabled={busy}
              className="w-full bg-blue-700 text-white font-semibold text-sm rounded-xl py-2.5 hover:bg-blue-800 disabled:opacity-60 transition-colors">
              {busy?"Sender…":"Send link"}
            </button>
            <button onClick={()=>goto("login")} className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 font-medium pt-1">
              <ArrowLeft size={12}/> Tilbage til login
            </button>
          </div>
        )}

        {mode==="forgot-sent"&&(
          <div className="bg-white rounded-2xl p-6 shadow-xl space-y-4">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 mx-auto">
                <Mail size={22} className="text-blue-600"/>
              </div>
              <p className="text-sm text-slate-700">
                Vi har sendt et link til <span className="font-semibold">{forgotEmail.trim()}</span>, hvor du kan oprette en ny adgangskode.
              </p>
            </div>
            <p className="text-xs text-slate-400">Tjek din indbakke (og evt. spammappen) for et link fra Firebase, hvor du kan vælge en ny adgangskode.</p>
            <button onClick={()=>goto("login")} className="w-full flex items-center justify-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 font-medium pt-1">
              <ArrowLeft size={12}/> Tilbage til login
            </button>
          </div>
        )}

        <p className="text-center text-[11px] text-blue-200/60">© {new Date().getFullYear()} Rikabilly Production</p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PROFIL-DROPDOWN (header)
═══════════════════════════════════════════════════════════ */
function ProfileDropdown({user,player,onLogout,onOpenProfil,onOpenFriends,onOpenIntro,onDeleteProfile}){
  const [open,setOpen]=useState(false);
  return(
    <div className="relative">
      <button onClick={()=>setOpen(v=>!v)}
        className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-2 sm:px-3 py-2 text-sm hover:bg-slate-50 transition-colors">
        <div className="w-6 h-6 rounded-full grid place-items-center text-[10px] font-bold bg-blue-700 text-white overflow-hidden shrink-0">
          {avatarContent(player||user)}
        </div>
        <span className="hidden sm:inline font-medium text-slate-700 max-w-24 truncate">{user.name}</span>
        <ChevronDown size={13} className={`hidden sm:block text-slate-400 transition-transform ${open?"rotate-180":""}`}/>
      </button>
      {open&&(
        <>
          <div className="fixed inset-0 z-10" onClick={()=>setOpen(false)}/>
          <div className="absolute right-0 top-full mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-20 w-52 overflow-hidden">
            <div className="px-3 py-2.5 border-b border-slate-100">
              <div className="text-xs font-semibold text-slate-800 truncate">{user.name}</div>
              <div className="text-[10px] text-slate-400 truncate">{user.email}</div>
            </div>
            <button onClick={()=>{setOpen(false);onOpenProfil();}}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
              <User size={14} className="text-slate-400"/> Min profil
            </button>
            <button onClick={()=>{setOpen(false);onOpenFriends();}}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
              <Users size={14} className="text-slate-400"/> Venner
            </button>
            <button onClick={()=>{setOpen(false);onOpenIntro();}}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
              <Sparkles size={14} className="text-slate-400"/> Intro
            </button>
            <button onClick={()=>{setOpen(false);onLogout();}}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 border-t border-slate-100">
              <LogOut size={14}/> Log ud
            </button>
            <button onClick={()=>{setOpen(false);onDeleteProfile();}}
              className="w-full text-left px-3 py-2 text-xs text-slate-400 hover:text-red-500 hover:bg-red-50 border-t border-slate-100">
              Slet profil
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SLET PROFIL — bekræftelse (vises som eget lag, fast centreret)
═══════════════════════════════════════════════════════════ */
function DeleteProfileModal({onConfirm,onClose}){
  const [password,setPassword]=useState("");
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const confirm=async()=>{
    if(!password||busy)return;
    setErr("");setBusy(true);
    try{
      await onConfirm(password);
    }catch(e){
      const wrongPw=e?.code==="auth/wrong-password"||e?.code==="auth/invalid-credential";
      setErr(wrongPw?"Forkert adgangskode.":(e?.message||"Kunne ikke slette profilen. Prøv igen."));
      setBusy(false);
    }
  };
  return(
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-3">
        <div className="text-sm font-semibold text-slate-800">Slet din HuddleUp-profil</div>
        <p className="text-sm text-slate-600">Du er ved at slette din HuddleUp profil. Hvis du fortsætter vil al din HuddleUp data også blive slettet. Ønsker du at fortsætte?</p>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Bekræft med din adgangskode</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Adgangskode" disabled={busy}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-60"/>
        </div>
        {err&&<p className="text-xs text-red-500 font-medium">{err}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={busy}
            className="flex-1 bg-white border border-slate-200 text-slate-600 text-sm font-semibold rounded-lg py-2 disabled:opacity-40 hover:bg-slate-50">Fortryd</button>
          <button onClick={confirm} disabled={busy||!password}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg py-2 disabled:opacity-40">
            {busy?"Sletter…":"Slet profil"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   INTRODUKTION TIL FUNKTIONERNE — trin-for-trin guide
═══════════════════════════════════════════════════════════ */
const INTRO_STEPS=[
  {
    icon:Sparkles,
    kicker:"Velkommen",
    title:"Velkommen til HuddleUp",
    body:"Her finder du de tidspunkter hvor flest mulige spillere kan spille, inviterer holdet, og fastlægger kampe. Denne guide viser dig, trin for trin, hvordan du opretter en forespørgsel — og hvordan du administrerer den bagefter.",
  },
  {
    icon:Send,
    kicker:"Trin 1",
    title:"Opret en forespørgsel",
    body:"Gå til fanen \"Opret Huddle\". Giv den en titel og en periode, og vælg hvilke spillere der skal forespørges (kun venner kan søges frem — tilføj dem via Venner-menuen). Du bestemmer også hvor mange spillere der mindst skal kunne, og hvor mange sammenhængende timer.",
  },
  {
    icon:UserPlus,
    kicker:"Trin 2",
    title:"Spillerne svarer",
    body:"De inviterede spillere ser forespørgslen på deres eget Overblik. De accepterer eller afslår invitationen, og udfylder derefter hvornår de kan spille i perioden — direkte under forespørgslen, uden at forlade siden.",
  },
  {
    icon:Calendar,
    kicker:"Trin 3",
    title:"Se tilgængelighed og bedste tider",
    body:"Under forespørgslen kan du se \"Samlet tilgængelighed\" ugevis, og en liste over \"Bedste tider\" — de tidspunkter hvor flest spillere kan. Tryk \"Vis\" ud for et tidspunkt for at se præcis hvilke spillere det gælder.",
  },
  {
    icon:CheckCircle2,
    kicker:"Trin 4",
    title:"Fastlæg kampe",
    body:"Som opretter kan du trykke \"Fastlæg\" på en af de bedste tider for at gøre den til en officiel kamp. Kun dig, der har oprettet forespørgslen, kan fastlægge eller fjerne kampe — de fastlagte kampe opsummeres altid øverst på forespørgslen.",
  },
  {
    icon:Edit2,
    kicker:"Trin 5",
    title:"Administrér forespørgslen",
    body:"Under \"Indsendelser\" kan du se hvem der har svaret, og frigive en enkelt spiller eller alle, hvis de skal indsende igen. Tryk \"Rediger\" for at ændre titel, periode, spillere eller krav til minimum spillere/timer — det kræver ikke fornyet accept fra spillerne, medmindre du ændrer datoerne.",
  },
  {
    icon:Sparkles,
    kicker:"Klar!",
    title:"Du er klar til at komme i gang",
    body:"Du kan altid åbne denne guide igen fra profilmenuen, hvis du får brug for at genopfriske hukommelsen. God fornøjelse med planlægningen!",
  },
];

function IntroModal({onClose}){
  const [step,setStep]=useState(0);
  const isFirst=step===0,isLast=step===INTRO_STEPS.length-1;
  const s=INTRO_STEPS[step];
  const Icon=s.icon;
  return(
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4">
          <div className="flex gap-1">
            {INTRO_STEPS.map((_,i)=>(
              <span key={i} className={`h-1.5 rounded-full transition-all ${i===step?"w-5 bg-blue-700":"w-1.5 bg-slate-200"}`}/>
            ))}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18}/></button>
        </div>
        <div className="px-6 py-6 space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 grid place-items-center">
            <Icon size={22} className="text-blue-700"/>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-blue-600 uppercase tracking-wide mb-1">{s.kicker}</div>
            <h2 className="text-lg font-bold text-slate-800">{s.title}</h2>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">{s.body}</p>
        </div>
        <div className="flex items-center gap-2 px-5 pb-5 pt-1">
          {!isFirst&&(
            <button onClick={()=>setStep(v=>Math.max(0,v-1))}
              className="inline-flex items-center gap-1 text-sm text-slate-600 border border-slate-200 rounded-xl px-4 py-2.5 hover:bg-slate-50">
              <ChevronLeft size={15}/> Tilbage
            </button>
          )}
          {!isLast&&(
            <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-600 px-2">Spring over</button>
          )}
          <div className="flex-1"/>
          {isLast
            ?<button onClick={onClose} className="inline-flex items-center gap-1.5 bg-blue-700 text-white text-sm font-semibold rounded-xl px-5 py-2.5 hover:bg-blue-800">
                <CheckCircle2 size={15}/> Kom i gang
              </button>
            :<button onClick={()=>setStep(v=>Math.min(INTRO_STEPS.length-1,v+1))}
                className="inline-flex items-center gap-1.5 bg-blue-700 text-white text-sm font-semibold rounded-xl px-5 py-2.5 hover:bg-blue-800">
                Næste <ChevronRight size={15}/>
              </button>
          }
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   VENNER-MODAL (profil-dropdown)
═══════════════════════════════════════════════════════════ */
function FriendsModal({currentUser,players,friends,friendRequests,myPendingInvites,onSendRequest,onCancelRequest,onRemoveFriend,onCancelPendingInvite,onClose}){
  const [query,setQuery]=useState("");
  const [pendingSend,setPendingSend]=useState(null); // spiller man er ved at bekræfte en venneanmodning til
  const [confirmRemoveId,setConfirmRemoveId]=useState(null); // spiller man er ved at bekræfte at ville fjerne
  // Inviter en helt ny person der endnu ikke har en Huddleup-konto, direkte fra vennelisten —
  // samme mekanisme som "Inviter en ny spiller" i forespørgsler, men ikke bundet til nogen
  // bestemt forespørgsel (invitationId:null). De bliver automatisk din ven, når de opretter sig.
  const [showInviteNew,setShowInviteNew]=useState(false);
  const [newInvName,setNewInvName]=useState("");
  const [newInvEmail,setNewInvEmail]=useState("");
  const [inviteBusy,setInviteBusy]=useState(false);
  const [inviteErr,setInviteErr]=useState("");
  const [sentInvite,setSentInvite]=useState(null);
  const emailValid=(e)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const myFriendIds=useMemo(()=>new Set(friends[currentUser.id]||[]),[friends,currentUser]);
  // "players" er nu selve profil-collection'en (navn+email+telefon samlet ét sted), så der er
  // ikke længere brug for at slå en separat "users"-liste op og flette den ind.
  const enriched=useMemo(()=>players.filter(p=>p.id!==currentUser.id),[players,currentUser]);
  const myFriends=useMemo(()=>enriched.filter(p=>myFriendIds.has(p.id)),[enriched,myFriendIds]);
  const outgoingRequests=useMemo(()=>(friendRequests||[]).filter(r=>r.fromId===currentUser.id),[friendRequests,currentUser]);
  const outgoingIds=useMemo(()=>new Set(outgoingRequests.map(r=>r.toId)),[outgoingRequests]);
  // Man kan have sendt invitationen flere gange (fx til samme forespørgsel og igen manuelt) — her
  // vises kun ét kort pr. e-mail, uanset hvor mange "invites"-dokumenter der reelt findes.
  const dedupedPendingInvites=useMemo(()=>dedupeInvitesByEmail(myPendingInvites),[myPendingInvites]);
  const pendingInviteEmails=useMemo(()=>new Set(dedupedPendingInvites.map(iv=>(iv.email||"").trim().toLowerCase())),[dedupedPendingInvites]);
  // Der kan ligge flere "invites"-dokumenter for samme e-mail (kun det seneste vises jf. ovenfor)
  // — når man fortryder, skal alle af dem fjernes, ellers "spøger" personen videre på listen.
  const cancelAllForEmail=(email)=>{
    const key=(email||"").trim().toLowerCase();
    (myPendingInvites||[]).filter(iv=>(iv.email||"").trim().toLowerCase()===key).forEach(iv=>onCancelPendingInvite&&onCancelPendingInvite(iv.id));
  };
  const searchResults=useMemo(()=>{
    const q=query.trim().toLowerCase();
    if(!q)return[];
    return enriched.filter(p=>!myFriendIds.has(p.id)&&!outgoingIds.has(p.id)&&(
      p.name.toLowerCase().includes(q)||
      (p.email||"").toLowerCase().includes(q)||
      (p.phone||"").replace(/\s/g,"").includes(q.replace(/\s/g,""))
    )).slice(0,8);
  },[enriched,query,myFriendIds,outgoingIds]);
  // Findes e-mailen allerede — enten som en oprettet bruger eller som en afventende invitation —
  // så advares der i stedet for stiltiende at sende endnu en invitation til samme person.
  const newInvEmailMatch=useMemo(()=>{
    const q=newInvEmail.trim().toLowerCase();
    if(!q)return null;
    if(pendingInviteEmails.has(q))return"pending";
    if(players.some(p=>(p.email||"").trim().toLowerCase()===q))return"existing";
    return null;
  },[newInvEmail,pendingInviteEmails,players]);

  const confirmSendRequest=()=>{
    if(!pendingSend)return;
    onSendRequest(pendingSend.id);
    setPendingSend(null);
    setQuery("");
  };
  const confirmRemoveFriend=()=>{
    if(!confirmRemoveId)return;
    onRemoveFriend(confirmRemoveId);
    setConfirmRemoveId(null);
  };
  const inviteNewPerson=async()=>{
    const name=newInvName.trim(),email=newInvEmail.trim();
    if(!name||!emailValid(email)||newInvEmailMatch)return;
    setInviteErr("");setInviteBusy(true);
    try{
      const inviteId=newDocId("invites");
      await setDoc(doc(db,"invites",inviteId),{email,name,invitedByUid:currentUser.id,invitedByName:currentUser.name,invitationId:null,createdAt:new Date().toISOString(),status:"pending"});
      await sendInviteEmail({toEmail:email,toName:name,fromName:currentUser.name,invitationTitle:"",signupUrl:buildSignupUrl(email,name)});
      setSentInvite({name,email});
      setNewInvName("");setNewInvEmail("");
    }catch(e){
      setInviteErr(e.message||"Kunne ikke sende invitationen.");
    }finally{
      setInviteBusy(false);
    }
  };
  const removeTarget=confirmRemoveId?enriched.find(p=>p.id===confirmRemoveId):null;

  return(
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col" style={{maxHeight:"90vh"}}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
          <Users size={18} className="text-blue-700"/>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-slate-800">Venner</div>
            <div className="text-xs text-slate-400">Kun venner kan findes og tilføjes til dine forespørgsler.</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 ml-1"><X size={18}/></button>
        </div>
        <div className="overflow-y-auto p-5 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Tilføj ven — søg på navn, telefon eller e-mail</label>
            <div className="relative">
              <input type="text" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Søg…"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              {searchResults.length>0&&(
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                  {searchResults.map(p=>(
                    <button type="button" key={p.id} onClick={()=>setPendingSend(p)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-50 text-sm">
                      <span className="w-6 h-6 rounded-full bg-blue-700 text-white grid place-items-center text-[10px] font-bold shrink-0 overflow-hidden">{avatarContent(p)}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{p.name}</span>
                        <span className="block text-[10px] text-slate-400 truncate">{p.email}{p.phone?` · ${p.phone}`:""}</span>
                      </span>
                      <UserPlus size={13} className="text-blue-600 shrink-0"/>
                    </button>
                  ))}
                </div>
              )}
              {query.trim()&&searchResults.length===0&&(
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2.5 text-xs text-slate-400">Ingen match.</div>
              )}
            </div>
          </div>
          <div>
            {!showInviteNew?(
              <button type="button" onClick={()=>{setShowInviteNew(true);setSentInvite(null);setInviteErr("");}}
                className="inline-flex items-center gap-1.5 text-xs text-blue-700 hover:underline font-medium">
                <Mail size={12}/> Personen har ikke Huddleup endnu? Inviter på e-mail
              </button>
            ):(
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                <div className="text-xs font-semibold text-slate-600 flex items-center justify-between">
                  <span className="flex items-center gap-1.5"><Mail size={12}/> Inviter en ny person på e-mail</span>
                  <button type="button" onClick={()=>setShowInviteNew(false)} className="text-slate-400 hover:text-slate-600"><X size={13}/></button>
                </div>
                {sentInvite?(
                  <div className="text-xs text-lime-700 bg-lime-50 border border-lime-200 rounded-lg px-2.5 py-2">
                    Invitation sendt til <span className="font-semibold">{sentInvite.name}</span> ({sentInvite.email}).
                  </div>
                ):(
                  <>
                    <div className="flex gap-2 flex-wrap">
                      <input type="text" placeholder="Navn" value={newInvName} onChange={e=>setNewInvName(e.target.value)}
                        className="flex-1 min-w-28 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                      <input type="email" placeholder="E-mail" value={newInvEmail} onChange={e=>setNewInvEmail(e.target.value)}
                        className="flex-1 min-w-36 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                    </div>
                    {newInvEmailMatch==="pending"&&<p className="text-xs text-amber-600 font-medium">Denne e-mail er allerede inviteret og afventer stadig svar.</p>}
                    {newInvEmailMatch==="existing"&&<p className="text-xs text-amber-600 font-medium">Denne e-mail har allerede en Huddleup-konto.</p>}
                    {inviteErr&&<p className="text-xs text-red-500 font-medium">{inviteErr}</p>}
                    <button type="button" onClick={inviteNewPerson} disabled={inviteBusy||!newInvName.trim()||!emailValid(newInvEmail)||!!newInvEmailMatch}
                      className="w-full inline-flex items-center justify-center gap-1.5 bg-blue-700 text-white text-sm font-medium rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-blue-800">
                      <UserPlus size={14}/> {inviteBusy?"Sender…":"Send invitation"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {outgoingRequests.length>0&&(
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Afsendte anmodninger — afventer svar ({outgoingRequests.length})</label>
              <div className="space-y-1.5">
                {outgoingRequests.map(r=>{
                  const p=enriched.find(x=>x.id===r.toId);
                  if(!p)return null;
                  return(
                    <div key={r.id} className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2">
                      <span className="w-6 h-6 rounded-full bg-amber-500 text-white grid place-items-center text-[10px] font-bold shrink-0 overflow-hidden">{avatarContent(p)}</span>
                      <span className="flex-1 min-w-0 text-sm text-slate-700 truncate">{p.name}</span>
                      <span className="text-[10px] text-amber-600 font-medium shrink-0">Afventer</span>
                      <button onClick={()=>onCancelRequest(r.id)} className="text-slate-400 hover:text-red-500 shrink-0"><X size={14}/></button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {dedupedPendingInvites.length>0&&(
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Inviteret — afventer oprettelse af konto ({dedupedPendingInvites.length})</label>
              <div className="space-y-1.5">
                {dedupedPendingInvites.map(inv=>(
                  <div key={inv.id} className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg px-2.5 py-2">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 grid place-items-center shrink-0"><Mail size={12}/></span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-slate-700 truncate">{inv.name}</span>
                      <span className="block text-[10px] text-slate-400 truncate">{inv.email}</span>
                    </span>
                    <span className="text-[10px] text-blue-600 font-medium shrink-0">Afventer</span>
                    {onCancelPendingInvite&&<button onClick={()=>cancelAllForEmail(inv.email)} title="Fortryd invitation" className="text-slate-400 hover:text-red-500 shrink-0"><X size={14}/></button>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">Dine venner ({myFriends.length})</label>
            {myFriends.length===0?(
              <p className="text-xs text-slate-400">Du har endnu ikke tilføjet nogen venner.</p>
            ):(
              <div className="space-y-1.5">
                {myFriends.map(p=>(
                  <div key={p.id} className="flex items-center gap-2 bg-slate-50 rounded-lg px-2.5 py-2">
                    <span className="w-6 h-6 rounded-full bg-blue-700 text-white grid place-items-center text-[10px] font-bold shrink-0 overflow-hidden">{avatarContent(p)}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">{p.name}</span>
                      <span className="block text-[10px] text-slate-400 truncate">{p.user?.email}{p.user?.phone?` · ${p.user.phone}`:""}</span>
                    </span>
                    <button onClick={()=>setConfirmRemoveId(p.id)} className="text-slate-400 hover:text-red-500 shrink-0"><X size={14}/></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Bekræftelsesbokse vises som deres eget lag, fast centreret i vinduet — uafhængigt af
          hvor langt man er scrollet ned i selve venneliste-kortet ovenfor. */}
      {pendingSend&&(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={()=>setPendingSend(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-4 space-y-3" onClick={e=>e.stopPropagation()}>
            <div className="text-sm text-slate-700">Vil du sende en venneanmodning til <span className="font-semibold">{pendingSend.name}</span>?</div>
            <div className="flex gap-2">
              <button onClick={confirmSendRequest} className="flex-1 bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold rounded-lg py-2">Send anmodning</button>
              <button onClick={()=>setPendingSend(null)} className="flex-1 bg-white border border-blue-200 text-blue-800 text-sm font-semibold rounded-lg py-2">Annuller</button>
            </div>
          </div>
        </div>
      )}
      {confirmRemoveId&&(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={()=>setConfirmRemoveId(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-4 space-y-3" onClick={e=>e.stopPropagation()}>
            <div className="text-sm text-slate-700">Er du sikker på at du vil fjerne <span className="font-semibold">{removeTarget?.name}</span> som ven?</div>
            <div className="flex gap-2">
              <button onClick={confirmRemoveFriend} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg py-2">Ja, fjern</button>
              <button onClick={()=>setConfirmRemoveId(null)} className="flex-1 bg-white border border-amber-300 text-amber-800 text-sm font-semibold rounded-lg py-2">Nej</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   KAPTAJNENS OVERBLIK
═══════════════════════════════════════════════════════════ */
function KaptajnOverblik({players,setPlayers,avail,setAvail,baseMonday,today,setTab,currentUser,invitations,setInvitations,matches,setMatches,lockedPlayers,setLockedPlayers,drafts,setDrafts,setOpenDraftId,friends,setFriends,templates,setTemplates,friendRequests,myPendingInvites,onCancelPendingInvite,onAcceptFriendRequest,onDeclineFriendRequest,onSendFriendRequest,onCancelFriendRequest,focusInvitationId,setFocusInvitationId,collapseAllSignal}){
  const updateInvitation=(id,fn)=>setInvitations(prev=>prev.map(inv=>inv.id===id?fn(inv):inv));
  const deleteInvitation=(id)=>setInvitations(prev=>prev.filter(inv=>inv.id!==id));

  // Man ser kun forespørgsler man selv har oprettet, eller er inviteret til — det gælder både
  // aktive og afsluttede (alle der har været inviteret kan altid finde dem igen).
  const myInvitations=useMemo(()=>(invitations||[]).filter(inv=>inv.createdById===currentUser?.id||inv.playerIds.includes(currentUser?.id)),[invitations,currentUser]);
  // Kladder er kun synlige for den, der er ved at oprette dem
  const myDrafts=useMemo(()=>(drafts||[]).filter(d=>d.createdById===currentUser?.id),[drafts,currentUser]);
  // Indkommende venneanmodninger, der afventer mit svar
  // "accepted:true" betyder man allerede har trykket Accepter, men anmodningen står stadig i
  // Firestore et øjeblik endnu (se acceptFriendRequest i App()) — fordi den var knyttet til en
  // huddle-kladde der endnu ikke var afsendt, og som selve afsendelsen skal samle den op fra. Den
  // skal ikke vises som "kræver handling" igen.
  const incomingFriendRequests=useMemo(()=>(friendRequests||[]).filter(r=>r.toId===currentUser?.id&&!r.accepted),[friendRequests,currentUser]);

  // Visningsvalg: Kladde / Aktive / Afsluttede
  const [viewMode,setViewMode]=useState("active");
  const [viewMenuOpen,setViewMenuOpen]=useState(false);
  const invByStatus=(st)=>myInvitations.filter(inv=>(inv.status||"active")===st);
  const activeInvs=useMemo(()=>invByStatus("active"),[myInvitations]);
  const completedInvs=useMemo(()=>invByStatus("completed"),[myInvitations]);
  const VIEW_TABS=[
    {key:"kladde",label:"Kladde",count:myDrafts.length},
    {key:"active",label:"Aktive",count:activeInvs.length},
    {key:"completed",label:"Afsluttede",count:completedInvs.length},
  ];
  const shownInvitations=viewMode==="completed"?completedInvs:activeInvs;

  // Når man klikker en notifikation for en bestemt forespørgsel, skal den rigtige visning (Aktive/
  // Afsluttede) vælges automatisk, så kortet rent faktisk er synligt før det foldes ud og scrolles til.
  useEffect(()=>{
    if(!focusInvitationId)return;
    const inv=myInvitations.find(i=>i.id===focusInvitationId);
    if(inv)setViewMode((inv.status||"active")==="completed"?"completed":"active");
  },[focusInvitationId,myInvitations]);

  return(
    <div className="space-y-4">
      {/* Opret-knap og visningsvælger — begge dele af den faste overblikslinje, ikke faner */}
      <div className="flex items-center justify-between gap-2">
        <button onClick={()=>setTab("forespoergsel")}
          className="inline-flex items-center gap-1.5 bg-blue-700 text-white text-sm font-semibold rounded-xl px-3.5 py-2 hover:bg-blue-800 transition-colors shrink-0">
          <Send size={14}/> <span className="hidden sm:inline">Opret ny Huddle</span><span className="sm:hidden">Opret</span>
        </button>
        <div className="relative">
          <button onClick={()=>setViewMenuOpen(v=>!v)}
            className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
            {VIEW_TABS.find(t=>t.key===viewMode)?.label}
            <span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-1.5 py-0.5 font-semibold">{VIEW_TABS.find(t=>t.key===viewMode)?.count}</span>
            <ChevronDown size={13} className={`text-slate-400 transition-transform ${viewMenuOpen?"rotate-180":""}`}/>
          </button>
          {viewMenuOpen&&(
            <>
              <div className="fixed inset-0 z-10" onClick={()=>setViewMenuOpen(false)}/>
              <div className="absolute right-0 top-full mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-20 w-44 overflow-hidden">
                {VIEW_TABS.map(t=>(
                  <button key={t.key} onClick={()=>{setViewMode(t.key);setViewMenuOpen(false);}}
                    className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-sm ${viewMode===t.key?"bg-blue-50 text-blue-800 font-semibold":"text-slate-700 hover:bg-slate-50"}`}>
                    {t.label}
                    <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-semibold ${viewMode===t.key?"bg-blue-100 text-blue-700":"bg-slate-100 text-slate-500"}`}>{t.count}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {incomingFriendRequests.length>0&&(
        <div className="bg-white rounded-2xl border border-blue-200 p-4 space-y-2.5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5"><UserPlus size={12}/> Venneanmodninger ({incomingFriendRequests.length})</div>
          {incomingFriendRequests.map(r=>{
            const p=players.find(pl=>pl.id===r.fromId);
            return(
              <div key={r.id} className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                <span className="w-7 h-7 rounded-full bg-blue-700 text-white grid place-items-center text-[10px] font-bold shrink-0 overflow-hidden">{p?avatarContent(p):"?"}</span>
                <span className="flex-1 min-w-0 text-sm text-slate-700 truncate">{p?.name||"Ukendt spiller"} vil gerne være venner</span>
                <button onClick={()=>onAcceptFriendRequest(r.id)}
                  className="inline-flex items-center gap-1 text-xs bg-lime-600 text-white font-semibold rounded-lg px-2.5 py-1.5 hover:bg-lime-700 shrink-0"><CheckCircle2 size={12}/> Accepter</button>
                <button onClick={()=>onDeclineFriendRequest(r.id)}
                  className="inline-flex items-center gap-1 text-xs bg-white border border-slate-200 text-slate-600 font-semibold rounded-lg px-2.5 py-1.5 hover:bg-red-50 hover:text-red-600 hover:border-red-200 shrink-0"><X size={12}/> Afslå</button>
              </div>
            );
          })}
        </div>
      )}

      {viewMode==="kladde"?(
        myDrafts.length===0?(
          <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
            <Edit2 size={30} className="mx-auto text-slate-300"/>
            <div className="text-sm font-semibold text-slate-500">Ingen kladder</div>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">Gem en forespørgsel som kladde undervejs, eller kopiér en tidligere forespørgsel til en ny kladde.</p>
          </div>
        ):(
          <div className="space-y-3">
            {myDrafts.map(d=>(
              // Samme kort-visning som en rigtig forespørgsel (avatar, titel, metadata-linjer),
              // så kladder og aktive forespørgsler ser eksakt ens ud.
              <div key={d.id} className="bg-white rounded-2xl border border-slate-200 hover:border-blue-300 transition-colors">
                {/* Titel/metadata på sin egen fulde bredde — så teksten altid har al pladsen at
                    folde sig ud på — og handlingerne samlet i en separat række nedenunder, i
                    stedet for at presses ind i en smal venstre-kolonne ved siden af knapperne. */}
                <div className="p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-50 grid place-items-center shrink-0 overflow-hidden text-xl">
                      {d.avatarImage
                        ?<img src={d.avatarImage} alt="" className="w-full h-full object-cover"/>
                        :d.avatarEmoji
                          ?<span>{d.avatarEmoji}</span>
                          :<Bell size={18} className="text-blue-600"/>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-slate-800">{d.title||"Unavngivet kladde"}</div>
                      <ReqMeta item={d}/>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={()=>{setOpenDraftId(d.id);setTab("forespoergsel");}}
                      className="text-xs bg-blue-700 text-white rounded-lg px-3 py-1.5 hover:bg-blue-800 font-medium">Fortsæt kladde</button>
                    <button onClick={()=>setDrafts(prev=>prev.filter(x=>x.id!==d.id))} title="Slet kladde"
                      className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={13}/></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ):shownInvitations.length===0?(
        <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
          <CalendarClock size={30} className="mx-auto text-slate-300"/>
          <div className="text-sm font-semibold text-slate-500">
            {viewMode==="active"?"Ingen aktive forespørgsler":"Ingen afsluttede forespørgsler"}
          </div>
          {viewMode==="active"&&(<>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">Opret en forespørgsel om spilletider for at se tilgængelighed, bedste tider og fastlagte kampe her.</p>
            <button onClick={()=>setTab("forespoergsel")}
              className="inline-flex items-center gap-1.5 bg-blue-700 text-white text-sm font-semibold rounded-xl px-4 py-2 hover:bg-blue-800 mt-1">
              <Send size={14}/> Opret Huddle
            </button>
          </>)}
        </div>
      ):(
        shownInvitations.map(inv=>(
          <InvitationCard key={inv.id} invitation={inv} players={players} setPlayers={setPlayers} avail={avail} setAvail={setAvail} baseMonday={baseMonday} today={today}
            setTab={setTab} currentUser={currentUser} matches={matches} setMatches={setMatches}
            updateInvitation={updateInvitation} deleteInvitation={deleteInvitation} lockedPlayers={lockedPlayers} setLockedPlayers={setLockedPlayers} friends={friends} setFriends={setFriends}
            invitations={invitations} setInvitations={setInvitations} templates={templates} setTemplates={setTemplates} setDrafts={setDrafts} setOpenDraftId={setOpenDraftId}
            myPendingInvites={myPendingInvites} onCancelPendingInvite={onCancelPendingInvite}
            friendRequests={friendRequests} onSendFriendRequest={onSendFriendRequest} onCancelFriendRequest={onCancelFriendRequest}
            focusInvitationId={focusInvitationId} setFocusInvitationId={setFocusInvitationId} collapseAllSignal={collapseAllSignal}/>
        ))
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   FORESPØRGSELS-RUBRIK (én pr. anmodning)
═══════════════════════════════════════════════════════════ */
function InvitationCard({invitation,players,setPlayers,avail,setAvail,baseMonday,today,setTab,currentUser,matches,setMatches,updateInvitation,deleteInvitation,lockedPlayers,setLockedPlayers,friends,setFriends,invitations,setInvitations,templates,setTemplates,setDrafts,setOpenDraftId,myPendingInvites,onCancelPendingInvite,friendRequests,onSendFriendRequest,onCancelFriendRequest,focusInvitationId,setFocusInvitationId,collapseAllSignal}){
  const [weekOffset,setWeekOffset]=useState(0);
  // Standardværdier hentes fra forespørgslens egne indstillinger (sat da den blev oprettet)
  const [threshold,setThreshold]=useState(invitation.minPlayers||Math.max(4,Math.floor(players.length*0.7)));
  const [selCell,setSelCell]=useState(null);
  const [expanded,setExpanded]=useState(false);
  const [heatIds,setHeatIds]=useState(null); // Set af spiller-id'er der indgår i beregningen
  const [consecHours,setConsecHours]=useState(invitation.consecHours||1);
  const [bestTimesWeek,setBestTimesWeek]=useState(null); // uge-filter for "Bedste tider", sat via klik i "Samlet tilgængelighed"
  const [expandedBestTimes,setExpandedBestTimes]=useState(new Set()); // hvilke "Bedste tider"-rækker viser lige nu hvilke spillere kan
  const [expandedMatches,setExpandedMatches]=useState(new Set()); // hvilke fastlagte kampe viser lige nu hvilke spillere kan deltage
  const [menuOpen,setMenuOpen]=useState(false);
  const [showTeamView,setShowTeamView]=useState(currentUser?.id===invitation.createdById);
  // "Udfyld egen kalender" foldes ud lige under knappen i stedet for at navigere væk fra siden.
  const [showFillCalendar,setShowFillCalendar]=useState(false);
  const myLatestInvitation=(invitations||[]).find(i=>i.id===invitation.id)||invitation;
  const iHaveSubmitted=(myLatestInvitation.submittedIds||[]).includes(currentUser?.id);
  const mySubmittedAt=myLatestInvitation.submittedAt?.[currentUser?.id];
  // Fold kalenderen sammen igen, når man har indsendt sine tider.
  useEffect(()=>{
    if(iHaveSubmitted)setShowFillCalendar(false);
  },[iHaveSubmitted]);

  // Klik på en notifikation for netop denne forespørgsel: fold kortet ud og scroll hen til det,
  // så man lander direkte det sted hvor man kan tage handling (acceptere/afvise, indsende datoer).
  useEffect(()=>{
    if(focusInvitationId!==invitation.id)return;
    setExpanded(true);
    const el=document.getElementById(`inv-${invitation.id}`);
    if(el)el.scrollIntoView({behavior:"smooth",block:"start"});
    if(setFocusInvitationId)setFocusInvitationId(null);
  },[focusInvitationId,invitation.id]);

  // Klik på "HuddleUp"-titlen: fold alle kort sammen igen, så man kommer tilbage til et fuldt
  // overblik. collapseAllSignal tælles op ved hvert klik — se App().
  const isFirstCollapseSignal=useRef(true);
  useEffect(()=>{
    if(isFirstCollapseSignal.current){isFirstCollapseSignal.current=false;return;}
    setExpanded(false);
  },[collapseAllSignal]);

  // Hjælp en anden spiller med at udfylde sin kalender — direkte inline på dette kort, uden at
  // logge ind som dem eller forlade siden. Man beholder selv sin fulde adgang til forespørgslen.
  const [helpingPlayerId,setHelpingPlayerId]=useState(null);
  const helpingPlayer=helpingPlayerId?players.find(p=>p.id===helpingPlayerId):null;
  const helpingResponse=helpingPlayerId?responseFor(myLatestInvitation,helpingPlayerId):null;
  const toggleHelpPlayer=(pl)=>{
    if(!pl||pl.id===currentUser?.id)return;
    setHelpingPlayerId(prev=>prev===pl.id?null:pl.id);
  };

  // Bekræftelse før man frigiver en enkelt spillers eller alle spilleres indsendelse(r) —
  // pendingUnlock er enten null, "all", eller et spiller-id.
  const [pendingUnlock,setPendingUnlock]=useState(null);

  /* ── Redigering af forespørgslen (kun opretteren) ────────── */
  const [editing,setEditing]=useState(false);
  const [editTitle,setEditTitle]=useState("");
  const [editDescription,setEditDescription]=useState("");
  const [editStart,setEditStart]=useState("");
  const [editEnd,setEditEnd]=useState("");
  const [editSubmitDeadline,setEditSubmitDeadline]=useState("");
  const [editDeadline,setEditDeadline]=useState("");
  const [editMinPlayers,setEditMinPlayers]=useState(4);
  const [editConsecHours,setEditConsecHours]=useState(1);
  const [editAvatarImage,setEditAvatarImage]=useState(null);
  const [editAvatarEmoji,setEditAvatarEmoji]=useState(null);
  const [editShowEmojiPicker,setEditShowEmojiPicker]=useState(false);
  const [editPlayers,setEditPlayers]=useState(()=>new Set());
  const [editPlayerSearch,setEditPlayerSearch]=useState("");
  const [editNewName,setEditNewName]=useState("");
  const [editNewEmail,setEditNewEmail]=useState("");
  const [editSentInvite,setEditSentInvite]=useState(null);
  const [resendToExisting,setResendToExisting]=useState(false);
  const editAvatarFileRef=useRef(null);
  const EDIT_EMOJI_CHOICES=["😀","😎","🦁","⚡","🔥","🐺","🚀","🏆","🎯","🐧","🥅","🦊"];

  const canEditInvitation=currentUser?.id===invitation.createdById;

  const startEditing=()=>{
    setEditTitle(invitation.title||"");
    setEditDescription(invitation.description||"");
    setEditStart(invitation.startIso);
    setEditEnd(invitation.endIso);
    setEditSubmitDeadline(invitation.submitDeadline||"");
    setEditDeadline(invitation.deadline||"");
    setEditMinPlayers(invitation.minPlayers||threshold);
    setEditConsecHours(invitation.consecHours||consecHours);
    setEditAvatarImage(invitation.avatarImage||null);
    setEditAvatarEmoji(invitation.avatarEmoji||null);
    setEditPlayers(new Set(invitation.playerIds));
    setEditPlayerSearch("");
    setResendToExisting(false);
    setEditing(true);
    setExpanded(true);
  };
  const cancelEditing=()=>setEditing(false);

  const editEmailValid=(e)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const myFriendIds=useMemo(()=>new Set((friends&&friends[currentUser?.id])||[]),[friends,currentUser]);
  const editSearchResults=useMemo(()=>{
    const q=editPlayerSearch.trim().toLowerCase();
    if(!q)return[];
    return players.filter(p=>!editPlayers.has(p.id)&&myFriendIds.has(p.id)&&p.name.toLowerCase().includes(q)).slice(0,8);
  },[players,editPlayerSearch,editPlayers,myFriendIds]);
  const addEditPlayer=(id)=>{setEditPlayers(prev=>new Set(prev).add(id));setEditPlayerSearch("");};
  const removeEditPlayer=(id)=>setEditPlayers(prev=>{const n=new Set(prev);n.delete(id);return n;});
  // Spilleren findes ikke i systemet endnu — vi kan ikke oprette en Firebase Auth-konto på
  // andres vegne fra klienten (det kræver Admin SDK/en server), så i stedet gemmes en
  // "ventende invitation" i Firestore og der sendes en rigtig mail med et signup-link via
  // EmailJS. Når personen selv opretter en konto med denne e-mail, bliver de automatisk
  // tilføjet som ven og lagt ind i netop denne forespørgsel (se handleSignup i App()).
  const [editInviteBusy,setEditInviteBusy]=useState(false);
  const [editInviteErr,setEditInviteErr]=useState("");
  // Findes e-mailen allerede som en oprettet bruger, skal man IKKE sende en mail-invitation (de har
  // jo allerede en konto) — i stedet tilbydes en venneanmodning knyttet til denne forespørgsel, se
  // requestFriendForEditNewEmail og den store kommentar ved sendFriendRequest i App().
  const editNewEmailMatch=useMemo(()=>{
    const q=editNewEmail.trim().toLowerCase();
    if(!q)return null;
    const existingPlayer=players.find(p=>(p.email||"").trim().toLowerCase()===q);
    if(existingPlayer)return{type:"existing",player:existingPlayer};
    return null;
  },[editNewEmail,players]);
  const pendingFriendReqsForThisInvitation=useMemo(()=>(friendRequests||[])
    .filter(r=>r.fromId===currentUser.id&&r.invitationId===invitation.id)
    .map(r=>({...r,player:players.find(p=>p.id===r.toId)}))
  ,[friendRequests,currentUser,invitation.id,players]);
  const requestFriendForEditNewEmail=()=>{
    if(editNewEmailMatch?.type!=="existing"||!editNewEmailMatch.player)return;
    onSendFriendRequest&&onSendFriendRequest(editNewEmailMatch.player.id,invitation.id);
    setEditNewName("");setEditNewEmail("");
  };
  const inviteNewEditPlayer=async()=>{
    const name=editNewName.trim(),email=editNewEmail.trim();
    if(!name||!editEmailValid(email)||editNewEmailMatch)return;
    setEditInviteErr("");setEditInviteBusy(true);
    try{
      const inviteId=newDocId("invites");
      await setDoc(doc(db,"invites",inviteId),{email,name,invitedByUid:currentUser.id,invitedByName:currentUser.name,invitationId:invitation.id,status:"pending",createdAt:new Date().toISOString()});
      await sendInviteEmail({toEmail:email,toName:name,fromName:currentUser.name,invitationTitle:invitation.title,signupUrl:buildSignupUrl(email,name,invitation.id)});
      setEditSentInvite({name,email});
      setEditNewName("");setEditNewEmail("");
    }catch(e){
      setEditInviteErr(e.message||"Kunne ikke sende invitationen.");
    }finally{
      setEditInviteBusy(false);
    }
  };

  const newlyAddedIds=useMemo(()=>[...editPlayers].filter(id=>!invitation.playerIds.includes(id)),[editPlayers,invitation]);
  const datesChanged=editStart!==invitation.startIso||editEnd!==invitation.endIso||(editSubmitDeadline||"")!==(invitation.submitDeadline||"")||(editDeadline||"")!==(invitation.deadline||"");

  const saveEditing=()=>{
    if(!editTitle.trim()||!editStart||!editEnd||editStart>editEnd||editPlayers.size===0)return;
    updateInvitation(invitation.id,prev=>{
      const responses={...(prev.responses||{})};
      editPlayers.forEach(id=>{
        if(!(id in responses))responses[id]=id===currentUser.id?"accepted":"pending";
      });
      const forceReset=datesChanged||(newlyAddedIds.length>0&&resendToExisting);
      if(forceReset){
        Object.keys(responses).forEach(id=>{if(id!==currentUser.id)responses[id]="pending";});
      }
      const submittedIds=datesChanged?[]:(prev.submittedIds||[]).filter(id=>editPlayers.has(id));
      return{
        ...prev,
        title:editTitle.trim(),description:editDescription.trim(),
        startIso:editStart,endIso:editEnd,submitDeadline:editSubmitDeadline,deadline:editDeadline,
        minPlayers:editMinPlayers,consecHours:editConsecHours,
        avatarImage:editAvatarImage,avatarEmoji:editAvatarEmoji,
        playerIds:[...editPlayers],responses,submittedIds,
      };
    });
    setThreshold(editMinPlayers);
    setConsecHours(editConsecHours);
    setEditing(false);
  };

  // Kun spillere der har accepteret invitationen tæller med i planlægningen
  const acceptedIds=useMemo(()=>invitation.playerIds.filter(id=>responseFor(invitation,id)==="accepted"),[invitation]);
  // Ens kalender (kladde) er delt og genbruges gerne på tværs af flere forespørgsler — det er
  // meningen, så man ikke skal udfylde de samme tider flere gange. MEN de tæller først med i
  // holdets "Samlet tilgængelighed"/"Bedste tider"/fastlagte kampe for netop DENNE forespørgsel,
  // når spilleren aktivt har trykket "Indsend" for netop den — indtil da er kladden kun synlig
  // for spilleren selv i kalenderen, ikke for resten af holdet her.
  const submittedAcceptedIds=useMemo(()=>{
    const submitted=new Set(invitation.submittedIds||[]);
    return acceptedIds.filter(id=>submitted.has(id));
  },[acceptedIds,invitation.submittedIds]);

  // Nulstil spillerfilter når anmodningens periode/spillere/indsendelser ændres
  useEffect(()=>{
    setHeatIds(new Set(submittedAcceptedIds));
    setBestTimesWeek(null);
  },[invitation.startIso,invitation.endIso,acceptedIds.join(","),submittedAcceptedIds.join(",")]);

  const invitedPlayers=useMemo(()=>players.filter(p=>acceptedIds.includes(p.id)),[players,acceptedIds]);
  const submittedPlayers=useMemo(()=>players.filter(p=>submittedAcceptedIds.includes(p.id)),[players,submittedAcceptedIds]);
  const scopePlayers=useMemo(()=>{
    const ids=heatIds||new Set(submittedAcceptedIds);
    return players.filter(p=>ids.has(p.id));
  },[players,submittedAcceptedIds,heatIds]);

  // Fastlagte kampe hører til netop DENNE forespørgsel — de må aldrig blande sig med kampe fra
  // andre forespørgsler, selv hvis datoerne overlapper. Ældre kampe (fastlagt før dette felt
  // fandtes) har intet invitationId og vises derfor ikke her; de kan ikke længere tilskrives en
  // bestemt forespørgsel med sikkerhed.
  const myMatches=useMemo(()=>(matches||[]).filter(m=>m.invitationId===invitation.id),[matches,invitation.id]);
  // Folk inviteret via mail til netop denne forespørgsel, som endnu ikke har oprettet en konto
  // (se "Inviter en ny spiller" og handleSignup i App()) — vises som "afventer" ligesom spillere
  // der endnu ikke har accepteret, så de ikke forsvinder ud af syne efter selve invitationen.
  const myPendingInvitesForThis=useMemo(()=>dedupeInvitesByEmail((myPendingInvites||[]).filter(iv=>iv.invitationId===invitation.id)),[myPendingInvites,invitation.id]);
  const cancelAllPendingInvitesForEmail=(email)=>{
    const key=(email||"").trim().toLowerCase();
    (myPendingInvites||[]).filter(iv=>iv.invitationId===invitation.id&&(iv.email||"").trim().toLowerCase()===key)
      .forEach(iv=>onCancelPendingInvite&&onCancelPendingInvite(iv.id));
  };

  // Invitation-periode grænser
  const invMinWeek=useMemo(()=>Math.max(0,Math.round((mondayOf(new Date(invitation.startIso))-baseMonday)/(7*864e5))),[invitation,baseMonday]);
  const invMaxWeek=useMemo(()=>Math.min(HORIZON_WEEKS-1,Math.round((mondayOf(new Date(invitation.endIso))-baseMonday)/(7*864e5))),[invitation,baseMonday]);
  useEffect(()=>{setWeekOffset(invMinWeek);},[invitation.startIso,invMinWeek]);
  const setWeekOffsetClamped=(fn)=>setWeekOffset(prev=>{const next=typeof fn==="function"?fn(prev):fn;return Math.max(invMinWeek,Math.min(invMaxWeek,next));});

  const weekDates=useMemo(()=>{
    const s=new Date(baseMonday);s.setDate(s.getDate()+weekOffset*7);
    return Array.from({length:7},(_,i)=>{const d=new Date(s);d.setDate(d.getDate()+i);return d;});
  },[baseMonday,weekOffset]);

  const isPast=(d)=>isoDate(d)<isoDate(today);
  // Kalendermarkeringer scopet til NETOP denne forespørgsel — se kommentaren ved availKey().
  // Uden dette ville "Samlet tilgængelighed"/"Bedste tider"/fastlagte kampe her kunne blande
  // markeringer ind fra andre forespørgsler med overlappende perioder.
  const invAvail=useMemo(()=>{
    const m={};
    scopePlayers.forEach(pl=>{m[pl.id]=avail[availKey(invitation.id,pl.id)]||new Set();});
    return m;
  },[avail,scopePlayers,invitation.id]);
  const countAt=(iso,b)=>scopePlayers.filter(pl=>invAvail[pl.id]?.has(slotKey(iso,b))).length;
  const whoCan=(iso,b)=>scopePlayers.filter(pl=>invAvail[pl.id]?.has(slotKey(iso,b)));
  // Kun dage inden for perioden vises i gitteret
  const visibleDates=weekDates.filter(d=>isoDate(d)>=invitation.startIso&&isoDate(d)<=invitation.endIso);

  const bestTimes=useMemo(()=>{
    return bestConsecutiveSlots(invAvail,scopePlayers,baseMonday,today,threshold,consecHours,invitation.startIso,invitation.endIso);
  },[invAvail,scopePlayers,threshold,consecHours,baseMonday,today,invitation]);

  // Filtreret til den uge der er valgt i "Samlet tilgængelighed" (hvis nogen)
  const filteredBestTimes=useMemo(()=>{
    if(bestTimesWeek==null)return bestTimes;
    return bestTimes.filter(t=>Math.round((mondayOf(t.date)-baseMonday)/(7*864e5))===bestTimesWeek);
  },[bestTimes,bestTimesWeek,baseMonday]);

  // Ugestatus til "Samlet tilgængelighed"
  const weekStatus=useMemo(()=>{
    const arr=[];
    for(let w=0;w<HORIZON_WEEKS;w++){
      const s=new Date(baseMonday);s.setDate(s.getDate()+w*7);
      const e=new Date(s);e.setDate(e.getDate()+6);
      const eIso=isoDate(e);
      const qualifying=bestTimes.filter(t=>t.iso>=isoDate(s)&&t.iso<=eIso).length;
      let anyAvail=0;
      for(let i=0;i<7;i++){const d=new Date(s);d.setDate(d.getDate()+i);const iso=isoDate(d);for(const b of BLOCKS)anyAvail+=countAt(iso,b);}
      arr.push({w,start:new Date(s),qualifying,anyAvail});
    }
    return arr;
  },[bestTimes,baseMonday,invAvail,scopePlayers]);

  // Eksport-funktioner — Bedste tider
  const exportCSV=()=>{
    const rows=[['Dag','Dato','Tidspunkt','Antal spillere','Spillere']];
    filteredBestTimes.forEach(t=>{const names=t.players.map(pid=>players.find(p=>p.id===pid)?.name||pid);rows.push([WD_FULL[t.wd],`${t.date.getDate()}. ${MONTHS[t.date.getMonth()]}`,rangeLabel(t.startBlock,t.hours),`${t.count}/${scopePlayers.length}`,names.join(', ')]);});
    const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
    const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='bedste-tider.csv';a.click();URL.revokeObjectURL(url);
  };
  const exportPDF=()=>{
    const periodStr=`${fmtShort(new Date(invitation.startIso))} – ${fmtShort(new Date(invitation.endIso))}`;
    const rows=filteredBestTimes.map(t=>{const names=t.players.map(pid=>players.find(p=>p.id===pid)?.name||pid);return `<tr><td>${WD_FULL[t.wd]} ${t.date.getDate()}. ${MONTHS[t.date.getMonth()]}</td><td>${rangeLabel(t.startBlock,t.hours)}</td><td style="text-align:center">${t.count}/${scopePlayers.length}</td><td>${names.join(', ')}</td></tr>`;}).join('');
    const html=`<!DOCTYPE html><html lang="da"><head><meta charset="UTF-8"><title>Bedste spilletider</title><style>body{font-family:system-ui,sans-serif;padding:24px;color:#1e293b;font-size:12px}h1{font-size:15px;margin:0 0 4px}p{color:#64748b;margin:0 0 16px}table{width:100%;border-collapse:collapse}th{background:#1e3a5f;color:#fff;padding:7px 9px;text-align:left;font-size:11px}td{padding:5px 9px;border-bottom:1px solid #e2e8f0}tr:nth-child(even){background:#f8fafc}@media print{body{padding:0}}</style></head><body><h1>Bedste spilletider — minimum ${threshold} spillere · ${consecHours} time${consecHours===1?"":"r"} i træk</h1><p>${invitation.title||"Anmodning"} &nbsp;·&nbsp; Periode: ${periodStr} &nbsp;·&nbsp; Genereret ${new Date().toLocaleDateString('da-DK')}</p><table><thead><tr><th>Dato</th><th>Tidspunkt</th><th>Antal</th><th>Spillere</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>window.print();<\/script></body></html>`;
    const win=window.open('','_blank');if(win){win.document.write(html);win.document.close();}
  };
  // Eksport-funktioner — Fastlagte kampe
  const exportMatchesCSV=()=>{
    const rows=[['Dag','Dato','Tidspunkt','Antal spillere']];
    myMatches.forEach(m=>{const d=new Date(m.iso);rows.push([WD_FULL[(d.getDay()+6)%7],`${d.getDate()}. ${MONTHS[d.getMonth()]}`,rangeLabel(m.block,m.hours||1),`${m.count}/${players.length}`]);});
    const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
    const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='fastlagte-kampe.csv';a.click();URL.revokeObjectURL(url);
  };
  const exportMatchesPDF=()=>{
    const rows=myMatches.map(m=>{const d=new Date(m.iso);return `<tr><td>${WD_FULL[(d.getDay()+6)%7]} ${fmtShort(d)}</td><td>${rangeLabel(m.block,m.hours||1)}</td><td style="text-align:center">${m.count}/${players.length}</td></tr>`;}).join('');
    const html=`<!DOCTYPE html><html lang="da"><head><meta charset="UTF-8"><title>Fastlagte kampe</title><style>body{font-family:system-ui,sans-serif;padding:24px;color:#1e293b;font-size:12px}h1{font-size:15px;margin:0 0 4px}p{color:#64748b;margin:0 0 16px}table{width:100%;border-collapse:collapse}th{background:#1e3a5f;color:#fff;padding:7px 9px;text-align:left;font-size:11px}td{padding:5px 9px;border-bottom:1px solid #e2e8f0}tr:nth-child(even){background:#f8fafc}@media print{body{padding:0}}</style></head><body><h1>Fastlagte kampe${invitation.title?" — "+invitation.title:""}</h1><p>Genereret ${new Date().toLocaleDateString('da-DK')}</p><table><thead><tr><th>Dato</th><th>Tidspunkt</th><th>Antal</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>window.print();<\/script></body></html>`;
    const win=window.open('','_blank');if(win){win.document.write(html);win.document.close();}
  };

  const cellColor=(c)=>{
    if(c===0)return"bg-slate-100 text-slate-300";
    if(c>=threshold)return"bg-lime-500 text-white ring-2 ring-lime-600";
    const r=c/Math.max(scopePlayers.length,1);
    if(r>=0.6)return"bg-lime-200 text-lime-900";
    if(r>=0.35)return"bg-amber-100 text-amber-800";
    return"bg-slate-100 text-slate-500";
  };

  const sel=selCell?{...selCell,can:whoCan(selCell.iso,selCell.block)}:null;

  const toggleHeatId=(id)=>setHeatIds(prev=>{const cur=prev||new Set(submittedAcceptedIds);const n=new Set(cur);n.has(id)?n.delete(id):n.add(id);return n;});

  const canDelete=currentUser?.id===invitation.createdById;
  const myResponse=responseFor(invitation,currentUser?.id);
  const pendingAccept=myResponse==="pending";
  const declined=myResponse==="declined";
  const needsMyResponse=myResponse==="accepted"&&!(invitation.submittedIds||[]).includes(currentUser?.id);

  // Livscyklus: aktiv → afsluttet. Når forespørgslen ikke længere er aktiv, er den lukket for
  // de inviterede — de kan ikke længere svare, udfylde kalender eller fastlægge kampe, men alle
  // der har været inviteret kan stadig finde og se den (læsevenligt).
  const reqStatus=invitation.status||"active";
  const isClosed=reqStatus!=="active";
  const [pendingLifecycle,setPendingLifecycle]=useState(false); // bekræftelse før man afslutter forespørgslen
  const [pendingDelete,setPendingDelete]=useState(false); // bekræftelse før man sletter forespørgslen permanent
  const setInvitationStatus=(next)=>updateInvitation(invitation.id,prev=>({...prev,status:next}));
  const copyToDraft=()=>{
    const payload={
      id:newDocId("drafts"),
      title:invitation.title?`${invitation.title} (kopi)`:"",
      description:invitation.description||"",
      startIso:"",endIso:"",submitDeadline:"",deadline:"",
      playerIds:[...invitation.playerIds],minPlayers:invitation.minPlayers,consecHours:invitation.consecHours,
      avatarImage:invitation.avatarImage||null,avatarEmoji:invitation.avatarEmoji||null,
      createdById:currentUser.id,createdByName:currentUser.name,
    };
    setDrafts(prev=>[...prev,payload]);
    setOpenDraftId(payload.id);
    setTab("forespoergsel");
  };

  const respondToInvitation=(status)=>{
    updateInvitation(invitation.id,prev=>({...prev,responses:{...(prev.responses||{}),[currentUser.id]:status}}));
  };

  /* ── Genbrugte blokke ────────────────────────────────────── */
  const notYetSubmittedCount=acceptedIds.length-submittedAcceptedIds.length;
  const teamThresholdBlock=(
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
          <Users size={13}/> Med i beregningen ({scopePlayers.length}/{submittedPlayers.length})
        </span>
        <div className="flex gap-2">
          <button onClick={()=>setHeatIds(new Set(submittedAcceptedIds))} className="text-xs text-blue-600 hover:underline">Vælg alle</button>
          <button onClick={()=>setHeatIds(new Set())} className="text-xs text-blue-600 hover:underline">Fravælg alle</button>
        </div>
      </div>
      {notYetSubmittedCount>0&&(
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-3">
          {notYetSubmittedCount} accepteret{notYetSubmittedCount===1?"":"e"} spiller{notYetSubmittedCount===1?"":"e"} har endnu ikke indsendt sine tider til <em>denne</em> forespørgsel og tæller derfor ikke med her — se "Indsendelser" nedenfor.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {submittedPlayers.map(pl=>{
          const on=(heatIds||new Set(submittedAcceptedIds)).has(pl.id);
          return(
            <button key={pl.id} onClick={()=>toggleHeatId(pl.id)}
              className={`inline-flex items-center gap-1.5 rounded-full pl-1 pr-2.5 py-0.5 text-xs transition-colors ${on?"bg-blue-100 text-blue-800 ring-1 ring-blue-300":"bg-slate-100 text-slate-400 line-through"}`}>
              <span className={`w-5 h-5 rounded-full grid place-items-center text-[9px] font-bold overflow-hidden ${on?"bg-blue-700 text-white":"bg-slate-300 text-white"}`}>{avatarContent(pl)}</span>
              {pl.name}
            </button>
          );
        })}
      </div>
      {/* Krav til antal spillere/sammenhængende timer vises kun her — ændres ikke direkte,
          kun via "Rediger" på forespørgslen (og kræver ikke fornyet accept fra spillerne). */}
      <div className="flex items-center gap-2 border-t border-slate-100 pt-3 flex-wrap text-sm text-slate-600">
        <span>Mindst <span className="font-semibold text-slate-800">{threshold}</span> spillere kan <span className="font-semibold text-slate-800">{consecHours}</span> sammenhængende time{consecHours===1?"":"r"} i træk</span>
        {canDelete&&<span className="text-[10px] text-slate-400 italic">(ret via Rediger)</span>}
      </div>
    </div>
  );

  const calendarGridBlock=(
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <WeekNav weekOffset={weekOffset} setWeekOffset={setWeekOffsetClamped} weekDates={weekDates} minWeek={invMinWeek} maxWeek={invMaxWeek}/>
      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{borderSpacing:"3px 2px",tableLayout:"fixed"}}>
          <thead><tr><th className="w-16"/>
            {visibleDates.map((d,i)=>{const past=isPast(d),isToday=isoDate(d)===isoDate(today);const di=(d.getDay()+6)%7;return(
              <th key={i} className="text-center align-bottom pb-1">
                <div className={`text-[10px] font-semibold ${past?"text-slate-300":"text-slate-400"}`}>{DAY_KEYS[di]}</div>
                <div className={`text-sm font-bold ${past?"text-slate-300":isToday?"text-lime-600":"text-slate-800"}`}>{d.getDate()}</div>
                <div className={`text-[9px] ${past?"text-slate-300":"text-slate-400"}`}>{MONTHS[d.getMonth()]}</div>
              </th>);})}</tr></thead>
          <tbody>{BLOCKS.map(b=>(
            <tr key={b}><td className="text-[10px] font-medium text-slate-400 pr-1 whitespace-nowrap align-middle">{blockLabel(b)}</td>
              {visibleDates.map((d,i)=>{const iso=isoDate(d),past=isPast(d),c=past?0:countAt(iso,b),isSel=sel?.iso===iso&&sel?.block===b;const di=(d.getDay()+6)%7;return(
                <td key={i} className="p-0"><button disabled={past} onClick={()=>setSelCell({iso,block:b})}
                  className={`w-full rounded text-[10px] font-semibold grid place-items-center ${past?"bg-slate-50 text-slate-200 cursor-not-allowed":cellColor(c)} ${isSel?"outline outline-2 outline-blue-600":""}`}
                  style={{height:22}} title={past?"":` ${WD_FULL[di]} ${fmtShort(d)} · ${blockLabel(b)} · ${c} kan`}>
                  {past?"":c||""}
                </button></td>);})}</tr>
          ))}</tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-slate-500 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-lime-500 ring-2 ring-lime-600 inline-block"/> ≥{threshold}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-lime-200 inline-block"/> mange</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-100 inline-block"/> nogle</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-100 border border-slate-200 inline-block"/> få</span>
      </div>
      {sel&&(
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="text-sm font-semibold text-slate-800 mb-2">
            {(()=>{const d=new Date(sel.iso);return `${WD_FULL[(d.getDay()+6)%7]} ${fmtShort(d)}`;})()}
            {" · "}{blockLabel(sel.block)} — {sel.can.length}/{scopePlayers.length} kan
          </div>
          <div className="flex flex-wrap gap-1.5">
            {scopePlayers.map(pl=>{const ok=sel.can.some(x=>x.id===pl.id);return(
              <span key={pl.id} className={`inline-flex items-center gap-1 rounded-full pl-1 pr-2 py-0.5 text-xs ${ok?"bg-lime-100 text-lime-800":"bg-slate-100 text-slate-400 line-through"}`}>
                <span className={`w-4 h-4 rounded-full grid place-items-center text-[8px] font-bold overflow-hidden ${ok?"bg-lime-600 text-white":"bg-slate-300 text-white"}`}>{avatarContent(pl)}</span>
                {pl.name.split(" ")[0]}
              </span>);})}</div>
        </div>
      )}
    </div>
  );

  const availabilityBlock=(
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Samlet tilgængelighed</div>
      <p className="text-xs text-slate-400 mb-2">Grøn = mindst {threshold} spillere kan {consecHours} sammenhængende time{consecHours===1?"":"r"} i ugen.</p>
      <div className="flex items-end gap-0.5" style={{height:44}}>
        {weekStatus.filter(x=>x.w>=invMinWeek&&x.w<=invMaxWeek).map(({w,start,qualifying,anyAvail})=>{
          const active=w===bestTimesWeek;
          const color=qualifying>0?(active?"bg-lime-700":"bg-lime-500 hover:bg-lime-600"):anyAvail>0?(active?"bg-amber-500":"bg-amber-300 hover:bg-amber-400"):(active?"bg-slate-300":"bg-slate-100 hover:bg-slate-200");
          const h=qualifying>0?100:anyAvail>0?50:15;
          return(<button key={w} onClick={()=>{setWeekOffsetClamped(w);setBestTimesWeek(prev=>prev===w?null:w);}} title={`Uge ${getISOWeek(start)} · ${fmtShort(start)}${qualifying>0?` · ${qualifying} kvalificerende tider`:""}`}
            className="flex-1 flex flex-col items-center justify-end group" style={{height:"100%"}}>
            <div className={`w-full rounded-t transition-colors ${color}`} style={{height:`${h}%`}}/>
          </button>);
        })}
      </div>
      <div className="flex gap-0.5 mt-0.5">
        {weekStatus.filter(x=>x.w>=invMinWeek&&x.w<=invMaxWeek).map(({w,start},idx)=>(
          <div key={w} className="flex-1 text-center">{idx%3===0&&<span className="text-[9px] text-slate-400">U{getISOWeek(start)}</span>}</div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-slate-500 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-lime-500 inline-block"/> Kan stille hold</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-300 inline-block"/> Nogen tilgængelighed</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-100 border border-slate-200 inline-block"/> Ingen</span>
        <span className="text-slate-400">— klik en uge for at filtrere Bedste tider</span>
      </div>
    </div>
  );

  const bestTimesBlock=(
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
          <Sparkles size={14} className="text-amber-500"/> Bedste tider ({filteredBestTimes.length})
        </div>
        <div className="flex items-center gap-2">
          {bestTimesWeek!=null&&(
            <button onClick={()=>setBestTimesWeek(null)}
              className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-full pl-2.5 pr-1.5 py-1 font-medium hover:bg-blue-100">
              Uge {getISOWeek(weekDates[0])} <X size={11}/>
            </button>
          )}
          {filteredBestTimes.length>0&&(
            <div className="flex gap-1.5">
              <button onClick={exportCSV} className="inline-flex items-center gap-1 text-xs text-green-700 border border-green-200 bg-green-50 hover:bg-green-100 rounded-lg px-2.5 py-1.5 font-medium">
                <FileSpreadsheet size={12}/> Excel
              </button>
              <button onClick={exportPDF} className="inline-flex items-center gap-1 text-xs text-red-700 border border-red-200 bg-red-50 hover:bg-red-100 rounded-lg px-2.5 py-1.5 font-medium">
                <FileText size={12}/> PDF
              </button>
            </div>
          )}
        </div>
      </div>
      {filteredBestTimes.length===0?<p className="text-sm text-slate-500">{bestTimesWeek!=null?"Ingen kvalificerende tider i den valgte uge.":"Ingen tider. Prøv lavere tærskel eller færre sammenhængende timer."}</p>:(()=>{
        // Gruppér efter måned → uge → dato
        const groups=[];
        let lastMonth=null,lastWeek=null;
        filteredBestTimes.forEach((t,i)=>{
          const mKey=`${t.date.getFullYear()}-${t.date.getMonth()}`;
          const wKey=`${t.date.getFullYear()}-${getISOWeek(t.date)}`;
          if(mKey!==lastMonth){lastMonth=mKey;lastWeek=null;groups.push({type:'month',label:MONTHS_FULL[t.date.getMonth()]+' '+t.date.getFullYear(),key:mKey});}
          // Nøglen for uge-overskriften kombineres med måneds-nøglen, så en uge der går på tværs af
          // en månedsgrænse (og derfor vises igen under den nye måned) ikke får samme React-key to gange.
          if(wKey!==lastWeek){lastWeek=wKey;groups.push({type:'week',label:`Uge ${getISOWeek(t.date)}`,key:`${mKey}|${wKey}`});}
          groups.push({type:'slot',t,i});
        });
        return(
          <div className="max-h-96 overflow-y-auto space-y-0.5 -mx-1 px-1">
            {groups.map(g=>{
              if(g.type==='month')return(
                <div key={g.key} className="sticky top-0 z-10 bg-white pt-2 pb-1 border-b border-slate-200">
                  <span className="text-xs font-bold text-blue-900 uppercase tracking-wide">{g.label}</span>
                </div>
              );
              if(g.type==='week')return(
                <div key={g.key} className="px-1 pt-2 pb-0.5">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{g.label}</span>
                </div>
              );
              const {t,i}=g;
              const slotKeyStr=`${t.iso}|${t.startBlock}`;
              const isExpanded=expandedBestTimes.has(slotKeyStr);
              const canPlayers=(t.players||[]).map(pid=>players.find(p=>p.id===pid)).filter(Boolean);
              return(
                <div key={i} className="bg-slate-50 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm min-w-0">
                      <span className="font-medium text-slate-800">{WD_FULL[t.wd]} {fmtShort(t.date)}</span>
                      <span className="text-slate-500"> · {rangeLabel(t.startBlock,t.hours)}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${t.count===scopePlayers.length?"bg-lime-600 text-white":"bg-lime-100 text-lime-800"}`}>{t.count}/{scopePlayers.length}</span>
                      <button onClick={()=>{
                          setExpandedBestTimes(prev=>{const n=new Set(prev);n.has(slotKeyStr)?n.delete(slotKeyStr):n.add(slotKeyStr);return n;});
                        }} className="text-xs text-blue-700 hover:underline">{isExpanded?"Skjul":"Vis"}</button>
                      {myMatches.some(m=>m.iso===t.iso&&m.block===t.startBlock&&(m.hours||1)===t.hours)
                        ?<span className="text-xs text-lime-700 font-semibold flex items-center gap-0.5"><CheckCircle2 size={11}/> Fastlagt</span>
                        :canDelete&&!isClosed
                          ?<button onClick={()=>setMatches(prev=>[...prev,{id:newDocId("matches"),invitationId:invitation.id,iso:t.iso,block:t.startBlock,hours:t.hours,count:t.count,players:t.players}])}
                              className="text-xs bg-lime-600 text-white rounded-lg px-2 py-1 hover:bg-lime-700 font-medium">Fastlæg</button>
                          :null
                      }
                    </div>
                  </div>
                  {isExpanded&&(
                    <div className="mt-1.5 pt-1.5 border-t border-slate-200 flex flex-wrap gap-1.5">
                      {canPlayers.length===0?<span className="text-xs text-slate-400">Ingen spillere.</span>:canPlayers.map(pl=>(
                        <span key={pl.id} className="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-full pl-1 pr-2 py-0.5 text-xs text-slate-700">
                          <span className="w-4 h-4 rounded-full bg-blue-700 text-white grid place-items-center text-[8px] font-bold overflow-hidden">{avatarContent(pl)}</span>
                          {pl.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );

  // Hvilke spillere kan deltage i en given fastlagt kamp — bruger den liste der blev gemt da kampen
  // blev fastlagt; findes den undtagelsesvist ikke (ældre data), beregnes den ud fra tilgængeligheden.
  const playersForMatch=(m)=>{
    let ids=m.players;
    if(!ids){
      const hours=m.hours||1;
      ids=scopePlayers.filter(pl=>{
        for(let h=0;h<hours;h++){if(!invAvail[pl.id]?.has(slotKey(m.iso,m.block+h)))return false;}
        return true;
      }).map(pl=>pl.id);
    }
    return ids.map(pid=>players.find(p=>p.id===pid)).filter(Boolean);
  };
  const matchKey=(m,i)=>`${m.iso}|${m.block}|${i}`;
  const toggleMatchExpanded=(k)=>setExpandedMatches(prev=>{const n=new Set(prev);n.has(k)?n.delete(k):n.add(k);return n;});

  const matchesBlock=(
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
          <Calendar size={13} className="text-blue-600"/> Fastlagte kampe ({myMatches.length})
        </div>
        {myMatches.length>0&&(
          <div className="flex gap-1.5">
            <button onClick={exportMatchesCSV} className="inline-flex items-center gap-1 text-xs text-green-700 border border-green-200 bg-green-50 hover:bg-green-100 rounded-lg px-2.5 py-1.5 font-medium">
              <FileSpreadsheet size={12}/> Excel
            </button>
            <button onClick={exportMatchesPDF} className="inline-flex items-center gap-1 text-xs text-red-700 border border-red-200 bg-red-50 hover:bg-red-100 rounded-lg px-2.5 py-1.5 font-medium">
              <FileText size={12}/> PDF
            </button>
          </div>
        )}
      </div>
      {myMatches.length===0
        ?<p className="text-sm text-slate-400">{canDelete?<>Ingen kampe fastlagt endnu — klik <strong>Fastlæg</strong> på en af de bedste tider ovenfor.</>:"Ingen kampe fastlagt endnu."}</p>
        :<ul className="space-y-1.5">
          {myMatches.map((m,i)=>{
            const k=matchKey(m,i);
            const isExpanded=expandedMatches.has(k);
            const canPlayers=isExpanded?playersForMatch(m):[];
            return(
              <li key={m.id||i} className="bg-lime-50 border border-lime-200 rounded-lg px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm min-w-0">
                    <span className="text-slate-400 text-xs mr-1">U{getISOWeek(new Date(m.iso))}</span>
                    <span className="font-semibold text-slate-800">{WD_FULL[(new Date(m.iso).getDay()+6)%7]} {fmtShort(new Date(m.iso))}</span>
                    <span className="text-slate-500"> · {rangeLabel(m.block,m.hours||1)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-bold text-lime-700">{m.count}/{invitation.playerIds.length}</span>
                    <button onClick={()=>toggleMatchExpanded(k)} className="text-xs text-blue-700 hover:underline">{isExpanded?"Skjul":"Vis"}</button>
                    {canDelete&&!isClosed&&<button onClick={()=>setMatches(prev=>prev.filter(x=>x!==m))}
                      className="text-slate-400 hover:text-red-500"><X size={14}/></button>}
                  </div>
                </div>
                {isExpanded&&(
                  <div className="mt-1.5 pt-1.5 border-t border-lime-200 flex flex-wrap gap-1.5">
                    {canPlayers.length===0?<span className="text-xs text-slate-400">Ingen spillere.</span>:canPlayers.map(pl=>(
                      <span key={pl.id} className="inline-flex items-center gap-1 bg-white border border-lime-200 rounded-full pl-1 pr-2 py-0.5 text-xs text-slate-700">
                        <span className="w-4 h-4 rounded-full bg-blue-700 text-white grid place-items-center text-[8px] font-bold overflow-hidden">{avatarContent(pl)}</span>
                        {pl.name}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      }
    </div>
  );

  const pendingAcceptPlayers=useMemo(()=>players.filter(p=>invitation.playerIds.includes(p.id)&&responseFor(invitation,p.id)==="pending"),[players,invitation]);
  const declinedPlayers=useMemo(()=>players.filter(p=>invitation.playerIds.includes(p.id)&&responseFor(invitation,p.id)==="declined"),[players,invitation]);

  const submissionsBlock=(()=>{
    const submittedSet=new Set([...(invitation.submittedIds||[]),...(lockedPlayers||[])]);
    // Statuslinjen viser kun status blandt de spillere der allerede har accepteret invitationen.
    const total=invitedPlayers.length;
    const submittedCount=invitedPlayers.filter(pl=>submittedSet.has(pl.id)).length;
    const unlockAll=()=>{
      updateInvitation(invitation.id,prev=>({...prev,submittedIds:[]}));
      setLockedPlayers&&setLockedPlayers(new Set());
    };
    const unlockPlayer=(id)=>{
      updateInvitation(invitation.id,prev=>({...prev,submittedIds:(prev.submittedIds||[]).filter(x=>x!==id)}));
      setLockedPlayers&&setLockedPlayers(prev=>{const n=new Set(prev);n.delete(id);return n;});
    };
    const loginAsPlayer=(pl)=>toggleHelpPlayer(pl);
    return(
      <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Send size={14} className="text-blue-600"/> Indsendelser ({submittedCount}/{total})
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {fmtShort(new Date(invitation.startIso))} – {fmtShort(new Date(invitation.endIso))}
              {invitation.submitDeadline&&<span> · Frist: <strong>{fmtShort(new Date(invitation.submitDeadline))}</strong></span>}
            </div>
          </div>
          {canDelete&&!isClosed&&(
            <button onClick={()=>setPendingUnlock("all")}
              className="inline-flex items-center gap-1.5 text-xs text-slate-600 border border-slate-200 bg-slate-50 hover:bg-slate-100 rounded-lg px-3 py-2 font-medium">
              <Lock size={12}/> Frigiv alle
            </button>
          )}
        </div>
        {pendingUnlock&&(
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
            <div className="text-sm text-amber-800">
              {pendingUnlock==="all"
                ?"Er du sikker på at du vil frigive alle spilleres indsendelser? De skal så indsende deres tider igen."
                :<>Er du sikker på at du vil frigive <span className="font-semibold">{invitedPlayers.find(p=>p.id===pendingUnlock)?.name}</span>s indsendelse? De skal så indsende deres tider igen.</>}
            </div>
            <div className="flex gap-2">
              <button onClick={()=>{pendingUnlock==="all"?unlockAll():unlockPlayer(pendingUnlock);setPendingUnlock(null);}}
                className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg py-2">Ja, frigiv</button>
              <button onClick={()=>setPendingUnlock(null)} className="flex-1 bg-white border border-amber-300 text-amber-800 text-sm font-semibold rounded-lg py-2">Nej</button>
            </div>
          </div>
        )}
        {(pendingAcceptPlayers.length>0||myPendingInvitesForThis.length>0)&&(
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1.5">
            <div className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
              <Bell size={12}/> Inviteret, afventer ({pendingAcceptPlayers.length+myPendingInvitesForThis.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pendingAcceptPlayers.map(pl=>(
                <span key={pl.id} className="inline-flex items-center gap-1.5 text-xs bg-white text-amber-700 border border-amber-200 rounded-full pl-1 pr-2 py-1">
                  <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 grid place-items-center text-[9px] font-bold shrink-0 overflow-hidden">{avatarContent(pl)}</span>
                  {pl.name.split(" ")[0]} <span className="text-amber-400">afventer accept</span>
                  {canDelete&&!isClosed&&pl.id!==currentUser?.id&&<button onClick={()=>loginAsPlayer(pl)} title="Hjælp med at acceptere/afslå for denne spiller" className="text-amber-400 hover:text-blue-600 ml-0.5"><LogIn size={11}/></button>}
                </span>
              ))}
              {myPendingInvitesForThis.map(inv=>(
                <span key={inv.id} className="inline-flex items-center gap-1.5 text-xs bg-white text-amber-700 border border-amber-200 rounded-full pl-1 pr-2 py-1">
                  <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 grid place-items-center shrink-0"><Mail size={10}/></span>
                  {inv.name} <span className="text-amber-400">afventer accept</span>
                  {canDelete&&!isClosed&&onCancelPendingInvite&&<button onClick={()=>cancelAllPendingInvitesForEmail(inv.email)} title="Fortryd invitation" className="text-amber-400 hover:text-red-500 ml-0.5"><X size={11}/></button>}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {invitedPlayers.map(pl=>{
            const submitted=submittedSet.has(pl.id);
            const comment=invitation.comments?.[pl.id];
            return(
              <div key={pl.id} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 border ${submitted?"bg-lime-50 border-lime-200":"bg-slate-50 border-slate-200"}`} title={canDelete&&comment?`Kommentar: ${comment}`:undefined}>
                <span className={`w-5 h-5 rounded-full grid place-items-center text-[8px] font-bold shrink-0 overflow-hidden ${submitted?"bg-lime-600 text-white":"bg-slate-300 text-white"}`}>
                  {avatarContent(pl)}
                </span>
                <span className={`text-xs flex-1 truncate ${submitted?"text-lime-800 font-medium":"text-slate-500"}`}>{pl.name.split(" ")[0]}</span>
                {canDelete&&comment&&<Info size={11} className="text-blue-400 shrink-0"/>}
                {canDelete&&!isClosed&&pl.id!==currentUser?.id&&(
                  <button onClick={()=>loginAsPlayer(pl)} title={helpingPlayerId===pl.id?"Skjul hjælp":"Hjælp med at udfylde for denne spiller"}
                    className={`shrink-0 ${helpingPlayerId===pl.id?"text-blue-600":"text-slate-400 hover:text-blue-600"}`}><LogIn size={11}/></button>
                )}
                {submitted
                  ?(canDelete&&!isClosed
                      ?<button onClick={()=>setPendingUnlock(pl.id)} title="Indsendt — klik for at frigive spilleren" className="group text-lime-600 hover:text-red-500 shrink-0">
                        <CheckCircle2 size={13} className="group-hover:hidden"/>
                        <X size={13} className="hidden group-hover:block"/>
                      </button>
                      :<CheckCircle2 size={13} className="text-lime-600 shrink-0"/>)
                  :<span className="w-[13px] h-[13px] rounded-full border-2 border-slate-300 shrink-0" title="Afventer indsendelse"/>
                }
              </div>
            );
          })}
        </div>
        {canDelete&&invitedPlayers.some(pl=>invitation.comments?.[pl.id])&&(
          <div className="space-y-1 border-t border-slate-100 pt-2">
            {invitedPlayers.filter(pl=>invitation.comments?.[pl.id]).map(pl=>(
              <div key={pl.id} className="text-xs bg-blue-50 border border-blue-100 rounded-lg px-2.5 py-1.5">
                <span className="font-semibold text-blue-800">{pl.name.split(" ")[0]}:</span> <span className="text-blue-700">{invitation.comments[pl.id]}</span>
              </div>
            ))}
          </div>
        )}
        <div className="bg-slate-100 rounded-full h-1.5">
          <div className="bg-lime-500 h-1.5 rounded-full transition-all"
            style={{width:`${total?Math.round(submittedCount/total*100):0}%`}}/>
        </div>
        {declinedPlayers.length>0&&(
          <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-100">
            {declinedPlayers.map(pl=>(
              <span key={pl.id} className="inline-flex items-center gap-1 text-[10px] bg-slate-50 text-slate-400 border border-slate-200 rounded-full px-2 py-0.5 line-through">{pl.name.split(" ")[0]} afslog</span>
            ))}
          </div>
        )}
      </div>
    );
  })();

  return(
    <div id={`inv-${invitation.id}`} className="bg-white rounded-2xl border border-slate-200 hover:border-blue-300 transition-colors scroll-mt-4">
      <div className="flex items-start gap-2 p-4">
        <button type="button" onClick={()=>setExpanded(v=>!v)} className="flex items-start gap-3 flex-1 min-w-0 text-left">
          <div className="w-10 h-10 rounded-xl bg-blue-50 grid place-items-center shrink-0 overflow-hidden text-xl">
            {invitation.avatarImage
              ?<img src={invitation.avatarImage} alt="" className="w-full h-full object-cover"/>
              :invitation.avatarEmoji
                ?<span>{invitation.avatarEmoji}</span>
                :<Bell size={18} className="text-blue-600"/>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-sm font-semibold text-slate-800">{invitation.title||"Anmodning om spilletider"}</div>
              {!isClosed&&pendingAccept&&<span className="text-[10px] bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-semibold shrink-0">Afventer din accept</span>}
              {!isClosed&&declined&&<span className="text-[10px] bg-slate-100 text-slate-500 rounded-full px-2 py-0.5 font-semibold shrink-0">Afslået</span>}
              {!isClosed&&needsMyResponse&&<span className="inline-flex items-center gap-1 text-xs bg-amber-500 text-white rounded-full px-2.5 py-1 font-bold shrink-0"><Bell size={11}/> Besvar</span>}
              {myMatches.length>0&&<span className="inline-flex items-center gap-1 text-[10px] bg-lime-50 text-lime-700 rounded-full px-2 py-0.5 shrink-0"><CheckCircle2 size={9}/> {myMatches.length} kamp{myMatches.length===1?"":"e"} fastlagt</span>}
            </div>
            <ReqMeta item={invitation} pendingInviteCount={myPendingInvitesForThis.length}/>
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {canDelete&&(
            <div className="relative">
              <button type="button" onClick={()=>setMenuOpen(v=>!v)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
                <MoreVertical size={16}/>
              </button>
              {menuOpen&&(
                <>
                  <div className="fixed inset-0 z-10" onClick={()=>setMenuOpen(false)}/>
                  <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-20 w-52">
                    {!isClosed&&(
                      <button type="button" onClick={()=>{setMenuOpen(false);startEditing();}}
                        className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                        <Edit2 size={13}/> Rediger forespørgsel
                      </button>
                    )}
                    {reqStatus==="active"&&(
                      <button type="button" onClick={()=>{setMenuOpen(false);setPendingLifecycle(true);}}
                        className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                        <Lock size={13}/> Afslut forespørgsel
                      </button>
                    )}
                    {isClosed&&(
                      <button type="button" onClick={()=>{setMenuOpen(false);setInvitationStatus("active");}}
                        className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2">
                        <RotateCcw size={13}/> Genåbn forespørgsel
                      </button>
                    )}
                    <button type="button" onClick={()=>{setMenuOpen(false);copyToDraft();}}
                      className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 border-t border-slate-100">
                      <Copy size={13}/> Kopiér til kladde
                    </button>
                    <button type="button" onClick={()=>{setMenuOpen(false);setPendingDelete(true);}}
                      className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 border-t border-slate-100">
                      <Trash2 size={13}/> Slet forespørgsel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <button type="button" onClick={()=>setExpanded(v=>!v)} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
            <ChevronDown size={16} className={`transition-transform ${expanded?"rotate-180":""}`}/>
          </button>
        </div>
      </div>

      {pendingLifecycle&&(
        <div className="mx-4 mb-4 bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <div className="text-sm text-amber-800">
            Er du sikker på at du vil afslutte forespørgslen? Den lukkes for de inviterede — de kan ikke længere svare, udfylde kalender eller ændre noget. Alle der har været inviteret kan stadig finde den under "Afsluttede".
          </div>
          <div className="flex gap-2">
            <button onClick={()=>{setInvitationStatus("completed");setPendingLifecycle(false);}}
              className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg py-2">
              Ja, afslut
            </button>
            <button onClick={()=>setPendingLifecycle(false)} className="flex-1 bg-white border border-amber-300 text-amber-800 text-sm font-semibold rounded-lg py-2">Nej</button>
          </div>
        </div>
      )}

      {pendingDelete&&(
        <div className="mx-4 mb-4 bg-red-50 border border-red-200 rounded-xl p-3 space-y-2">
          <div className="text-sm text-red-800">
            Er du sikker på at du vil slette forespørgslen permanent? Den forsvinder for dig og alle inviterede og kan ikke genskabes.
          </div>
          <div className="flex gap-2">
            <button onClick={()=>deleteInvitation(invitation.id)}
              className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg py-2">
              Ja, slet permanent
            </button>
            <button onClick={()=>setPendingDelete(false)} className="flex-1 bg-white border border-red-300 text-red-800 text-sm font-semibold rounded-lg py-2">Nej</button>
          </div>
        </div>
      )}

      {isClosed&&expanded&&(
        <div className="mx-4 mb-4 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm text-slate-600 flex items-center gap-2">
          <Lock size={14} className="text-slate-400 shrink-0"/>
          Denne forespørgsel er afsluttet og lukket for de inviterede — den kan ses, men ikke længere besvares eller ændres.
          {canDelete&&<button onClick={()=>setInvitationStatus("active")} className="ml-auto text-blue-700 hover:underline font-medium shrink-0">Genåbn</button>}
        </div>
      )}

      {expanded&&editing&&(
        <div className="px-4 pb-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Billede til rubrik</label>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-blue-50 grid place-items-center shrink-0 overflow-hidden text-xl border border-slate-200">
                {editAvatarImage
                  ?<img src={editAvatarImage} alt="" className="w-full h-full object-cover"/>
                  :editAvatarEmoji
                    ?<span>{editAvatarEmoji}</span>
                    :<Bell size={18} className="text-blue-600"/>}
              </div>
              <button type="button" onClick={()=>editAvatarFileRef.current&&editAvatarFileRef.current.click()}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-100 font-medium text-slate-600">Upload foto</button>
              <button type="button" onClick={()=>setEditShowEmojiPicker(v=>!v)}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-100 font-medium text-slate-600">Vælg emoji</button>
              {(editAvatarImage||editAvatarEmoji)&&(
                <button type="button" onClick={()=>{setEditAvatarImage(null);setEditAvatarEmoji(null);}} className="text-xs text-slate-400 hover:text-red-500">Nulstil</button>
              )}
              <input ref={editAvatarFileRef} type="file" accept="image/*" className="hidden" onChange={e=>{
                const file=e.target.files?.[0];e.target.value="";if(!file)return;
                const reader=new FileReader();reader.onload=()=>{setEditAvatarImage(reader.result);setEditAvatarEmoji(null);setEditShowEmojiPicker(false);};reader.readAsDataURL(file);
              }}/>
            </div>
            {editShowEmojiPicker&&(
              <div className="flex flex-wrap gap-1 mt-2 bg-slate-50 border border-slate-200 rounded-lg p-2">
                {EDIT_EMOJI_CHOICES.map(em=>(
                  <button type="button" key={em} onClick={()=>{setEditAvatarEmoji(em);setEditAvatarImage(null);setEditShowEmojiPicker(false);}} className="w-8 h-8 rounded-lg hover:bg-white text-lg grid place-items-center">{em}</button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Titel</label>
            <input type="text" value={editTitle} onChange={e=>setEditTitle(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Beskrivelse</label>
            <textarea value={editDescription} onChange={e=>setEditDescription(e.target.value)} rows={3}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Periode der forespørges på</label>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="date" value={editStart} onChange={e=>setEditStart(e.target.value)}
                className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              <span className="text-slate-400 text-sm">til</span>
              <input type="date" value={editEnd} min={editStart} onChange={e=>setEditEnd(e.target.value)}
                className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            {datesChanged&&(
              <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1"><Bell size={11}/> Datoerne er ændret — alle spillere skal acceptere forespørgslen igen, når du gemmer. Allerede indtastede tider bevares.</p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Frist for indrapportering</label>
            <input type="date" value={editSubmitDeadline} max={editEnd} onChange={e=>setEditSubmitDeadline(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Sidste kamp forventes planlagt</label>
            <input type="date" value={editDeadline} min={editSubmitDeadline||undefined} onChange={e=>setEditDeadline(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Krav for "Samlet tilgængelighed" og "Bedste tider"</label>
            {/* Pile-vælgere for begge krav, stillet i et grid så de to rækker linjer op under hinanden */}
            <div className="grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-2 w-fit">
              <span className="text-sm text-slate-600 whitespace-nowrap">Min. spillere</span>
              <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
                <button type="button" onClick={()=>setEditMinPlayers(v=>Math.max(1,v-1))} disabled={editMinPlayers<=1}
                  className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Færre spillere"><ChevronLeft size={15}/></button>
                <span className="px-3 py-1.5 text-sm font-semibold bg-blue-700 text-white min-w-[2.25rem] text-center">{editMinPlayers}</span>
                <button type="button" onClick={()=>setEditMinPlayers(v=>Math.min(99,v+1))} disabled={editMinPlayers>=99}
                  className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Flere spillere"><ChevronRight size={15}/></button>
              </div>
              <span className="text-sm text-slate-600 whitespace-nowrap">Sammenh. timer</span>
              <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
                <button type="button" onClick={()=>setEditConsecHours(v=>Math.max(1,v-1))} disabled={editConsecHours<=1}
                  className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Færre timer"><ChevronLeft size={15}/></button>
                <span className="px-3 py-1.5 text-sm font-semibold bg-blue-700 text-white min-w-[2.25rem] text-center">{editConsecHours}</span>
                <button type="button" onClick={()=>setEditConsecHours(v=>Math.min(4,v+1))} disabled={editConsecHours>=4}
                  className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Flere timer"><ChevronRight size={15}/></button>
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Spillere i forespørgslen ({editPlayers.size})</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {[...editPlayers].map(id=>{
                const pl=players.find(p=>p.id===id);
                if(!pl)return null;
                const isNew=!invitation.playerIds.includes(id);
                return(
                  <span key={id} className={`inline-flex items-center gap-1.5 rounded-full pl-1 pr-2 py-0.5 text-xs border ${isNew?"bg-lime-50 border-lime-200 text-lime-800":"bg-blue-50 border-blue-200 text-blue-800"}`}>
                    <span className="w-5 h-5 rounded-full bg-blue-700 text-white grid place-items-center text-[9px] font-bold shrink-0 overflow-hidden">
                      {pl.avatarImage?<img src={pl.avatarImage} alt="" className="w-full h-full object-cover"/>:pl.avatarEmoji?<span className="text-[10px]">{pl.avatarEmoji}</span>:initials(pl.name)}
                    </span>
                    {pl.name}{isNew&&<span className="text-lime-500">(ny)</span>}
                    <button type="button" onClick={()=>removeEditPlayer(id)} className="text-slate-400 hover:text-red-500 ml-0.5"><X size={11}/></button>
                  </span>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400 mb-1.5">Kun venner kan søges frem her. Tilføj flere venner via Venner-menuen.</p>
            <div className="relative">
              <input type="text" value={editPlayerSearch} onChange={e=>setEditPlayerSearch(e.target.value)} placeholder="Søg blandt dine venner…"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              {editSearchResults.length>0&&(
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {editSearchResults.map(pl=>(
                    <button type="button" key={pl.id} onClick={()=>addEditPlayer(pl.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-50 text-sm">
                      <span className="w-5 h-5 rounded-full bg-blue-700 text-white grid place-items-center text-[9px] font-bold shrink-0 overflow-hidden">{avatarContent(pl)}</span>
                      {pl.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-slate-100 mt-3 pt-3 space-y-2">
              <div className="text-xs font-medium text-slate-600">Inviter en ny spiller (findes ikke endnu)</div>
              {pendingFriendReqsForThisInvitation.length>0&&(
                <div className="space-y-1">
                  {pendingFriendReqsForThisInvitation.map(req=>(
                    <div key={req.id} className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 grid place-items-center shrink-0"><UserPlus size={10}/></span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs text-slate-700 truncate">{req.player?.name||"Ukendt spiller"}</span>
                        <span className="block text-[10px] text-slate-400 truncate">Har allerede en konto — afventer accept af venneanmodning</span>
                      </span>
                      <button type="button" onClick={()=>onCancelFriendRequest&&onCancelFriendRequest(req.id)} title="Fortryd anmodning" className="text-slate-400 hover:text-red-500 shrink-0"><X size={13}/></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2 flex-wrap">
                <input type="text" placeholder="Navn" value={editNewName} onChange={e=>setEditNewName(e.target.value)}
                  className="flex-1 min-w-28 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                <input type="email" placeholder="E-mail" value={editNewEmail} onChange={e=>setEditNewEmail(e.target.value)}
                  className="flex-1 min-w-36 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                <button type="button" onClick={inviteNewEditPlayer} disabled={editInviteBusy||!editNewName.trim()||!editEmailValid(editNewEmail)||!!editNewEmailMatch}
                  className="inline-flex items-center gap-1.5 bg-blue-700 text-white text-sm font-medium rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-blue-800">
                  <UserPlus size={14}/> {editInviteBusy?"Sender…":"Inviter"}
                </button>
              </div>
              {editNewEmailMatch?.type==="existing"&&(
                pendingFriendReqsForThisInvitation.some(r=>r.toId===editNewEmailMatch.player.id)
                  ?<p className="text-xs text-amber-600 font-medium">{editNewEmailMatch.player.name} har allerede en konto — venneanmodning sendt, afventer accept (se listen ovenfor).</p>
                  :(
                    <div className="flex items-center justify-between gap-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                      <p className="text-xs text-amber-700">{editNewEmailMatch.player.name} har allerede en Huddleup-konto, men er ikke din ven endnu.</p>
                      <button type="button" onClick={requestFriendForEditNewEmail}
                        className="inline-flex items-center gap-1 text-xs bg-amber-600 text-white font-semibold rounded-lg px-2.5 py-1.5 hover:bg-amber-700 shrink-0">
                        <UserPlus size={12}/> Send venneanmodning
                      </button>
                    </div>
                  )
              )}
              {editInviteErr&&<p className="text-xs text-red-500 font-medium">{editInviteErr}</p>}
              {editSentInvite&&(
                <div className="border border-lime-200 bg-lime-50 rounded-xl p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs font-semibold text-lime-800 flex items-center gap-1.5"><CheckCircle2 size={13}/> Invitation sendt til {editSentInvite.name}</div>
                    <button onClick={()=>setEditSentInvite(null)} className="text-lime-600 hover:text-lime-800 shrink-0"><X size={14}/></button>
                  </div>
                  <div className="bg-white rounded-lg border border-lime-100 p-3 text-xs text-slate-600 space-y-1">
                    <div><span className="text-slate-400">Til:</span> {editSentInvite.email}</div>
                    <div className="text-slate-500">{editSentInvite.name} opretter sin profil via linket i mailen, og skal derefter blot trykke "Accepter" på venneanmodningen på sit Overblik — det tilføjer dem til denne forespørgsel med det samme.</div>
                  </div>
                </div>
              )}
            </div>
            {!datesChanged&&newlyAddedIds.length>0&&(
              <label className="flex items-start gap-2 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 cursor-pointer">
                <input type="checkbox" checked={resendToExisting} onChange={e=>setResendToExisting(e.target.checked)} className="accent-blue-700 mt-0.5"/>
                <span className="text-xs text-amber-800">
                  Send også opdateret forespørgsel til de {editPlayers.size-newlyAddedIds.length} spillere der allerede har svaret (de skal så acceptere igen).
                  Lad stå ude for kun at sende til de {newlyAddedIds.length} nye spillere — eksisterende spillere bliver ikke forstyrret.
                </span>
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={saveEditing} disabled={!editTitle.trim()||!editStart||!editEnd||editStart>editEnd||editPlayers.size===0}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-blue-700 text-white font-semibold text-sm rounded-xl py-2.5 disabled:opacity-40 hover:bg-blue-800 transition-colors">
              <CheckCircle2 size={16}/> {datesChanged?"Gem og send opdatering":"Gem ændringer"}
            </button>
            <button onClick={cancelEditing} className="text-sm text-slate-600 border border-slate-200 rounded-xl px-4 py-2.5 hover:bg-slate-50">Annuller</button>
          </div>
        </div>
      )}

      {expanded&&!editing&&(
        <div className="px-4 pb-4 space-y-4">
          {myMatches.length>0&&(
            <div className="bg-lime-50 border border-lime-200 rounded-xl p-3 space-y-1.5">
              <div className="text-xs font-semibold text-lime-800 uppercase tracking-wide flex items-center gap-1.5">
                <Calendar size={12}/> Fastlagte kampe ({myMatches.length})
              </div>
              <ul className="space-y-1">
                {myMatches.map((m,i)=>{
                  const k=matchKey(m,i);
                  const isExpanded=expandedMatches.has(k);
                  const canPlayers=isExpanded?playersForMatch(m):[];
                  return(
                    <li key={i} className="text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="text-lime-600 text-xs mr-1">U{getISOWeek(new Date(m.iso))}</span>
                          <span className="font-medium text-lime-900">{WD_FULL[(new Date(m.iso).getDay()+6)%7]} {fmtShort(new Date(m.iso))}</span>
                          <span className="text-lime-700"> · {rangeLabel(m.block,m.hours||1)}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs font-bold text-lime-700">{m.count}/{invitation.playerIds.length}</span>
                          <button onClick={()=>toggleMatchExpanded(k)} className="text-xs text-blue-700 hover:underline">{isExpanded?"Skjul":"Vis"}</button>
                        </div>
                      </div>
                      {isExpanded&&(
                        <div className="mt-1.5 pt-1.5 border-t border-lime-200 flex flex-wrap gap-1.5">
                          {canPlayers.length===0?<span className="text-xs text-slate-400">Ingen spillere.</span>:canPlayers.map(pl=>(
                            <span key={pl.id} className="inline-flex items-center gap-1 bg-white border border-lime-200 rounded-full pl-1 pr-2 py-0.5 text-xs text-slate-700">
                              <span className="w-4 h-4 rounded-full bg-blue-700 text-white grid place-items-center text-[8px] font-bold overflow-hidden">{avatarContent(pl)}</span>
                              {pl.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {invitation.description&&(
            <p className="text-sm text-slate-600 whitespace-pre-wrap bg-slate-50 rounded-xl px-3 py-2.5 border border-slate-100">{invitation.description}</p>
          )}
          {!isClosed&&pendingAccept&&(
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 space-y-2">
              <div className="text-sm font-semibold text-blue-800">Du er inviteret til denne forespørgsel</div>
              <p className="text-xs text-blue-700">Accepter for at deltage i planlægningen og markere din tilgængelighed, eller afslå hvis du ikke kan være med.</p>
              <div className="flex gap-2">
                <button onClick={()=>respondToInvitation("accepted")}
                  className="inline-flex items-center gap-1.5 bg-lime-600 text-white text-sm font-semibold rounded-lg px-3 py-2 hover:bg-lime-700"><CheckCircle2 size={14}/> Accepter</button>
                <button onClick={()=>respondToInvitation("declined")}
                  className="inline-flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 text-sm font-semibold rounded-lg px-3 py-2 hover:bg-red-50 hover:text-red-600 hover:border-red-200"><X size={14}/> Afslå</button>
              </div>
            </div>
          )}
          {!isClosed&&declined&&(
            <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">Du har afslået denne forespørgsel.</span>
              <button onClick={()=>respondToInvitation("accepted")} className="text-xs text-blue-600 hover:underline font-medium shrink-0">Fortryd og accepter</button>
            </div>
          )}
          {myResponse==="accepted"&&(
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {isClosed?null:iHaveSubmitted?(
                <button disabled
                  className="inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-xl py-2.5 bg-lime-50 text-lime-700 border border-lime-200 cursor-default">
                  <CheckCircle2 size={14}/> Tider indsendt {fmtSubmittedAt(mySubmittedAt)}
                </button>
              ):(
                <button onClick={()=>setShowFillCalendar(v=>!v)}
                  className={`inline-flex items-center justify-center gap-2 text-sm font-semibold rounded-xl py-2.5 transition-colors ${needsMyResponse?"bg-amber-500 text-white hover:bg-amber-600":"bg-blue-700 text-white hover:bg-blue-800"}`}>
                  <Send size={14}/> {showFillCalendar?"Skjul egen kalender":"Udfyld egen kalender"}
                </button>
              )}
              <button onClick={()=>setShowTeamView(v=>!v)}
                className="inline-flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-700 text-sm font-semibold rounded-xl py-2.5 hover:bg-slate-50 transition-colors">
                <Users size={14}/> {showTeamView?"Skjul holdkalender":"Se holdkalender"}
              </button>
            </div>
          )}
          {!isClosed&&showFillCalendar&&!iHaveSubmitted&&(
            <div className="border border-blue-200 rounded-2xl overflow-hidden">
              <SpillerKalender currentUser={currentUser} players={players} avail={avail} setAvail={setAvail}
                invitations={invitations} setInvitations={setInvitations} baseMonday={baseMonday} today={today}
                templates={templates} setTemplates={setTemplates}
                lockedPlayers={lockedPlayers} setLockedPlayers={setLockedPlayers} lockedInvitationId={invitation.id}/>
            </div>
          )}
          {submissionsBlock}
          {!isClosed&&helpingPlayerId&&helpingPlayer&&(
            <div className="border border-blue-200 rounded-2xl overflow-hidden">
              <div className="bg-blue-50 border-b border-blue-100 px-4 py-2.5 flex items-center justify-between gap-2">
                <div className="text-xs text-blue-800 flex items-center gap-1.5">
                  <LogIn size={12}/> Du hjælper <span className="font-semibold">{helpingPlayer.name}</span> med at udfylde
                </div>
                <button onClick={()=>setHelpingPlayerId(null)} className="text-xs text-blue-600 hover:underline font-medium shrink-0">Skjul</button>
              </div>
              {helpingResponse==="pending"?(
                <div className="p-5 space-y-3">
                  <div className="text-sm font-semibold text-slate-800">{helpingPlayer.name} er inviteret til denne forespørgsel</div>
                  <p className="text-xs text-slate-500">Før du kan hjælpe med at udfylde kalenderen, skal invitationen accepteres eller afslås på {helpingPlayer.name}s vegne.</p>
                  <div className="flex gap-2">
                    <button onClick={()=>updateInvitation(invitation.id,prev=>({...prev,responses:{...(prev.responses||{}),[helpingPlayerId]:"accepted"}}))}
                      className="inline-flex items-center gap-1.5 bg-lime-600 text-white text-sm font-semibold rounded-lg px-3 py-2 hover:bg-lime-700"><CheckCircle2 size={14}/> Accepter</button>
                    <button onClick={()=>updateInvitation(invitation.id,prev=>({...prev,responses:{...(prev.responses||{}),[helpingPlayerId]:"declined"}}))}
                      className="inline-flex items-center gap-1.5 bg-white border border-slate-200 text-slate-600 text-sm font-semibold rounded-lg px-3 py-2 hover:bg-red-50 hover:text-red-600 hover:border-red-200"><X size={14}/> Afslå</button>
                  </div>
                </div>
              ):helpingResponse==="declined"?(
                <div className="px-4 py-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">{helpingPlayer.name} har afslået denne forespørgsel.</span>
                  <button onClick={()=>updateInvitation(invitation.id,prev=>({...prev,responses:{...(prev.responses||{}),[helpingPlayerId]:"accepted"}}))} className="text-xs text-blue-600 hover:underline font-medium shrink-0">Fortryd og accepter</button>
                </div>
              ):(
                <SpillerKalender currentUser={helpingPlayer} players={players} avail={avail} setAvail={setAvail}
                  invitations={invitations} setInvitations={setInvitations} baseMonday={baseMonday} today={today}
                  templates={templates} setTemplates={setTemplates}
                  lockedPlayers={lockedPlayers} setLockedPlayers={setLockedPlayers} lockedInvitationId={invitation.id}/>
              )}
            </div>
          )}
          {showTeamView&&(
            <>
              {teamThresholdBlock}
              {calendarGridBlock}
              {availabilityBlock}
              {bestTimesBlock}
              {matchesBlock}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   OPRET FORESPØRGSEL (alle kan oprette deres egen)
═══════════════════════════════════════════════════════════ */
function OpretForespoergsel({players,setPlayers,setAvail,currentUser,invitations,setInvitations,today,setTab,drafts,setDrafts,openDraftId,setOpenDraftId,friends,setFriends,myPendingInvites,onCancelPendingInvite,friendRequests,onSendFriendRequest,onCancelFriendRequest}){
  const [invTitle,setInvTitle]=useState("");
  const [invDescription,setInvDescription]=useState("");
  const [invStart,setInvStart]=useState(()=>{const d=new Date(today);d.setDate(d.getDate()+1);return isoDate(d);});
  const [invEnd,setInvEnd]=useState(()=>{const d=new Date(today);d.setDate(d.getDate()+28);return isoDate(d);});
  const [invSubmitDeadline,setInvSubmitDeadline]=useState(()=>{const d=new Date(today);d.setDate(d.getDate()+3);return isoDate(d);});
  const [invDeadline,setInvDeadline]=useState(()=>{const d=new Date(today);d.setDate(d.getDate()+7);return isoDate(d);});
  // Man bygger selv sin spillerliste for denne forespørgsel — man er selv med fra start.
  const [invPlayers,setInvPlayers]=useState(()=>new Set([currentUser.id]));
  const [invMinPlayers,setInvMinPlayers]=useState(4);
  const [invConsecHours,setInvConsecHours]=useState(1);
  const [invSent,setInvSent]=useState(false);
  const [avatarImage,setAvatarImage]=useState(null);
  const [avatarEmoji,setAvatarEmoji]=useState(null);
  const [showEmojiPicker,setShowEmojiPicker]=useState(false);
  const avatarFileRef=useRef(null);
  const EMOJI_CHOICES=["😀","😎","🦁","⚡","🔥","🐺","🚀","🏆","🎯","🐧","🥅","🦊"];

  const [playerSearch,setPlayerSearch]=useState("");
  const [newInvName,setNewInvName]=useState("");
  const [newInvEmail,setNewInvEmail]=useState("");
  // Personer uden konto endnu, tilføjet til DENNE kladde — { name, email }. Der sendes IKKE nogen
  // mail og oprettes IKKE noget i Firestore her, kun rent lokalt i kladden, indtil man rent faktisk
  // trykker "Afsend forespørgsel" (se sendInvitation). Ellers risikerer man at personen opretter sin
  // profil og lander på en tom side, fordi selve huddlen slet ikke er sendt endnu.
  const [invNewPeople,setInvNewPeople]=useState([]);
  const [currentDraftId,setCurrentDraftId]=useState(null);
  const [draftSaved,setDraftSaved]=useState(false);
  const [showDiscardConfirm,setShowDiscardConfirm]=useState(false);
  const [sendBusy,setSendBusy]=useState(false);
  const [sendErr,setSendErr]=useState("");
  // Genereres allerede nu, så nye spillere man inviterer på mail MENS man opretter forespørgslen
  // (før man har trykket "Send") kan kobles til den huddle, de rent faktisk hører til, i stedet for
  // at ende som en "løs" invitation der ikke kan spores tilbage til nogen forespørgsel.
  const [invId,setInvId]=useState(()=>newDocId("invitations"));

  // Indlæs en kladde når man kommer fra "Fortsæt kladde" på Overblik
  useEffect(()=>{
    if(!openDraftId)return;
    const d=(drafts||[]).find(x=>x.id===openDraftId);
    if(d){
      setInvTitle(d.title||"");
      setInvDescription(d.description||"");
      if(d.startIso)setInvStart(d.startIso);
      if(d.endIso)setInvEnd(d.endIso);
      if(d.submitDeadline)setInvSubmitDeadline(d.submitDeadline);
      if(d.deadline)setInvDeadline(d.deadline);
      setInvPlayers(new Set(d.playerIds&&d.playerIds.length?d.playerIds:[currentUser.id]));
      setInvMinPlayers(d.minPlayers||4);
      setInvConsecHours(d.consecHours||1);
      setAvatarImage(d.avatarImage||null);
      setAvatarEmoji(d.avatarEmoji||null);
      setCurrentDraftId(d.id);
      setInvId(d.invitationId||newDocId("invitations"));
      setInvNewPeople(d.newPeople||[]);
    }
    setOpenDraftId(null);
  },[openDraftId]);

  const emailValid=(e)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  const myFriendIds=useMemo(()=>new Set((friends&&friends[currentUser?.id])||[]),[friends,currentUser]);
  const searchResults=useMemo(()=>{
    const q=playerSearch.trim().toLowerCase();
    if(!q)return[];
    return players.filter(p=>!invPlayers.has(p.id)&&myFriendIds.has(p.id)&&p.name.toLowerCase().includes(q)).slice(0,8);
  },[players,playerSearch,invPlayers,myFriendIds]);

  const addExistingPlayer=(id)=>{setInvPlayers(prev=>new Set(prev).add(id));setPlayerSearch("");};
  const removeInvited=(id)=>setInvPlayers(prev=>{const n=new Set(prev);n.delete(id);return n;});

  // Findes e-mailen allerede — som en oprettet bruger, som en afventende invitation fra en TIDLIGERE
  // huddle, eller som en person man allerede har tilføjet til DENNE kladde — advares der i stedet
  // for at tilføje/sende igen. "existing" giver også selve spiller-objektet med, så man har en reel
  // vej videre (send en venneanmodning knyttet til denne huddle) i stedet for en blind afvisning —
  // se requestFriendForNewInvEmail nedenfor og kommentaren ved sendFriendRequest i App().
  const newInvEmailMatch=useMemo(()=>{
    const q=newInvEmail.trim().toLowerCase();
    if(!q)return null;
    if(invNewPeople.some(p=>(p.email||"").trim().toLowerCase()===q))return{type:"queued"};
    if((myPendingInvites||[]).some(iv=>(iv.email||"").trim().toLowerCase()===q))return{type:"pending"};
    const existingPlayer=players.find(p=>(p.email||"").trim().toLowerCase()===q);
    if(existingPlayer)return{type:"existing",player:existingPlayer};
    return null;
  },[newInvEmail,invNewPeople,myPendingInvites,players]);

  // Udgående venneanmodninger sendt herfra og knyttet til netop denne (endnu ikke afsendte)
  // huddle — vises sammen med de lokalt tilføjede personer, så man kan se ALT man allerede har sat
  // i gang, uanset om modtageren havde en konto i forvejen eller ej. "accepted" betyder personen
  // allerede har trykket Accepter — de tages med automatisk ved selve afsendelsen (se sendInvitation).
  const pendingFriendReqsForThisDraft=useMemo(()=>(friendRequests||[])
    .filter(r=>r.fromId===currentUser.id&&r.invitationId===invId)
    .map(r=>({...r,player:players.find(p=>p.id===r.toId)}))
  ,[friendRequests,currentUser,invId,players]);
  const requestFriendForNewInvEmail=()=>{
    if(newInvEmailMatch?.type!=="existing"||!newInvEmailMatch.player)return;
    onSendFriendRequest&&onSendFriendRequest(newInvEmailMatch.player.id,invId);
    setNewInvName("");setNewInvEmail("");
  };

  // Tilføjer personen lokalt til kladden — IKKE til Firestore, og der sendes IKKE nogen mail her.
  // Se kommentaren ved invNewPeople-state'n: det sker først når man rent faktisk afsender huddlen.
  const addNewPersonToDraft=()=>{
    const name=newInvName.trim(),email=newInvEmail.trim();
    if(!name||!emailValid(email)||newInvEmailMatch)return;
    setInvNewPeople(prev=>[...prev,{name,email}]);
    setNewInvName("");setNewInvEmail("");
  };
  const removeNewPersonFromDraft=(email)=>{
    const key=(email||"").trim().toLowerCase();
    setInvNewPeople(prev=>prev.filter(p=>(p.email||"").trim().toLowerCase()!==key));
  };

  const pickPhoto=async(file)=>{
    if(!file)return;
    setAvatarImage(await resizeImageToDataURL(file));
    setAvatarEmoji(null);setShowEmojiPicker(false);
  };
  const pickEmoji=(em)=>{setAvatarEmoji(em);setAvatarImage(null);setShowEmojiPicker(false);};

  const sendInvitation=async()=>{
    if(!invTitle.trim()||!invStart||!invEnd||invStart>invEnd||invPlayers.size===0||sendBusy)return;
    setSendErr("");setSendBusy(true);
    try{
      // Saml venner op der allerede har trykket Accepter på en venneanmodning knyttet til denne
      // huddle, MENS den stadig var en kladde (se acceptFriendRequest i App()) — hentet friskt fra
      // Firestore (ikke kun lokal state), så vi er sikre på at få dem alle med uanset om de
      // accepterede mens denne fane var lukket eller ude af sync.
      const acceptedQ=fsQuery(collection(db,"friendRequests"),where("invitationId","==",invId),where("accepted","==",true));
      const acceptedSnap=await getDocs(acceptedQ);
      const acceptedIds=acceptedSnap.docs.map(d=>d.data().toId).filter(Boolean);

      const finalPlayerIds=[...new Set([...invPlayers,...acceptedIds])];
      const responses={};
      finalPlayerIds.forEach(id=>{responses[id]=(id===currentUser.id||acceptedIds.includes(id))?"accepted":"pending";});

      // Dokumentet oprettes her for allerførste gang, med den fulde og korrekte spillerliste med det
      // samme — der er derfor aldrig noget bagefter, der kan overskrive en spiller der allerede er
      // koblet på.
      await setDoc(doc(db,"invitations",invId),{id:invId,title:invTitle.trim(),description:invDescription.trim(),startIso:invStart,endIso:invEnd,playerIds:finalPlayerIds,responses,submitDeadline:invSubmitDeadline,deadline:invDeadline,submittedIds:[],createdById:currentUser.id,createdByName:currentUser.name,avatarImage,avatarEmoji,minPlayers:invMinPlayers,consecHours:invConsecHours,status:"active"});

      // De brugte anmodninger har opfyldt deres formål nu — ryd op.
      await Promise.all(acceptedSnap.docs.map(d=>deleteDoc(doc(db,"friendRequests",d.id)).catch(()=>{})));

      // NU — og først nu — oprettes de ventende invitationer og sendes de rigtige mails til dem
      // uden konto endnu, alle på samme tid, med invitationen allerede oprettet og klar til dem.
      await Promise.all(invNewPeople.map(async p=>{
        try{
          const inviteId=newDocId("invites");
          await setDoc(doc(db,"invites",inviteId),{email:p.email,name:p.name,invitedByUid:currentUser.id,invitedByName:currentUser.name,invitationId:invId,createdAt:new Date().toISOString(),status:"pending"});
          await sendInviteEmail({toEmail:p.email,toName:p.name,fromName:currentUser.name,invitationTitle:invTitle.trim(),signupUrl:buildSignupUrl(p.email,p.name,invId)});
        }catch(e){
          console.error(`Kunne ikke sende invitation til ${p.email}:`,e);
        }
      }));

      if(currentDraftId)setDrafts(prev=>prev.filter(d=>d.id!==currentDraftId));
      setInvSent(true);
      setTimeout(()=>{setInvSent(false);setTab("overblik");},900);
    }catch(e){
      setSendErr(e.message||"Kunne ikke afsende forespørgslen. Prøv igen.");
    }finally{
      setSendBusy(false);
    }
  };

  const buildDraftPayload=()=>({
    id:currentDraftId||newDocId("drafts"),
    title:invTitle.trim(),description:invDescription.trim(),
    startIso:invStart,endIso:invEnd,submitDeadline:invSubmitDeadline,deadline:invDeadline,
    playerIds:[...invPlayers],minPlayers:invMinPlayers,consecHours:invConsecHours,
    avatarImage,avatarEmoji,createdById:currentUser.id,createdByName:currentUser.name,
    invitationId:invId,newPeople:invNewPeople,
  });

  const saveDraft=()=>{
    const payload=buildDraftPayload();
    setDrafts(prev=>currentDraftId?prev.map(d=>d.id===currentDraftId?payload:d):[...prev,payload]);
    setCurrentDraftId(payload.id);
    setDraftSaved(true);
    setTimeout(()=>{setDraftSaved(false);setTab("overblik");},900);
  };

  const discardDraft=(confirmed)=>{
    if(!confirmed){setShowDiscardConfirm(false);return;}
    if(currentDraftId)setDrafts(prev=>prev.filter(d=>d.id!==currentDraftId));
    setShowDiscardConfirm(false);
    setTab("overblik");
  };

  return(
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Opret Ny Huddle</h2>
          <p className="text-xs text-slate-500 mt-0.5">Her kan du sende en Huddle-forespørgsel til dit hold — vælg hvilke spillere der skal forespørges om deres tilgængelighed i en given periode.</p>
        </div>
        <button type="button" onClick={()=>setTab("overblik")} className="text-slate-400 hover:text-slate-600 shrink-0"><X size={20}/></button>
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-4">
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Billede til rubrik</label>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-blue-50 grid place-items-center shrink-0 overflow-hidden text-xl border border-slate-200">
              {avatarImage
                ?<img src={avatarImage} alt="" className="w-full h-full object-cover"/>
                :avatarEmoji
                  ?<span>{avatarEmoji}</span>
                  :<Bell size={18} className="text-blue-600"/>}
            </div>
            <button type="button" onClick={()=>avatarFileRef.current&&avatarFileRef.current.click()}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-100 font-medium text-slate-600">Upload foto</button>
            <button type="button" onClick={()=>setShowEmojiPicker(v=>!v)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-100 font-medium text-slate-600">Vælg emoji</button>
            {(avatarImage||avatarEmoji)&&(
              <button type="button" onClick={()=>{setAvatarImage(null);setAvatarEmoji(null);}} className="text-xs text-slate-400 hover:text-red-500">Nulstil</button>
            )}
            <input ref={avatarFileRef} type="file" accept="image/*" className="hidden" onChange={e=>{pickPhoto(e.target.files?.[0]);e.target.value="";}}/>
          </div>
          {showEmojiPicker&&(
            <div className="flex flex-wrap gap-1 mt-2 bg-slate-50 border border-slate-200 rounded-lg p-2">
              {EMOJI_CHOICES.map(em=>(
                <button type="button" key={em} onClick={()=>pickEmoji(em)} className="w-8 h-8 rounded-lg hover:bg-white text-lg grid place-items-center">{em}</button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Titel</label>
          <input type="text" value={invTitle} onChange={e=>setInvTitle(e.target.value)} placeholder="fx Efterårssæson 2026"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Beskrivelse</label>
          <textarea value={invDescription} onChange={e=>setInvDescription(e.target.value)} rows={3} placeholder="Skriv en tekst til de forespurgte spillere…"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Periode der forespørges på</label>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={invStart} min={isoDate(today)} onChange={e=>setInvStart(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            <span className="text-slate-400 text-sm">til</span>
            <input type="date" value={invEnd} min={invStart} onChange={e=>setInvEnd(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          {invStart&&invEnd&&invStart<=invEnd&&(
            <div className="text-xs text-slate-400 mt-1">Uge {getISOWeek(new Date(invStart))} – {getISOWeek(new Date(invEnd))}</div>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Frist for indrapportering</label>
          <input type="date" value={invSubmitDeadline} min={isoDate(today)} max={invEnd} onChange={e=>setInvSubmitDeadline(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          <p className="text-xs text-slate-400 mt-1">Spillerne kan ikke indsende efter denne dato.</p>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Sidste kamp forventes planlagt</label>
          <input type="date" value={invDeadline} min={invSubmitDeadline||isoDate(today)} onChange={e=>setInvDeadline(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          <p className="text-xs text-slate-400 mt-1">Spillerne bedes holde tiderne fri frem til denne dato.</p>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Spillere i forespørgslen ({invPlayers.size})</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {[...invPlayers].map(id=>{
              const pl=players.find(p=>p.id===id);
              if(!pl)return null;
              return(
                <span key={id} className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-800 rounded-full pl-1 pr-2 py-0.5 text-xs">
                  <span className="w-5 h-5 rounded-full bg-blue-700 text-white grid place-items-center text-[9px] font-bold shrink-0 overflow-hidden">
                    {pl.avatarImage?<img src={pl.avatarImage} alt="" className="w-full h-full object-cover"/>:pl.avatarEmoji?<span className="text-[10px]">{pl.avatarEmoji}</span>:initials(pl.name)}
                  </span>
                  {pl.name}{id===currentUser.id&&<span className="text-blue-400">(dig)</span>}
                  <button type="button" onClick={()=>removeInvited(id)} className="text-blue-400 hover:text-red-500 ml-0.5"><X size={11}/></button>
                </span>
              );
            })}
            {invPlayers.size===0&&<span className="text-xs text-slate-400">Ingen spillere valgt endnu.</span>}
          </div>

          <p className="text-xs text-slate-400 mb-2">Søg blandt dine venner, eller inviter en ny nedenfor. De inviterede skal selv acceptere eller afslå på deres Overblik, før de indgår i planen. Tilføj flere venner via Venner-menuen for at kunne finde dem her.</p>

          <div className="relative">
            <input type="text" value={playerSearch} onChange={e=>setPlayerSearch(e.target.value)} placeholder="Søg blandt dine venner…"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            {searchResults.length>0&&(
              <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {searchResults.map(pl=>(
                  <button type="button" key={pl.id} onClick={()=>addExistingPlayer(pl.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-50 text-sm">
                    <span className="w-5 h-5 rounded-full bg-blue-700 text-white grid place-items-center text-[9px] font-bold shrink-0 overflow-hidden">
                      {pl.avatarImage?<img src={pl.avatarImage} alt="" className="w-full h-full object-cover"/>:pl.avatarEmoji?<span className="text-[10px]">{pl.avatarEmoji}</span>:initials(pl.name)}
                    </span>
                    {pl.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-slate-100 mt-3 pt-3 space-y-2">
            <div className="text-xs font-medium text-slate-600">Tilføj en ny spiller (findes ikke endnu)</div>
            {(invNewPeople.length>0||pendingFriendReqsForThisDraft.length>0)&&(
              <div className="space-y-1.5">
                <p className="text-[11px] text-slate-400">Allerede tilføjet til denne forespørgsel:</p>
                <div className="space-y-1">
                  {invNewPeople.map(p=>(
                    <div key={`new-${p.email}`} className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 grid place-items-center shrink-0"><Mail size={10}/></span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs text-slate-700 truncate">{p.name}</span>
                        <span className="block text-[10px] text-slate-400 truncate">{p.email} — får en mail, når du afsender forespørgslen</span>
                      </span>
                      <button type="button" onClick={()=>removeNewPersonFromDraft(p.email)} title="Fjern" className="text-slate-400 hover:text-red-500 shrink-0"><X size={13}/></button>
                    </div>
                  ))}
                  {pendingFriendReqsForThisDraft.map(req=>(
                    <div key={`freq-${req.id}`} className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 grid place-items-center shrink-0"><UserPlus size={10}/></span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs text-slate-700 truncate">{req.player?.name||"Ukendt spiller"}</span>
                        <span className="block text-[10px] text-slate-400 truncate">
                          {req.accepted?"Har accepteret — tilføjes automatisk, når du afsender forespørgslen":"Har allerede en konto — afventer accept af venneanmodning"}
                        </span>
                      </span>
                      {!req.accepted&&<button type="button" onClick={()=>onCancelFriendRequest&&onCancelFriendRequest(req.id)} title="Fortryd anmodning" className="text-slate-400 hover:text-red-500 shrink-0"><X size={13}/></button>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              <input type="text" placeholder="Navn" value={newInvName} onChange={e=>setNewInvName(e.target.value)}
                className="flex-1 min-w-28 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              <input type="email" placeholder="E-mail" value={newInvEmail} onChange={e=>setNewInvEmail(e.target.value)}
                className="flex-1 min-w-36 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
              <button type="button" onClick={addNewPersonToDraft} disabled={!newInvName.trim()||!emailValid(newInvEmail)||!!newInvEmailMatch}
                className="inline-flex items-center gap-1.5 bg-blue-700 text-white text-sm font-medium rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-blue-800">
                <UserPlus size={14}/> Tilføj
              </button>
            </div>
            <p className="text-[11px] text-slate-400">Mailen sendes først, når du trykker "Afsend forespørgsel" nedenfor — så risikerer man ikke at spilleren opretter sig, før huddlen rent faktisk findes.</p>
            {newInvEmailMatch?.type==="queued"&&<p className="text-xs text-amber-600 font-medium">Allerede tilføjet til denne forespørgsel.</p>}
            {newInvEmailMatch?.type==="pending"&&<p className="text-xs text-amber-600 font-medium">Denne e-mail er allerede inviteret (til en anden forespørgsel) og afventer stadig svar.</p>}
            {newInvEmailMatch?.type==="existing"&&(
              pendingFriendReqsForThisDraft.some(r=>r.toId===newInvEmailMatch.player.id)
                ?<p className="text-xs text-amber-600 font-medium">{newInvEmailMatch.player.name} har allerede en konto — venneanmodning sendt (se listen ovenfor).</p>
                :(
                  <div className="flex items-center justify-between gap-2 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                    <p className="text-xs text-amber-700">{newInvEmailMatch.player.name} har allerede en Huddleup-konto, men er ikke din ven endnu.</p>
                    <button type="button" onClick={requestFriendForNewInvEmail}
                      className="inline-flex items-center gap-1 text-xs bg-amber-600 text-white font-semibold rounded-lg px-2.5 py-1.5 hover:bg-amber-700 shrink-0">
                      <UserPlus size={12}/> Send venneanmodning
                    </button>
                  </div>
                )
            )}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Krav for "Samlet tilgængelighed" og "Bedste tider"</label>
          <p className="text-xs text-slate-400 mb-2">Bestemmer hvornår et tidspunkt regnes for spilbart. Kan justeres igen senere fra selve forespørgslen.</p>
          {/* Pile-vælgere for begge krav, stillet i et grid så de to rækker linjer op under hinanden */}
          <div className="grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-2 w-fit">
            <span className="text-sm text-slate-600 whitespace-nowrap">Min. spillere</span>
            <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
              <button type="button" onClick={()=>setInvMinPlayers(v=>Math.max(1,v-1))} disabled={invMinPlayers<=1}
                className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Færre spillere"><ChevronLeft size={15}/></button>
              <span className="px-3 py-1.5 text-sm font-semibold bg-blue-700 text-white min-w-[2.25rem] text-center">{invMinPlayers}</span>
              <button type="button" onClick={()=>setInvMinPlayers(v=>Math.min(99,v+1))} disabled={invMinPlayers>=99}
                className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Flere spillere"><ChevronRight size={15}/></button>
            </div>
            <span className="text-sm text-slate-600 whitespace-nowrap">Sammenh. timer</span>
            <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
              <button type="button" onClick={()=>setInvConsecHours(v=>Math.max(1,v-1))} disabled={invConsecHours<=1}
                className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Færre timer"><ChevronLeft size={15}/></button>
              <span className="px-3 py-1.5 text-sm font-semibold bg-blue-700 text-white min-w-[2.25rem] text-center">{invConsecHours}</span>
              <button type="button" onClick={()=>setInvConsecHours(v=>Math.min(4,v+1))} disabled={invConsecHours>=4}
                className="px-2 py-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-30" title="Flere timer"><ChevronRight size={15}/></button>
            </div>
          </div>
        </div>
        {showDiscardConfirm?(
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
            <div className="text-sm text-amber-800 font-medium">Vil du slette kladden?</div>
            <div className="flex gap-2">
              <button onClick={()=>discardDraft(true)} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg py-2">Ja, slet</button>
              <button onClick={()=>discardDraft(false)} className="flex-1 bg-white border border-amber-300 text-amber-800 text-sm font-semibold rounded-lg py-2">Nej</button>
            </div>
          </div>
        ):(
          <div className="flex flex-col sm:flex-row gap-2">
            <button onClick={()=>setShowDiscardConfirm(true)}
              className="sm:order-1 inline-flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-600 font-semibold text-sm rounded-xl py-2.5 px-4 hover:bg-slate-50 transition-colors">
              Fortryd
            </button>
            <button onClick={saveDraft} disabled={!invTitle.trim()}
              className="sm:order-2 inline-flex items-center justify-center gap-2 bg-white border border-blue-200 text-blue-700 font-semibold text-sm rounded-xl py-2.5 px-4 disabled:opacity-40 hover:bg-blue-50 transition-colors">
              {draftSaved?<><CheckCircle2 size={16}/> Kladde gemt!</>:<>Gem kladde</>}
            </button>
            <button onClick={sendInvitation} disabled={sendBusy||!invTitle.trim()||!invStart||!invEnd||invStart>invEnd||invPlayers.size===0}
              className="sm:order-3 flex-1 inline-flex items-center justify-center gap-2 bg-blue-700 text-white font-semibold text-sm rounded-xl py-2.5 disabled:opacity-40 hover:bg-blue-800 transition-colors">
              {invSent?<><CheckCircle2 size={16}/> Forespørgsel sendt!</>:sendBusy?<>Sender…</>:<><Send size={16}/> Afsend forespørgsel</>}
            </button>
          </div>
        )}
        {sendErr&&<p className="text-xs text-red-500 font-medium text-right">{sendErr}</p>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SPILLERENS KALENDER
═══════════════════════════════════════════════════════════ */
function SpillerKalender({currentUser,players,avail,setAvail,invitations,setInvitations,baseMonday,today,templates,setTemplates,lockedPlayers,setLockedPlayers,lockedInvitationId}){
  const [weekOffset,setWeekOffset]=useState(0);
  const paintRef=useRef(null);
  const templatePaintRef=useRef(null);
  // Mobilbrowsere sender ofte en "ghost" mousedown/click lige efter en touch-hændelse.
  // Uden denne guard bliver en celle først markeret af touchstart og så straks slået fra
  // igen af den efterfølgende syntetiske mousedown — hvilket set fra brugeren ligner at
  // markeringen "forsvinder" i det øjeblik man slipper fingeren. lastTouchRef holder styr
  // på, hvornår vi sidst så en rigtig touch-hændelse, så vi kan ignorere ghost-museklik.
  const lastTouchRef=useRef(0);
  const isGhostMouseEvent=()=>Date.now()-lastTouchRef.current<800;
  const [selInvId,setSelInvId]=useState(null);
  // Denne komponent viser/redigerer altid currentUser's egen kalender — enten fordi det bogstaveligt
  // ER den indloggede spiller (standalone "Kalender"-fane / "Udfyld egen kalender"), eller fordi
  // currentUser er byttet ud med den hjulpne spiller (se "hjælp en anden spiller"-flowet).
  const viewId=currentUser.id;
  // Template gemmes per spiller i App-state så det overlever fane-skift
  const template=(templates&&viewId&&templates[viewId])||new Set();
  const setTemplate=(fn)=>{
    if(!viewId)return;
    setTemplates(viewId,cur=>{const c=cur||new Set();return typeof fn==="function"?fn(c):fn;});
  };
  const [showTemplate,setShowTemplate]=useState(true);
  const [applyMsg,setApplyMsg]=useState(null);
  const [submitComment,setSubmitComment]=useState("");
  // "idle" | "saving" | "error" — styrer Indsend-knappen, se submitCalendar herunder.
  const [submitState,setSubmitState]=useState("idle");

  const player=players.find(p=>p.id===viewId)||players[0]||null;
  const editingSelf=!!player&&player.id===currentUser.id;

  // Alle forespørgsler denne spiller er inviteret til
  // Man skal have accepteret invitationen (på Overblik) før man kan markere sin tilgængelighed for den
  const myInvitations=useMemo(()=>(invitations||[]).filter(inv=>player&&inv.playerIds.includes(player.id)&&responseFor(inv,player.id)==="accepted"),[invitations,player]);
  // Aktive forespørgsler (perioden er ikke slut endnu) — dem man kan besvare/redigere
  const activeInvitations=useMemo(()=>myInvitations.filter(inv=>isoDate(today)<=inv.endIso),[myInvitations,today]);
  // Arkiverede besvarelser — perioden er slut, og spilleren nåede at indsende. Kan kopieres til kladde igen.
  const archivedInvitations=useMemo(()=>player?myInvitations.filter(inv=>isoDate(today)>inv.endIso&&(inv.submittedIds||[]).includes(player.id)):[],[myInvitations,today,player]);

  const updateInvitation=(id,fn)=>setInvitations(prev=>prev.map(inv=>inv.id===id?fn(inv):inv));

  // Sørg for at der altid er en valgt (aktiv) forespørgsel — prioriter dem der endnu ikke er besvaret
  useEffect(()=>{
    if(lockedInvitationId){setSelInvId(lockedInvitationId);return;}
    if(activeInvitations.length===0){if(selInvId!==null)setSelInvId(null);return;}
    if(!activeInvitations.some(i=>i.id===selInvId)){
      const firstPending=activeInvitations.find(i=>!(i.submittedIds||[]).includes(player?.id));
      setSelInvId((firstPending||activeInvitations[0]).id);
    }
  },[activeInvitations,player?.id,lockedInvitationId]);

  const invitation=lockedInvitationId
    ?(invitations||[]).find(i=>i.id===lockedInvitationId)||null
    :activeInvitations.find(i=>i.id===selInvId)||null;

  // Indlæs allerede indsendt kommentar (hvis nogen) når man skifter forespørgsel
  useEffect(()=>{
    setSubmitComment((invitation&&player&&invitation.comments?.[player.id])||"");
  },[invitation?.id,player?.id]);

  // Kopiér en arkiveret besvarelses ugentlige mønster til kladden for den valgte aktive forespørgsel
  const copyArchivedToDraft=(archInv)=>{
    if(!invitation||!editingSelf||isSubmitted)return;
    // Mønsteret hentes fra den ARKIVEREDE forespørgsels EGNE markeringer — ikke fra en delt
    // kalender — se availKey().
    const src=avail[availKey(archInv.id,player.id)]||new Set();
    const pattern=new Set();
    src.forEach(key=>{
      const sep=key.lastIndexOf("|");
      const iso=key.slice(0,sep),block=key.slice(sep+1);
      if(iso>=archInv.startIso&&iso<=archInv.endIso){
        const wd=(new Date(iso).getDay()+6)%7;
        pattern.add(`${wd}|${block}`);
      }
    });
    if(pattern.size===0){setApplyMsg("Ingen markeringer fundet i den arkiverede besvarelse.");return;}
    setAvail(availKey(invitation.id,player.id),cur0=>{
      const cur=new Set(cur0||[]);
      const kept=new Set([...cur].filter(k=>{const sep=k.lastIndexOf("|");const iso=k.slice(0,sep);return iso<invitation.startIso||iso>invitation.endIso;}));
      let d=new Date(invitation.startIso);
      while(isoDate(d)<=invitation.endIso){
        const iso=isoDate(d);
        const wd=(d.getDay()+6)%7;
        pattern.forEach(pk=>{
          const sep=pk.indexOf("|");
          const pwd=pk.slice(0,sep),block=pk.slice(sep+1);
          if(Number(pwd)===wd)kept.add(slotKey(iso,block));
        });
        d.setDate(d.getDate()+1);
      }
      return kept;
    });
    setApplyMsg(`Kopieret fra "${archInv.title||"tidligere besvarelse"}" til kladde.`);
  };

  // Er der en valgt anmodning for denne spiller? BEMÆRK: afhænger bevidst IKKE af editingSelf —
  // "Alle kan se/redigere enhver spillers kalender" (se viewId ovenfor), og periode-begrænsningen
  // her, samt indsendt/låst-beskyttelsen nedenfor (isSubmitted/canEdit), SKAL gælde uanset hvem der
  // sidder og redigerer. Da invActive tidligere krævede editingSelf, blev en allerede indsendt og
  // låst kalender IKKE beskyttet, når man redigerede en anden spillers kalender via spiller-
  // vælgeren (i modsætning til via "hjælp en anden spiller", hvor editingSelf altid er sand) — med
  // det resultat at "Ryd alt"-knappen (beregnet til en aktiv, IKKE-låst kalender uden invitation)
  // stod aktiv og kunne slette en allerede indsendt kalender fuldstændig, uden varsel.
  const hasInvitation=!!invitation;
  const invActive=hasInvitation; // begrænser navigation + redigering

  // Ugeoffsets for den anmodede periode
  const invMinWeek=useMemo(()=>invActive?Math.max(0,Math.round((mondayOf(new Date(invitation.startIso))-baseMonday)/(7*864e5))):0,[invActive,invitation,baseMonday]);
  const invMaxWeek=useMemo(()=>invActive?Math.min(HORIZON_WEEKS-1,Math.round((mondayOf(new Date(invitation.endIso))-baseMonday)/(7*864e5))):HORIZON_WEEKS-1,[invActive,invitation,baseMonday]);

  // Hop til periodens start når anmodning vælges/aktiveres
  useEffect(()=>{
    if(invActive){setWeekOffset(invMinWeek);}
  },[player?.id,invActive,invMinWeek,baseMonday,invitation?.id]);

  // Begrænset navigation når anmodning er aktiv
  const setWeekOffsetClamped=(fn)=>{
    setWeekOffset(prev=>{
      const next=typeof fn==="function"?fn(prev):fn;
      return Math.max(invActive?invMinWeek:0,Math.min(invActive?invMaxWeek:HORIZON_WEEKS-1,next));
    });
  };

  useEffect(()=>{
    const up=()=>{paintRef.current=null;templatePaintRef.current=null;};
    window.addEventListener("mouseup",up);window.addEventListener("touchend",up);
    return()=>{window.removeEventListener("mouseup",up);window.removeEventListener("touchend",up);};
  },[]);

  const weekDates=useMemo(()=>{
    const s=new Date(baseMonday);s.setDate(s.getDate()+weekOffset*7);
    return Array.from({length:7},(_,i)=>{const d=new Date(s);d.setDate(d.getDate()+i);return d;});
  },[baseMonday,weekOffset]);

  if(!player)return(
    <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-500 text-sm">
      Ingen spillere. Gå til Spillere og tilføj spillere.
    </div>
  );

  // Markeringerne hører til NETOP den valgte forespørgsel (eller "_none" uden nogen valgt) — se
  // availKey(). Skift af forespørgsel (selInvId/lockedInvitationId) skifter derfor reelt til en
  // helt anden, uafhængig kalender.
  const marked=avail[availKey(invitation?.id,player.id)]||new Set();
  // isSubmitted/submitDeadlinePassed er bevidst IKKE gated bag editingSelf — se kommentaren ved
  // invActive ovenfor. En allerede indsendt/låst kalender skal vises korrekt (låst) uanset hvem
  // der kigger på den.
  const isSubmitted=!!(lockedPlayers?.has(player.id)||(invitation?.submittedIds?.includes(player.id)));
  const submitDeadlinePassed=!!(invitation?.submitDeadline&&isoDate(today)>invitation.submitDeadline);
  // canEdit KRÆVER derimod editingSelf — det er bevidst den eneste vej til reelt at ændre en
  // anden spillers kalender: enten er det bogstaveligt ens egen, eller også sker det via "hjælp en
  // anden spiller" (som bytter currentUser til den hjulpne spiller og derved gør editingSelf sand).
  // Spiller-vælgeren i den almindelige Kalender-fane må gerne bruges til at SE enhver spillers
  // kalender, men skal aldrig kunne redigere den — det var netop den vej, der tidligere manglede
  // beskyttelse mod at ændre/slette en allerede indsendt kalender.
  const canEdit=(editingSelf&&!isSubmitted&&!submitDeadlinePassed);

  const setMarked=(fn)=>{
    if(!canEdit)return;
    setAvail(availKey(invitation?.id,player.id),cur=>fn(cur||new Set()));
  };

  const isPast=(d)=>isoDate(d)<isoDate(today);
  const isMarked=(d,b)=>marked.has(slotKey(isoDate(d),b));
  const isInvited=(d)=>hasInvitation&&isoDate(d)>=invitation.startIso&&isoDate(d)<=invitation.endIso;
  // Kan cellen redigeres? Når anmodning er aktiv låses celler udenfor perioden
  const cellEditable=(d)=>{
    if(isPast(d)||!canEdit)return false;
    if(invActive&&!isInvited(d))return false;
    return true;
  };

  // VIGTIGT (indført efter gentagne tilfælde af "jeg har indsendt, men mine tider mangler"): "Indsend"
  // må ALDRIG bare stole på, at de løbende skrivninger fra de enkelte celleklik undervejs rent faktisk
  // nåede frem til serveren — det er netop den antagelse, der har vist sig forkert flere gange. I
  // stedet skriver vi her, eksplicit og ÉN GANG TIL, den fulde aktuelle markering til serveren og
  // VENTER på et bekræftet svar (setAvail/updateInvitation returnerer nu et Promise<boolean> — se
  // useFirestoreDocState.js), før spilleren overhovedet kan blive markeret som færdig. Går skrivningen
  // galt (fx tabt forbindelse), får spilleren besked med det samme og "Indsend" gennemføres ikke —
  // fremfor at appen tavst lader spilleren tro, den er færdig, mens data reelt aldrig blev gemt.
  const submitCalendar=async()=>{
    if(isSubmitted||!editingSelf||submitState==="saving")return;
    setSubmitState("saving");
    if(invActive){
      const availOk=await setAvail(availKey(invitation?.id,player.id),()=>marked);
      if(!availOk){setSubmitState("error");return;}
    }
    if(invitation&&hasInvitation){
      const ok=await updateInvitation(invitation.id,prev=>({...prev,submittedIds:[...(prev.submittedIds||[]),player.id],comments:{...(prev.comments||{}),[player.id]:submitComment.trim()},submittedAt:{...(prev.submittedAt||{}),[player.id]:new Date().toISOString()}}));
      if(!ok){setSubmitState("error");return;}
    } else {
      setLockedPlayers(prev=>{const n=new Set(prev);n.add(player.id);return n;});
    }
    setSubmitState("idle");
  };

  const applyTemplate=()=>{
    if(!template.size)return;
    const cur=marked; // current marks (synchronous read)
    if(invActive&&invitation){
      // Pre-count new slots synchronously
      let added=0;
      const d0=new Date(invitation.startIso);
      while(isoDate(d0)<=invitation.endIso){
        const di=(d0.getDay()+6)%7;
        for(const b of BLOCKS){if(template.has(`${di}|${b}`)&&!isPast(d0)&&!cur.has(slotKey(isoDate(d0),b)))added++;}
        d0.setDate(d0.getDate()+1);
      }
      setMarked(prev=>{
        const n=new Set(prev);
        const d=new Date(invitation.startIso);
        while(isoDate(d)<=invitation.endIso){
          const di=(d.getDay()+6)%7;
          for(const b of BLOCKS){if(template.has(`${di}|${b}`)&&!isPast(d))n.add(slotKey(isoDate(d),b));}
          d.setDate(d.getDate()+1);
        }
        return n;
      });
      setApplyMsg(added>0?`✓ ${added} tider udfyldt`:"Ingen nye tider at udfylde");
    } else {
      // Pre-compute: count new slots & find first week with matches
      let added=0,firstMatchWeek=-1;
      for(let w=0;w<HORIZON_WEEKS;w++){
        const s=new Date(baseMonday);s.setDate(s.getDate()+w*7);
        for(let i=0;i<7;i++){
          const d=new Date(s);d.setDate(d.getDate()+i);
          if(isPast(d))continue;
          const di=(d.getDay()+6)%7;
          for(const b of BLOCKS){
            if(template.has(`${di}|${b}`)){
              if(firstMatchWeek===-1)firstMatchWeek=w;
              if(!cur.has(slotKey(isoDate(d),b)))added++;
            }
          }
        }
      }
      setMarked(prev=>{
        const n=new Set(prev);
        for(let w=0;w<HORIZON_WEEKS;w++){
          const s=new Date(baseMonday);s.setDate(s.getDate()+w*7);
          for(let i=0;i<7;i++){
            const d=new Date(s);d.setDate(d.getDate()+i);
            const di=(d.getDay()+6)%7;
            for(const b of BLOCKS){if(template.has(`${di}|${b}`)&&!isPast(d))n.add(slotKey(isoDate(d),b));}
          }
        }
        return n;
      });
      if(firstMatchWeek!==-1)setWeekOffset(firstMatchWeek);
      setApplyMsg(added>0?`✓ ${added} tider udfyldt`:"Ingen nye tider at udfylde");
    }
  };

  const applyPaint=(d,b,val)=>{
    if(!cellEditable(d))return;
    setMarked(prev=>{const n=new Set(prev);const k=slotKey(isoDate(d),b);val?n.add(k):n.delete(k);return n;});
  };
  const onCellDown=(d,b)=>{if(!cellEditable(d))return;const val=!isMarked(d,b);paintRef.current=val;applyPaint(d,b,val);};
  const onCellEnter=(d,b)=>{if(paintRef.current===null)return;applyPaint(d,b,paintRef.current);};
  const onCellTouchStart=(d,b)=>{lastTouchRef.current=Date.now();onCellDown(d,b);};
  const onCellMouseDown=(d,b)=>{if(isGhostMouseEvent())return;onCellDown(d,b);};

  // Tæl markeringer inden for perioden
  const markedInPeriod=invActive?[...marked].filter(k=>{const iso=k.split("|")[0];return iso>=invitation.startIso&&iso<=invitation.endIso;}).length:marked.size;

  // Kun de dage i den aktuelle uge der falder inden for perioden
  const visibleDates=invActive?weekDates.filter(d=>isoDate(d)>=invitation.startIso&&isoDate(d)<=invitation.endIso):weekDates;
  // Antal uger i perioden (til skabelon-knap)
  const invWeeks=useMemo(()=>{if(!invActive)return 0;let c=0,w=invMinWeek;while(w<=invMaxWeek){c++;w++;}return c;},[invActive,invMinWeek,invMaxWeek]);

  const perWeek=useMemo(()=>{
    const arr=[];
    for(let w=0;w<HORIZON_WEEKS;w++){
      const s=new Date(baseMonday);s.setDate(s.getDate()+w*7);
      let count=0;
      for(let i=0;i<7;i++){const d=new Date(s);d.setDate(d.getDate()+i);for(const b of BLOCKS)if(marked.has(slotKey(isoDate(d),b)))count++;}
      arr.push({w,count,start:new Date(s)});
    }
    return arr;
  },[marked,baseMonday]);

  // Delt hjælper: render én ugegrid med et givet sæt dage
  const renderWeekGrid=(days,accentColor)=>(
    <div className="overflow-x-auto select-none">
      <table className="w-full border-separate" style={{borderSpacing:"3px 2px",tableLayout:"fixed"}}>
        <thead><tr><th className="w-16"/>
          {days.map((d,i)=>{
            const past=isPast(d),isToday=isoDate(d)===isoDate(today);
            const di=(d.getDay()+6)%7;
            return(
            <th key={i} className="text-center align-bottom pb-0.5">
              <div className={`text-[10px] font-semibold ${past?"text-slate-300":accentColor?"text-amber-600":"text-slate-400"}`}>{DAY_KEYS[di]}</div>
              <div className={`text-sm font-bold ${past?"text-slate-300":isToday?"text-lime-600":accentColor?"text-amber-700":"text-slate-800"}`}>{d.getDate()}</div>
              <div className={`text-[9px] ${past?"text-slate-300":"text-slate-400"}`}>{MONTHS[d.getMonth()]}</div>
            </th>);})}
        </tr></thead>
        <tbody>{BLOCKS.map(b=>(
          <tr key={b}><td className="text-[10px] font-medium text-slate-400 pr-1 whitespace-nowrap align-middle">{blockLabel(b)}</td>
            {days.map((d,i)=>{
              const past=isPast(d),on=isMarked(d,b),editable=cellEditable(d);
              return(
              <td key={i} className="p-0"><button
                disabled={past||!editable}
                onMouseDown={()=>onCellMouseDown(d,b)} onMouseEnter={()=>onCellEnter(d,b)} onTouchStart={()=>onCellTouchStart(d,b)}
                className={`w-full rounded transition-colors ${
                  past?"bg-slate-50 cursor-not-allowed":
                  !editable&&on?"bg-lime-300 cursor-default":
                  !editable?"bg-slate-100 cursor-not-allowed":
                  on?"bg-lime-500 hover:bg-lime-600":
                  accentColor?"bg-amber-50 hover:bg-amber-100 border border-amber-200":
                  "bg-slate-100 hover:bg-blue-100"}`}
                style={{height:22}}
              /></td>);})}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  return(
    <div className="space-y-4">
      {/* Spillerhoved */}
      <div className="bg-gradient-to-r from-blue-900 to-blue-700 text-white rounded-2xl p-4 flex items-center gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-full bg-white/20 grid place-items-center font-bold shrink-0 overflow-hidden">{avatarContent(player)}</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">
            {isSubmitted?"Kalender afsendt":invActive?"Marker hvornår du vil spille":player.name}
          </div>
          <div className="text-white/70 text-xs">
            {isSubmitted
              ?`${markedInPeriod} tider valgt · låst for ændringer`
              :invActive
                ?`${fmtShort(new Date(invitation.startIso))} – ${fmtShort(new Date(invitation.endIso))} · ${markedInPeriod} tider valgt`
                :editingSelf&&!hasInvitation
                  ?"Ugentlige præferencer"
                  :`${marked.size} tider markeret${!canEdit?" (skrivebeskyttet)":""}`
            }
          </div>
        </div>
      </div>

      {/* Flere forespørgsler til denne spiller */}
      {editingSelf&&!lockedInvitationId&&activeInvitations.length>1&&(
        <div className="bg-white rounded-2xl border border-slate-200 p-3">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Dine forespørgsler ({activeInvitations.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {activeInvitations.map(inv=>{
              const subm=(inv.submittedIds||[]).includes(player.id);
              const active=inv.id===selInvId;
              return(
                <button key={inv.id} onClick={()=>setSelInvId(inv.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-2.5 py-1 text-xs border transition-colors ${active?"bg-blue-700 text-white border-blue-700":subm?"bg-lime-50 text-lime-700 border-lime-200 hover:bg-lime-100":"bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"}`}>
                  {subm?<CheckCircle2 size={11}/>:<Bell size={11}/>}
                  {inv.title||"Forespørgsel"}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Arkiverede besvarelser — kan genbruges som kladde til en ny periode */}
      {editingSelf&&!lockedInvitationId&&archivedInvitations.length>0&&(
        <div className="bg-white rounded-2xl border border-slate-200 p-3">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Arkiverede besvarelser ({archivedInvitations.length})</div>
          <p className="text-xs text-slate-400 mb-2">Tidligere besvarede perioder, som er afsluttet. Kopiér mønsteret til kladden for din aktive forespørgsel.</p>
          <div className="space-y-1.5">
            {archivedInvitations.map(inv=>(
              <div key={inv.id} className="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-700 truncate">{inv.title||"Forespørgsel"}</div>
                  <div className="text-[10px] text-slate-400">{fmtShort(new Date(inv.startIso))} – {fmtShort(new Date(inv.endIso))}</div>
                </div>
                <button onClick={()=>copyArchivedToDraft(inv)} disabled={!invitation||isSubmitted}
                  title={!invitation?"Vælg en aktiv forespørgsel først":isSubmitted?"Din kalender er allerede indsendt":"Kopiér til kladde"}
                  className="inline-flex items-center gap-1 text-[11px] bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-inherit shrink-0 font-medium text-slate-600">
                  <Copy size={11}/> Kopiér til kladde
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasInvitation&&!editingSelf&&(
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <Bell size={15} className="shrink-0 mt-0.5 text-amber-600"/>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-amber-800">Anmodning om spilletider{myInvitations.length>1?` (+${myInvitations.length-1} flere)`:""}</div>
            <div className="text-xs text-amber-700 mt-0.5">
              {fmtShort(new Date(invitation.startIso))} – {fmtShort(new Date(invitation.endIso))}
              {" "}(U{getISOWeek(new Date(invitation.startIso))}–U{getISOWeek(new Date(invitation.endIso))})
            </div>
          </div>
        </div>
      )}

      {canEdit&&!isSubmitted&&!submitDeadlinePassed&&(
        <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
          <button onClick={()=>setShowTemplate(v=>!v)}
            className="w-full flex items-center justify-between text-xs font-semibold text-slate-500 uppercase tracking-wide">
            <span className="flex items-center gap-1.5"><CalendarClock size={13} className="text-blue-600"/> Faste ugentlige tider</span>
            <ChevronDown size={13} className={`transition-transform ${showTemplate?"rotate-180":""}`}/>
          </button>
          {showTemplate&&(
            <>
              <p className="text-xs text-slate-500">{editingSelf&&!hasInvitation?"Markér dine faste ugentlige tider. De gemmes og overføres automatisk til kalenderen, når du modtager en forespørgsel om spilletider.":"Markér hvilke ugedage og tidspunkter du normalt kan — udfyld derefter alle uger på én gang, og fjern siden de du alligevel ikke kan."}</p>
              <div className="overflow-x-auto select-none">
                <table className="w-full border-separate" style={{borderSpacing:"3px 2px",tableLayout:"fixed"}}>
                  <thead><tr><th className="w-16"/>
                    {DAY_KEYS.map((dk,i)=>(
                      <th key={i} className="text-center">
                        <div className="text-[10px] font-semibold text-slate-400">{dk}</div>
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>{BLOCKS.map(b=>(
                    <tr key={b}><td className="text-[10px] font-medium text-slate-400 pr-1 whitespace-nowrap align-middle">{blockLabel(b)}</td>
                      {DAY_KEYS.map((_,di)=>{
                        const key=`${di}|${b}`,on=template.has(key);
                        return(
                        <td key={di} className="p-0">
                          <button type="button"
                            onMouseDown={(e)=>{e.preventDefault();if(isGhostMouseEvent())return;const val=!template.has(key);templatePaintRef.current=val;setApplyMsg(null);setTemplate(prev=>{const n=new Set(prev);val?n.add(key):n.delete(key);return n;});}}
                            onMouseEnter={()=>{if(templatePaintRef.current===null)return;setTemplate(prev=>{const n=new Set(prev);templatePaintRef.current?n.add(key):n.delete(key);return n;});}}
                            onTouchStart={(e)=>{lastTouchRef.current=Date.now();const val=!template.has(key);templatePaintRef.current=val;setApplyMsg(null);setTemplate(prev=>{const n=new Set(prev);val?n.add(key):n.delete(key);return n;});}}
                            className={`w-full rounded transition-colors ${on?"bg-blue-600 hover:bg-blue-700":"bg-slate-100 hover:bg-blue-100"}`}
                            style={{height:20}}/>
                        </td>);
                      })}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {(!editingSelf||hasInvitation)&&(
                  <button type="button" onClick={applyTemplate} disabled={!template.size}
                    className="inline-flex items-center gap-2 bg-blue-700 text-white text-sm font-semibold rounded-xl px-4 py-2 hover:bg-blue-800 disabled:opacity-40 transition-colors">
                    <CheckCircle2 size={14}/> {invActive?`Udfyld alle ${invWeeks} uger`:`Anvend på alle ${HORIZON_WEEKS} uger`}
                  </button>
                )}
                {applyMsg&&<span className="text-xs font-semibold text-lime-700">{applyMsg}</span>}
                {template.size>0&&<button type="button" onClick={()=>{setTemplate(new Set());setApplyMsg(null);}} className="text-xs text-slate-500 hover:underline">Ryd skabelon</button>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Afventer anmodning — vises kun for spillere uden aktiv invitation */}
      {editingSelf&&!hasInvitation&&(
        <div className="bg-slate-50 rounded-2xl border border-dashed border-slate-300 p-6 text-center space-y-1">
          <Bell size={26} className="mx-auto text-slate-300"/>
          <div className="text-sm font-semibold text-slate-500">Afventer forespørgsel</div>
          <div className="text-xs text-slate-400">Du er endnu ikke blevet spurgt om dine spilletider. Dine ugentlige præferencer herover er gemt og klar til brug.</div>
        </div>
      )}

      {/* Kalender — kun synlig når man redigerer en anden spillers kalender eller når der er en aktiv invitation */}
      {(!editingSelf||hasInvitation)&&(
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <WeekNav weekOffset={weekOffset} setWeekOffset={setWeekOffsetClamped} weekDates={weekDates} minWeek={invActive?invMinWeek:undefined} maxWeek={invActive?invMaxWeek:undefined}/>
          {renderWeekGrid(visibleDates,false)}
          <div className="flex items-center gap-3 mt-2 text-xs text-slate-500 flex-wrap">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-lime-500 inline-block"/> Vil spille</span>
            {hasInvitation&&<span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-100 inline-block"/> Ikke valgt</span>}
            <span className="ml-auto font-medium text-slate-600">{markedInPeriod} valgt</span>
          </div>
        </div>
      )}

      {!editingSelf&&!invActive&&(
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Overblik · {HORIZON_WEEKS} uger</div>
          <WeekBar perWeek={perWeek} weekOffset={weekOffset} setWeekOffset={setWeekOffsetClamped}/>
        </div>
      )}

      {canEdit&&(!editingSelf||hasInvitation)&&(
        <div className="flex items-center justify-between">
          <button onClick={()=>{
            if(invActive){
              setMarked(prev=>{const n=new Set(prev);[...n].forEach(k=>{const iso=k.split("|")[0];if(iso>=invitation.startIso&&iso<=invitation.endIso)n.delete(k);});return n;});
            } else {setMarked(()=>new Set());}
          }} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg px-3 py-2">
            <RefreshCw size={14}/> {invActive?"Ryd periode":"Ryd alt"}
          </button>
          <div className="inline-flex items-center gap-1.5 text-sm font-medium text-lime-700"><CheckCircle2 size={16}/> Gemmes automatisk</div>
        </div>
      )}

      {/* Kommentar til afsenderen — kun inden indsendelse */}
      {editingSelf&&hasInvitation&&!isSubmitted&&!submitDeadlinePassed&&(
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <label className="text-xs font-medium text-slate-600 block mb-1.5">Kommentar til {invitation.createdByName||"afsenderen"} (valgfri)</label>
          <textarea value={submitComment} onChange={e=>setSubmitComment(e.target.value)} rows={2} placeholder="Skriv en kommentar, der bliver synlig for den som har oprettet forespørgslen…"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"/>
        </div>
      )}
      {editingSelf&&hasInvitation&&isSubmitted&&invitation?.comments?.[player.id]&&(
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <div className="text-xs font-medium text-slate-500 mb-1">Din kommentar</div>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{invitation.comments[player.id]}</p>
        </div>
      )}

      {/* Send / låst-status — kun relevant med aktiv invitation */}
      {editingSelf&&hasInvitation&&(
        isSubmitted
          ?<div className="w-full inline-flex items-center justify-center gap-2 bg-lime-50 border border-lime-200 text-lime-800 font-semibold text-sm rounded-xl py-3">
            <CheckCircle2 size={16} className="text-lime-600"/> Tider indsendt — låst for ændringer
          </div>
          :submitDeadlinePassed
            ?<div className="w-full inline-flex items-center justify-center gap-2 bg-red-50 border border-red-200 text-red-700 font-semibold text-sm rounded-xl py-3">
              <Lock size={16} className="text-red-500"/> Fristen er overskredet — indrapportering lukket
            </div>
            :<div className="space-y-1.5">
              <button onClick={submitCalendar} disabled={submitState==="saving"}
                className="w-full inline-flex items-center justify-center gap-2 bg-blue-700 text-white font-semibold text-sm rounded-xl py-3 hover:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm">
                {submitState==="saving"?<>Gemmer…</>:<><Send size={16}/> Indsend datoer</>}
              </button>
              {submitState==="error"&&(
                <div className="flex items-center gap-1.5 text-xs text-red-600 font-medium">
                  <AlertTriangle size={13}/> Kunne ikke gemme dine tider — tjek din forbindelse og prøv "Indsend" igen.
                </div>
              )}
            </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PROFIL-MODAL
═══════════════════════════════════════════════════════════ */
function ProfilModal({currentUser,players,setPlayers,avail,baseMonday,onClose}){
  const {saveProfile:saveProfileRemote,changePassword}=useAuth();
  const [editName,setEditName]=useState(currentUser.name);
  const [editPhone,setEditPhone]=useState(currentUser.phone||"");
  const [profileSaved,setProfileSaved]=useState(false);
  const [profileErr,setProfileErr]=useState("");
  const [curPw,setCurPw]=useState("");
  const [newPw,setNewPw]=useState("");
  const [repPw,setRepPw]=useState("");
  const [showCur,setShowCur]=useState(false);
  const [showNew,setShowNew]=useState(false);
  const [pwErr,setPwErr]=useState("");
  const [pwOk,setPwOk]=useState(false);
  const [pwBusy,setPwBusy]=useState(false);

  const myPlayer=players.find(p=>p.id===currentUser.id);
  const [showAvatarPicker,setShowAvatarPicker]=useState(false);
  const avatarFileRef=useRef(null);
  const EMOJI_CHOICES=["😀","😎","🦁","⚡","🔥","🐺","🚀","🏆","🎯","🐧","🥅","🦊"];
  const setMyAvatarImage=(dataUrl)=>{setPlayers(ps=>ps.map(p=>p.id===currentUser.id?{...p,avatarImage:dataUrl,avatarEmoji:null}:p));setShowAvatarPicker(false);};
  const setMyAvatarEmoji=(em)=>{setPlayers(ps=>ps.map(p=>p.id===currentUser.id?{...p,avatarEmoji:em,avatarImage:null}:p));setShowAvatarPicker(false);};
  const clearMyAvatar=()=>{setPlayers(ps=>ps.map(p=>p.id===currentUser.id?{...p,avatarImage:null,avatarEmoji:null}:p));setShowAvatarPicker(false);};
  const handleMyPhotoPick=async(file)=>{
    if(!file)return;
    setMyAvatarImage(await resizeImageToDataURL(file));
  };

  // Navn/telefon/avatar gemmes i Firestore ("profiles"-collection). E-mailadressen er selve
  // login-identiteten i Firebase Auth og redigeres ikke her — det ville kræve en ekstra
  // bekræftelses-mail og reautentificering, som er sprunget over for at holde omfanget nede.
  const saveProfile=async()=>{
    const name=editName.trim(),phone=editPhone.trim();
    if(!name)return;
    setProfileErr("");
    try{
      setPlayers(ps=>ps.map(p=>p.id===currentUser.id?{...p,name,phone}:p));
      await saveProfileRemote({name,phone});
      setProfileSaved(true);setTimeout(()=>setProfileSaved(false),2500);
    }catch(e){ setProfileErr(e.message||"Kunne ikke gemme ændringerne."); }
  };

  // Firebase Auth kræver at man "reautentificerer" med sin nuværende adgangskode, før den vil
  // skifte til en ny — det er en indbygget sikkerhedsforanstaltning, ikke noget vi selv tjekker.
  const changePw=async()=>{
    if(newPw.length<6){setPwErr("Ny adgangskode skal have mindst 6 tegn.");return;}
    if(newPw!==repPw){setPwErr("Adgangskoderne matcher ikke.");return;}
    setPwErr("");setPwBusy(true);
    try{
      await changePassword(curPw,newPw);
      setPwOk(true);setCurPw("");setNewPw("");setRepPw("");
      setTimeout(()=>setPwOk(false),3000);
    }catch(e){
      const code=e?.code||"";
      setPwErr(code==="auth/invalid-credential"||code==="auth/wrong-password"?"Nuværende adgangskode er forkert.":"Kunne ikke skifte adgangskode.");
    }finally{ setPwBusy(false); }
  };

  // Kalendermarkeringer er nu pr. forespørgsel (se availKey()) — dette er kun en grov oversigt
  // over hvor mange uger brugeren har markeret NOGET i, uanset hvilken forespørgsel, så vi
  // forener markeringerne på tværs af alle brugerens forespørgsels-nøgler her.
  const marked=useMemo(()=>{
    const u=new Set();
    const suffix=`:${currentUser.id}`;
    Object.entries(avail||{}).forEach(([k,set])=>{ if(k.endsWith(suffix))(set||new Set()).forEach(v=>u.add(v)); });
    return u;
  },[avail,currentUser.id]);
  const weeksWithSlots=useMemo(()=>{
    let c=0;
    for(let w=0;w<HORIZON_WEEKS;w++){
      const s=new Date(baseMonday);s.setDate(s.getDate()+w*7);
      let has=false;
      outer:for(let i=0;i<7;i++){const d=new Date(s);d.setDate(d.getDate()+i);for(const b of BLOCKS){if(marked.has(slotKey(isoDate(d),b))){has=true;break outer;}}}
      if(has)c++;
    }
    return c;
  },[marked,baseMonday]);

  return(
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col" style={{maxHeight:"90vh"}}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
          <button type="button" onClick={()=>setShowAvatarPicker(v=>!v)} title="Skift profilbillede"
            className="w-10 h-10 rounded-xl grid place-items-center text-sm font-bold shrink-0 overflow-hidden bg-blue-700 text-white">
            {myPlayer?.avatarImage
              ?<img src={myPlayer.avatarImage} alt="" className="w-full h-full object-cover"/>
              :myPlayer?.avatarEmoji
                ?<span className="text-lg">{myPlayer.avatarEmoji}</span>
                :initials(currentUser.name)}
          </button>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-slate-800 truncate">{currentUser.name}</div>
            <div className="text-xs text-slate-400 truncate">{currentUser.email}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 ml-1"><X size={18}/></button>
        </div>

        {showAvatarPicker&&(
          <div className="px-5 py-3 border-b border-slate-100 shrink-0 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={()=>avatarFileRef.current&&avatarFileRef.current.click()}
                className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-100 font-medium text-slate-600">Upload profilfoto</button>
              {(myPlayer?.avatarImage||myPlayer?.avatarEmoji)&&(
                <button type="button" onClick={clearMyAvatar} className="text-xs text-slate-400 hover:text-red-500">Nulstil</button>
              )}
              <input ref={avatarFileRef} type="file" accept="image/*" className="hidden" onChange={e=>{handleMyPhotoPick(e.target.files?.[0]);e.target.value="";}}/>
            </div>
            <div className="flex flex-wrap gap-1">
              {EMOJI_CHOICES.map(em=>(
                <button type="button" key={em} onClick={()=>setMyAvatarEmoji(em)} className="w-8 h-8 rounded-lg hover:bg-slate-100 text-lg grid place-items-center">{em}</button>
              ))}
            </div>
          </div>
        )}

        {/* Scrollable body */}
        <div className="overflow-y-auto p-5 space-y-5">
          {/* Profiloplysninger */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Profiloplysninger</div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Navn</label>
              <input value={editName} onChange={e=>{setEditName(e.target.value);setProfileSaved(false);}}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">E-mailadresse</label>
              <div className="w-full text-sm border border-slate-100 bg-slate-50 text-slate-500 rounded-lg px-3 py-2.5">{currentUser.email}</div>
              <p className="text-[11px] text-slate-400 mt-1">Din e-mailadresse er din login-identitet og kan ikke ændres her.</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">Telefonnummer</label>
              <input type="tel" value={editPhone} onChange={e=>{setEditPhone(e.target.value);setProfileSaved(false);}} placeholder="Fx 20 10 30 40"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
            </div>
            {profileErr&&<p className="text-xs text-red-500 font-medium">{profileErr}</p>}
            <button onClick={saveProfile} disabled={!editName.trim()}
              className="inline-flex items-center gap-2 bg-blue-700 text-white text-sm font-semibold rounded-xl px-5 py-2.5 hover:bg-blue-800 disabled:opacity-40 transition-colors">
              {profileSaved?<><Check size={15}/> Gemt!</>:"Gem ændringer"}
            </button>
          </div>

          {/* Adgangskode */}
          <div className="border-t border-slate-100 pt-5 space-y-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1.5"><Lock size={12}/> Adgangskode</div>
            {[
              {label:"Nuværende adgangskode",val:curPw,set:setCurPw,show:showCur,toggle:()=>setShowCur(v=>!v)},
              {label:"Ny adgangskode",val:newPw,set:setNewPw,show:showNew,toggle:()=>setShowNew(v=>!v)},
              {label:"Gentag ny adgangskode",val:repPw,set:setRepPw,show:showNew,toggle:()=>setShowNew(v=>!v)},
            ].map(({label,val,set,show,toggle},i)=>(
              <div key={i}>
                <label className="block text-xs font-semibold text-slate-500 mb-1.5">{label}</label>
                <div className="relative">
                  <input type={show?"text":"password"} value={val} onChange={e=>{set(e.target.value);setPwErr("");setPwOk(false);}}
                    className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500"/>
                  <button onClick={toggle} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">{show?<EyeOff size={15}/>:<Eye size={15}/>}</button>
                </div>
              </div>
            ))}
            {pwErr&&<p className="text-xs text-red-500 font-medium">{pwErr}</p>}
            {pwOk&&<p className="text-xs text-lime-600 font-medium flex items-center gap-1"><CheckCircle2 size={13}/> Adgangskode opdateret!</p>}
            <button onClick={changePw} disabled={pwBusy}
              className="inline-flex items-center gap-2 bg-slate-800 text-white text-sm font-semibold rounded-xl px-5 py-2.5 hover:bg-slate-900 disabled:opacity-40 transition-colors">
              <Key size={14}/> {pwBusy?"Skifter…":"Skift adgangskode"}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   APP
═══════════════════════════════════════════════════════════ */
export default function App(){
  const today=useMemo(()=>{const t=new Date();t.setHours(0,0,0,0);return t;},[]);
  const baseMonday=useMemo(()=>mondayOf(today),[today]);

  // Rigtig Firebase Authentication erstatter det gamle mock-login (INITIAL_USERS +
  // generatePassword). "currentUser" er en sammenfletning af Firebase Auth-identiteten og det
  // tilhørende Firestore-profildokument (navn, telefon, avatar) — resten af appen bruger den
  // præcis som før, blot uden adgangskoder i almindelig tekst noget sted.
  const {firebaseUser,currentUser,loading:authLoading,signIn,signUp,signOut,resetPassword,deleteAccount}=useAuth();

  const [showProfil,setShowProfil]=useState(false);
  const [tab,setTab]=useState("overblik");

  // Alt app-data hentes nu realtime fra Firestore i stedet for at ligge i lokal React-state —
  // derfor er data permanent og synkront delt mellem alle brugere. "enabled: !!firebaseUser"
  // undgår forsøg på at læse, før man er logget ind (Firestore-reglerne kræver det alligevel).
  const [players,setPlayers]=useFirestoreCollection("profiles",[],!!firebaseUser);
  const [invitations,setInvitations]=useFirestoreCollection("invitations",[],!!firebaseUser);
  const draftsQuery=useMemo(()=>firebaseUser?[where("createdById","==",firebaseUser.uid)]:[],[firebaseUser?.uid]);
  const [drafts,setDrafts]=useFirestoreCollection("drafts",draftsQuery,!!firebaseUser); // kladder — kun mine egne, filtreret i selve Firestore-forespørgslen
  const [openDraftId,setOpenDraftId]=useState(null); // hvilken kladde der skal indlæses i "Opret forespørgsel"
  const [friendRequests,setFriendRequests]=useFirestoreCollection("friendRequests",[],!!firebaseUser);
  // "Inviter en ny spiller" (mail til nogen uden konto endnu) opretter et "invites"-dokument —
  // her abonneres realtime på MINE afsendte, stadig ventende invitationer, så de kan vises som
  // "afventer" både i venlisten og på den forespørgsel, de hører til, i stedet for at forsvinde
  // fra syne indtil personen rent faktisk opretter en konto (se handleSignup).
  const myPendingInvitesQuery=useMemo(()=>firebaseUser?[where("invitedByUid","==",firebaseUser.uid),where("status","==","pending")]:[],[firebaseUser?.uid]);
  const [myPendingInvites]=useFirestoreCollection("invites",myPendingInvitesQuery,!!firebaseUser);
  // Fortryd/annuller en afsendt-men-endnu-ikke-indløst invitation (fx hvis man kom til at invitere
  // den forkerte, eller samme person to gange) — sletter blot "invites"-dokumentet, personen kan
  // ikke længere bruge signup-linket til automatisk at blive tilføjet.
  const cancelPendingInvite=(inviteId)=>deleteDoc(doc(db,"invites",inviteId)).catch(()=>{});

  // Delt hold-data der ikke naturligt er "en liste af poster med hvert sit id" gemmes i stedet
  // som ét samlet dokument hver (se useFirestoreDocState) — det matcher den oprindelige
  // state-facon 1:1, så resten af appens kode (KaptajnOverblik, InvitationCard, SpillerKalender
  // osv.) er stort set uændret.
  //
  // avail/templates er dog "byPlayer"-formen — hver spillers egne markeringer, uafhængigt af alle
  // andres — og bruger derfor useFirestorePartitionedMap: setAvail(playerId, fn) skriver KUN til
  // den ene spillers egen nøgle i Firestore (via merge), aldrig hele dokumentet på én gang. Det er
  // den strukturelle rettelse af den gentagne "kalenderdata forsvinder"-fejl: uanset hvad denne
  // browser-fane tilfældigvis har liggende lokalt om ANDRE spilleres data, kan en skrivning her
  // aldrig røre ved dem.
  // Synlig fejlbesked hvis en gemning til Firestore fejler (fx tabt forbindelse) — UDEN denne ville
  // brugeren ikke kunne se det: skærmen viser stadig ens egne (lokale, optimistiske) markeringer
  // fint, selvom skrivningen aldrig nåede serveren, og først når siden senere synkroniserer med den
  // ægte (uændrede) serverdata forsvinder markeringerne igen, tilsyneladende uden grund.
  const saveErrorTimeoutRef=useRef(null);
  const [saveError,setSaveError]=useState(null);
  const handleSaveError=()=>{
    setSaveError("Kunne ikke gemme ændringen – tjek din internetforbindelse og prøv igen. Genindlæs siden for en sikkerheds skyld, når forbindelsen er tilbage.");
    if(saveErrorTimeoutRef.current)clearTimeout(saveErrorTimeoutRef.current);
    saveErrorTimeoutRef.current=setTimeout(()=>setSaveError(null),12000);
  };
  const [avail,setAvail]=useFirestorePartitionedMap("state/availability",{toItem:setItemToFirestore,fromItem:setItemFromFirestore,onError:handleSaveError});
  const [templates,setTemplates]=useFirestorePartitionedMap("state/templates",{toItem:setItemToFirestore,fromItem:setItemFromFirestore,onError:handleSaveError});
  // Venner: pr. bruger en liste af spiller-id'er man er blevet venner med (gensidigt) — kun venner
  // kan findes/tilføjes til en forespørgsel via søgning, så man ikke ser hele spillerlisten i systemet.
  const [friends,setFriends]=useFirestoreDocState("state/friends",{},{toFirestore:plainMapToFirestore,fromFirestore:plainMapFromFirestore,onError:handleSaveError});
  const [matches,setMatches]=useFirestoreDocState("state/matches",[],{toFirestore:listToFirestore,fromFirestore:listFromFirestore,onError:handleSaveError});
  const [lockedPlayers,setLockedPlayers]=useFirestoreDocState("state/lockedPlayers",new Set(),{toFirestore:setToFirestore,fromFirestore:setFromFirestore,onError:handleSaveError});

  const [showFriends,setShowFriends]=useState(false);
  const [showIntro,setShowIntro]=useState(false); // "Introduktion til funktionerne" — trin-for-trin guide fra profilmenuen
  const [showDeleteProfile,setShowDeleteProfile]=useState(false);

  // invitationId (valgfrit): bruges når man forsøger at tilføje en spiller, der allerede har en
  // konto, til en bestemt huddle — men ikke er venner med dem endnu (søgningen i "Opret Ny Huddle"
  // og på selve forespørgselskortet viser kun venner, jf. kommentaren ved acceptFriendRequest).
  // I stedet for en blind afvisning ("søg som ven i stedet" — uden nogen vej videre) sendes her en
  // venneanmodning MED huddlen hæftet på, så personen automatisk bliver tilføjet til netop denne
  // forespørgsel, i det øjeblik de accepterer (se acceptFriendRequest).
  const sendFriendRequest=(toId,invitationId)=>{
    if(!toId||toId===currentUser?.id)return;
    setFriendRequests(prev=>{
      const existing=prev.find(r=>r.fromId===currentUser.id&&r.toId===toId);
      if(existing){
        if(invitationId&&!existing.invitationId){
          return prev.map(r=>r.id===existing.id?{...r,invitationId}:r);
        }
        return prev;
      }
      return[...prev,{id:newDocId("friendRequests"),fromId:currentUser.id,toId,...(invitationId?{invitationId}:{})}];
    });
  };
  const cancelFriendRequest=(reqId)=>setFriendRequests(prev=>prev.filter(r=>r.id!==reqId));
  // BEMÆRK: venskaber skrives IKKE via den almindelige setFriends her (som overskriver hele
  // "state/friends"-dokumentet ud fra ens egen lokale kopi) — det er netop den slags fulde
  // overskrivning der tidligere gav problemer med forsvundne data. "state/friends" er ét delt
  // dokument som alle brugere skriver til, så hvis to personer skriver til det næsten samtidig
  // (fx: du accepterer en anmodning i samme øjeblik som en anden spiller fjerner en ven), kan
  // den ene skrivning risikere at overskrive/slette den anden, hvis den er baseret på en lokal
  // kopi der lige nøjagtig ikke nåede at få den nyeste ændring endnu — med det resultat at det
  // NETOP tilføjede venskab aldrig "slår igennem" hos modparten. Derfor bruges her i stedet
  // Firestores egne atomare arrayUnion/arrayRemove, som lægges sammen direkte på serveren og
  // derfor er immune over for den race, uanset hvad ens egen lokale kopi indeholder.
  const acceptFriendRequest=(reqId)=>{
    const req=(friendRequests||[]).find(r=>r.id===reqId);
    if(!req)return;
    setDoc(doc(db,"state/friends"),{byPlayer:{[req.fromId]:arrayUnion(req.toId),[req.toId]:arrayUnion(req.fromId)}},{merge:true})
      .catch(e=>console.error("Kunne ikke gemme venskabet:",e));
    if(req.invitationId){
      // Anmodningen hørte til en bestemt huddle (se sendFriendRequest) — så snart venskabet er
      // bekræftet, skal man med det samme kunne se huddlen, uden et ekstra klik. MEN: er huddlen
      // stadig kun en kladde (endnu ikke afsendt af kaptajnen), findes "invitations"-dokumentet
      // ikke i Firestore endnu — updateDoc fejler så med vilje (den opretter IKKE et nyt/ufuldstændigt
      // dokument, i modsætning til setDoc+merge). I det tilfælde beholder vi IKKE bare stille en
      // fejl: anmodningen markeres i stedet som "accepted" og bliver stående, så selve afsendelsen
      // (se sendInvitation) kan samle alle sådanne accepterede anmodninger op og tage dem med fra
      // den allerførste skrivning af dokumentet. Sådan er der ALDRIG noget bagefter der kan
      // overskrive/slette en spiller der allerede har sagt ja — den præcise fejl der blev rapporteret.
      updateDoc(doc(db,"invitations",req.invitationId),{playerIds:arrayUnion(req.toId),[`responses.${req.toId}`]:"accepted"})
        .then(()=>{
          // Huddlen var allerede afsendt — formålet med anmodningen er opfyldt, ryd den op.
          deleteDoc(doc(db,"friendRequests",reqId)).catch(()=>{});
        })
        .catch(()=>{
          setDoc(doc(db,"friendRequests",reqId),{accepted:true},{merge:true}).catch(()=>{});
        });
      return;
    }
    setFriendRequests(prev=>prev.filter(r=>r.id!==reqId));
  };
  const declineFriendRequest=(reqId)=>setFriendRequests(prev=>prev.filter(r=>r.id!==reqId));
  const removeFriend=(otherId)=>{
    if(!currentUser)return;
    setDoc(doc(db,"state/friends"),{byPlayer:{[currentUser.id]:arrayRemove(otherId),[otherId]:arrayRemove(currentUser.id)}},{merge:true})
      .catch(e=>console.error("Kunne ikke fjerne venskabet:",e));
  };

  // Kommer man via et invitations-link (?huddle=..., se buildSignupUrl) og logger ind med en
  // konto man allerede havde (i stedet for at oprette en ny), skal man stadig hoppe direkte til
  // den huddle linket hørte til — man er som regel allerede tilføjet til den (fordi man havde en
  // profil, kunne kaptajnen invitere en direkte i stedet for via e-mail), så her rører vi ikke ved
  // hverken venskaber eller svar, vi navigerer bare derhen. Læses kun ÉN gang, samme mønster som
  // inviteParams i LoginScreen.
  const urlHuddleId=useState(()=>new URLSearchParams(window.location.search).get("huddle")||null)[0];
  const handleLogin=async(email,password)=>{
    await signIn(email,password);
    if(urlHuddleId){ setFocusInvitationId(urlHuddleId); setTab("overblik"); }
  };
  const handleLogout=()=>{ setTab("overblik"); return signOut(); };

  // Sletning af egen profil ("Slet profil" i profil-dropdown). Rydder først alt det data, der
  // reelt tilhører netop denne bruger, direkte og afventet (IKKE via de almindelige setFriends
  // m.fl. — de skriver "fire and forget" i baggrunden, og her skal vi vide med sikkerhed at hver
  // oprydning er landet på serveren, FØR selve login-kontoen slettes og man logges ud). Delt data
  // (fx andre spilleres besvarelser, eller allerede fastlagte kampe) røres ikke — kun det, der er
  // knyttet til netop denne bruger.
  const handleDeleteProfile=async(password)=>{
    const uid=currentUser.id;

    // Atomart i stedet for at læse hele "state/friends" lokalt og skrive det hele tilbage — se
    // kommentaren ved acceptFriendRequest. deleteField() fjerner kun ens egen indgang, og
    // arrayRemove fjerner kun uid'et fra hver ven-liste, uden at røre noget som helst andet i det
    // delte dokument, uanset hvad der ellers måtte ske i det samtidig.
    const myFriendIds=friends[uid]||[];
    const friendsPayload={[uid]:deleteField()};
    myFriendIds.forEach(otherId=>{friendsPayload[otherId]=arrayRemove(uid);});
    await setDoc(doc(db,"state/friends"),{byPlayer:friendsPayload},{merge:true});

    await Promise.all((friendRequests||[])
      .filter(r=>r.fromId===uid||r.toId===uid)
      .map(r=>deleteDoc(doc(db,"friendRequests",r.id)).catch(()=>{})));

    await Promise.all((myPendingInvites||[])
      .map(iv=>deleteDoc(doc(db,"invites",iv.id)).catch(()=>{})));

    // Atomart — fjerner KUN denne spillers egne nøgler (se useFirestorePartitionedMap), i stedet
    // for at skrive hele dokumentet igen ud fra en lokal kopi der kan overskrive andre spilleres
    // kalendere, hvis de har ændret noget siden denne fane sidst hørte fra serveren.
    // "availability" er nu nøglet PR. FORESPØRGSEL+SPILLER (se availKey()), så denne spiller kan
    // have flere nøgler at rydde op i — én pr. forespørgsel de har markeret noget i — i stedet for
    // kun de(n) ene, gamle nøgle "[uid]".
    const availKeysToDelete=Object.keys(avail||{}).filter(k=>k.endsWith(`:${uid}`));
    if(availKeysToDelete.length){
      await setDoc(doc(db,"state/availability"),{byPlayer:Object.fromEntries(availKeysToDelete.map(k=>[k,deleteField()]))},{merge:true});
    }
    await setDoc(doc(db,"state/templates"),{byPlayer:{[uid]:deleteField()}},{merge:true});

    const nextLocked=new Set(lockedPlayers);
    nextLocked.delete(uid);
    await setDoc(doc(db,"state/lockedPlayers"),setToFirestore(nextLocked));

    await Promise.all((invitations||[])
      .filter(inv=>inv.playerIds.includes(uid))
      .map(inv=>{
        const{[uid]:_r,...responses}=inv.responses||{};
        const{[uid]:_c,...comments}=inv.comments||{};
        const payload={
          ...inv,
          playerIds:inv.playerIds.filter(id=>id!==uid),
          responses,
          submittedIds:(inv.submittedIds||[]).filter(id=>id!==uid),
          comments,
        };
        const{id,...data}=payload;
        return setDoc(doc(db,"invitations",id),data).catch(()=>{});
      }));

    await deleteDoc(doc(db,"profiles",uid));

    // Til sidst selve login-kontoen — kræver adgangskoden igen (Firebase-krav for så følsom en
    // handling), og logger automatisk ud bagefter da kontoen ikke længere findes.
    await deleteAccount(password);
  };

  // Selvbetjent oprettelse af profil fra login-siden. Bagefter tjekkes om der findes én eller
  // flere "ventende invitationer" (oprettet via "Inviter en ny spiller" andre steder i appen) til
  // netop denne e-mailadresse — er der det, oprettes en RIGTIG venneanmodning fra den der
  // inviterede. Ligesom for eksisterende brugere (se acceptFriendRequest) skal den nye spiller selv
  // trykke "Accepter" på sit Overblik — ét klik, som bekræfter både venskabet OG (hvis anmodningen
  // hørte til en bestemt forespørgsel) giver adgang til selve huddlen. Det er bevidst IKKE
  // automatisk: samme mekanisme bruges for alle, uanset om man havde en konto i forvejen eller ej.
  //
  // huddleId (valgfrit): kommer fra invitations-linket (?huddle=..., se buildSignupUrl) og er
  // selve invitations-ID'et — IKKE bare en e-mail. Den bruges som et ekstra, mere robust opslag:
  // selvom personen skulle finde på at oprette sin profil med en anden e-mail end den kaptajnen
  // inviterede, kan vi stadig finde frem til den rigtige "invites"-post (og dermed den rigtige
  // huddle) via dette ID. Det er linket der hænger sammen med forespørgslen, ikke e-mailen.
  const handleSignup=async({name,email,phone,password,avatarEmoji,avatarImage,huddleId})=>{
    const user=await signUp({name,email,phone,password,avatarEmoji,avatarImage});
    try{
      const byEmailQ=fsQuery(collection(db,"invites"),where("email","==",email.trim()),where("status","==","pending"));
      const byEmailSnap=await getDocs(byEmailQ);
      const inviteDocs=new Map(byEmailSnap.docs.map(d=>[d.id,d]));
      // Ekstra opslag på selve invitations-ID'et, i tilfælde af at personen oprettede sig med en
      // anden e-mail end den, invitationen egentlig blev sendt til — se kommentaren ovenfor.
      if(huddleId){
        const byHuddleQ=fsQuery(collection(db,"invites"),where("invitationId","==",huddleId),where("status","==","pending"));
        const byHuddleSnap=await getDocs(byHuddleQ);
        for(const d of byHuddleSnap.docs)inviteDocs.set(d.id,d);
      }
      for(const inviteDoc of inviteDocs.values()){
        const inv=inviteDoc.data();
        if(inv.invitedByUid){
          // Oprettes af DEN NYE bruger selv (det er jo dem der lige er logget ind, ikke den
          // oprindelige afsender) — se firestore.rules, hvor "friendRequests"-create bevidst
          // tillader begge parter, netop for at gøre dette muligt uden en Admin SDK/server.
          await setDoc(doc(db,"friendRequests",newDocId("friendRequests")),{
            fromId:inv.invitedByUid,toId:user.uid,
            ...(inv.invitationId?{invitationId:inv.invitationId}:{}),
          }).catch(e=>console.error("Kunne ikke oprette venneanmodningen:",e));
        }
        await setDoc(doc(db,"invites",inviteDoc.id),{...inv,status:"claimed"});
      }
    }catch(e){
      // En fejl her må ikke blokere selve kontooprettelsen — den er allerede gennemført.
      console.error("Kunne ikke afgøre ventende invitationer ved oprettelse:",e);
    }
    setTab("overblik");
  };

  // Firebase Auth sender selv en rigtig nulstillings-mail med et link — ingen EmailJS nødvendig her.
  const handleResetPassword=(email)=>resetPassword(email);

  // Notifikationer — samler alt der reelt afventer en handling fra brugeren selv: venneanmodninger
  // der skal besvares, forespørgsler der skal accepteres/afvises, og accepterede forespørgsler hvor
  // datoer endnu ikke er indsendt. Klokken vises altid; tallet og listen viser kun det reelt aktuelle.
  // Hooks skal altid kaldes uanset login-status, derfor står de her — FØR det tidlige return nedenfor.
  const notifications=useMemo(()=>{
    const list=[];
    (friendRequests||[]).filter(r=>r.toId===currentUser?.id&&!r.accepted).forEach(r=>{
      const p=players.find(pl=>pl.id===r.fromId);
      list.push({key:`friend-${r.id}`,type:"friend",label:p?.name||"Ukendt spiller",sub:"Vil gerne være venner"});
    });
    (invitations||[]).forEach(inv=>{
      if(!inv.playerIds.includes(currentUser?.id))return;
      if((inv.status||"active")!=="active")return;
      const resp=responseFor(inv,currentUser?.id);
      if(resp==="pending"){
        list.push({key:`accept-${inv.id}`,type:"invitation",invitationId:inv.id,label:inv.title||"Anmodning om spilletider",sub:"Afventer din accept"});
      }else if(resp==="accepted"&&!(inv.submittedIds||[]).includes(currentUser?.id)){
        list.push({key:`submit-${inv.id}`,type:"invitation",invitationId:inv.id,label:inv.title||"Anmodning om spilletider",sub:"Mangler at indsende datoer"});
      }
    });
    return list;
  },[friendRequests,invitations,players,currentUser]);
  const [notifOpen,setNotifOpen]=useState(false);
  const [focusInvitationId,setFocusInvitationId]=useState(null);
  // Tælles op hver gang man klikker på "HuddleUp"-titlen — hvert enkelt forespørgselskort lytter
  // efter en ændring her og folder sig selv sammen igen, se InvitationCard.
  const [collapseAllSignal,setCollapseAllSignal]=useState(0);
  const goToNotification=(n)=>{
    setNotifOpen(false);
    setTab("overblik");
    if(n.type==="invitation")setFocusInvitationId(n.invitationId);
  };

  if(authLoading)return(
    <div className="min-h-screen bg-slate-50 grid place-items-center">
      <p className="text-sm text-slate-400">Indlæser…</p>
    </div>
  );
  if(!currentUser)return<LoginScreen onLogin={handleLogin} onSignup={handleSignup} onResetPassword={handleResetPassword}/>;

  // NB: den tidligere "log ind som en spiller for at hjælpe dem"-funktion (impersonation) er
  // fjernet — med rigtig Firebase Auth kan man ikke logge ind som en anden bruger uden deres
  // adgangskode fra en ren klient-app (det kræver Admin SDK på en server, som denne app ikke
  // har). Det er ikke et reelt tab: "Hjælp med at udfylde for denne spiller"-knappen på hvert
  // forespørgselskort gjorde allerede præcis det samme direkte inline, uden kontoskift.
  //
  // Alle brugere har adgang til de samme faner. Fanen "Spillere" (den rå konto-/adgangsliste) er
  // fjernet — spillere styres nu udelukkende via Venner (profil-dropdown) og direkte fra den
  // enkelte forespørgsel (søg/inviter).
  return(
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6" style={{fontFamily:"system-ui,-apple-system,sans-serif"}}>
      {showProfil&&(
        <ProfilModal currentUser={currentUser} players={players} setPlayers={setPlayers} avail={avail} baseMonday={baseMonday} onClose={()=>setShowProfil(false)}/>
      )}
      {showFriends&&(
        <FriendsModal currentUser={currentUser} players={players} friends={friends} friendRequests={friendRequests} myPendingInvites={myPendingInvites}
          onSendRequest={sendFriendRequest} onCancelRequest={cancelFriendRequest} onRemoveFriend={removeFriend} onCancelPendingInvite={cancelPendingInvite} onClose={()=>setShowFriends(false)}/>
      )}
      {showIntro&&<IntroModal onClose={()=>setShowIntro(false)}/>}
      {showDeleteProfile&&<DeleteProfileModal onConfirm={handleDeleteProfile} onClose={()=>setShowDeleteProfile(false)}/>}
      {saveError&&(
        <div className="fixed top-0 inset-x-0 z-50 bg-red-600 text-white text-sm font-medium px-4 py-2.5 flex items-center justify-center gap-2 text-center shadow-md">
          <AlertTriangle size={16} className="shrink-0"/> {saveError}
          <button onClick={()=>setSaveError(null)} className="ml-1 shrink-0 opacity-80 hover:opacity-100"><X size={16}/></button>
        </div>
      )}
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={()=>{setTab("overblik");setCollapseAllSignal(v=>v+1);}}
            title="Tilbage til fuldt overblik"
            className="flex items-center gap-2 text-xl font-bold hover:opacity-80 transition-opacity" style={{color:"#32376E"}}>
            <LogoIcon size={30}/> HuddleUp
          </button>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button onClick={()=>setNotifOpen(v=>!v)} title={notifications.length>0?`${notifications.length} afventer dig`:"Ingen nye notifikationer"}
                className="relative w-9 h-9 grid place-items-center rounded-xl border border-slate-200 bg-white hover:bg-slate-50 transition-colors shrink-0">
                <Bell size={16} className="text-slate-500"/>
                {notifications.length>0&&(
                  <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold grid place-items-center leading-none">{notifications.length>9?"9+":notifications.length}</span>
                )}
              </button>
              {notifOpen&&(
                <>
                  <div className="fixed inset-0 z-10" onClick={()=>setNotifOpen(false)}/>
                  <div className="absolute right-0 top-full mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-20 w-72 overflow-hidden">
                    <div className="px-3.5 py-2.5 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide">Notifikationer</div>
                    {notifications.length===0?(
                      <div className="px-3.5 py-6 text-sm text-slate-400 text-center">Ingen nye notifikationer</div>
                    ):(
                      <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                        {notifications.map(n=>(
                          <button key={n.key} onClick={()=>goToNotification(n)}
                            className="w-full flex items-start gap-2.5 px-3.5 py-2.5 text-left hover:bg-slate-50">
                            {n.type==="friend"
                              ?<UserPlus size={14} className="text-blue-500 mt-0.5 shrink-0"/>
                              :<Bell size={14} className="text-amber-500 mt-0.5 shrink-0"/>}
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-slate-800 truncate">{n.label}</span>
                              <span className="block text-xs text-slate-500">{n.sub}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            <ProfileDropdown user={currentUser} player={players.find(p=>p.id===currentUser.id)} onLogout={handleLogout} onOpenProfil={()=>setShowProfil(true)} onOpenFriends={()=>setShowFriends(true)} onOpenIntro={()=>setShowIntro(true)} onDeleteProfile={()=>setShowDeleteProfile(true)}/>
          </div>
        </div>

        {/* Overblikket er nu det faste billede — der navigeres ikke længere til det via en fane.
            "Opret Huddle" åbnes i stedet som et vindue ovenpå, se nedenfor. */}
        <KaptajnOverblik players={players} setPlayers={setPlayers} avail={avail} setAvail={setAvail} baseMonday={baseMonday} today={today} setTab={setTab} currentUser={currentUser} invitations={invitations} setInvitations={setInvitations} matches={matches} setMatches={setMatches} lockedPlayers={lockedPlayers} setLockedPlayers={setLockedPlayers} drafts={drafts} setDrafts={setDrafts} setOpenDraftId={setOpenDraftId} friends={friends} setFriends={setFriends} templates={templates} setTemplates={setTemplates} friendRequests={friendRequests} myPendingInvites={myPendingInvites} onCancelPendingInvite={cancelPendingInvite} onAcceptFriendRequest={acceptFriendRequest} onDeclineFriendRequest={declineFriendRequest} onSendFriendRequest={sendFriendRequest} onCancelFriendRequest={cancelFriendRequest} focusInvitationId={focusInvitationId} setFocusInvitationId={setFocusInvitationId} collapseAllSignal={collapseAllSignal}/>
        {tab==="forespoergsel"&&(
          <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-4">
            <div className="bg-slate-50 rounded-2xl shadow-2xl w-full max-w-2xl p-4 sm:p-6" style={{maxHeight:"90vh",overflowY:"auto"}}>
              <OpretForespoergsel players={players} setPlayers={setPlayers} setAvail={setAvail} currentUser={currentUser} invitations={invitations} setInvitations={setInvitations} today={today} setTab={setTab} drafts={drafts} setDrafts={setDrafts} openDraftId={openDraftId} setOpenDraftId={setOpenDraftId} friends={friends} setFriends={setFriends} myPendingInvites={myPendingInvites} onCancelPendingInvite={cancelPendingInvite} friendRequests={friendRequests} onSendFriendRequest={sendFriendRequest} onCancelFriendRequest={cancelFriendRequest}/>
            </div>
          </div>
        )}
        {tab==="kalender"&&<SpillerKalender currentUser={currentUser} players={players} avail={avail} setAvail={setAvail} invitations={invitations} setInvitations={setInvitations} baseMonday={baseMonday} today={today} templates={templates} setTemplates={setTemplates} lockedPlayers={lockedPlayers} setLockedPlayers={setLockedPlayers}/>}

        <p className="text-center text-[11px] text-slate-400 pt-2 pb-1">© {new Date().getFullYear()} Rikabilly Production</p>
      </div>
    </div>
  );
}
