# Lead Finder

Găsește pensiuni, cabane și hoteluri din România care **nu au website** pe Google Maps — ca să le poți contacta și să le vinzi un site.

Folosește **Google Places API (New)**, aceeași sursă de date pe care o vezi în Google Maps.

## Ce face

- Caută după tip (pensiune, cabană, hotel, a-frame, bungalow…) + zonă scrisă SAU o **zonă aleasă pe hartă** (apeși un punct + rază în km, ex: 15 km în jurul Brașovului acoperă Moieciu, Poiana Brașov etc.)
- **Zonele mari sunt împărțite automat în zone mai mici** (tiling), ca să nu rămânem blocați la limita Google de 60 de rezultate per cerere — vezi „Cum caută" mai jos
- Afișează pentru fiecare loc: nume, telefon, adresă, nr. recenzii, nr. poze, dacă are website, link Google Maps
- Buton **„Detalii"** care deschide, în pagină, poze + telefon + website + recenzii + hartă — fără să mai schimbi tab-ul
- Buton **WhatsApp** care deschide direct **aplicația** (nu tab-ul web) cu mesaj pre-completat (editabil, cu `{nume}` înlocuit automat) — la apăsare marchează lead-ul „Contactat"
- **★ De contactat** — pune un lead pe o listă scurtă pentru follow-up în masă mai târziu
- **Filtru pe zonă** (județ → localitate) în tab-ul Salvate, ca filtru principal
- Când marchezi un lead (contactat/ignorat), **dispare din listă** ca să rămână doar ce ai de făcut
- **Scor + sortare**: leadurile bune (fără website + cu telefon + active) urcă sus automat („Recomandate")
- **Mod contactare**: treci prin listă unul câte unul — WhatsApp + următorul, dintr-un singur buton
- **De urmărit**: leadurile contactate acum 3+ zile, fără răspuns, apar separat pentru follow-up
- **Tablou**: statistici totale + pe județe, și o hartă cu zonele deja căutate (acoperire)
- **Bază de date live (Supabase)** care reține tot ce ai găsit — nu mai scrii pe nimeni de două ori, și e partajată în timp real între toți cei care folosesc aplicația (ex: tu + altă persoană, fiecare de pe laptopul ei) — când unul marchează un lead „Contactat", celălalt vede schimbarea imediat, fără refresh
- Status pentru fiecare lead: Nou / Contactat / Client / Ignorat, + notițe
- Filtre (toggle): doar fără website · doar cu telefon · doar cu recenzii · doar cu poze · ascunde cele deja găsite
- **Export CSV** pentru lista filtrată
- **Contor de cereri** către Google, afișat în colț, ca să-ți vezi consumul

## Cum NU depășești cota gratuită

Două niveluri de protecție:

1. **Limita reală — în Google Cloud (obligatoriu de setat o dată):**
   - **APIs & Services → Places API (New) → Quotas** — pune o limită zilnică de cereri (ex: 100/zi). Peste ea, Google refuză cererile în loc să te taxeze.
   - **Billing → Budgets & alerts** — creează un buget (ex: 10$) cu alertă pe email. Te anunță înainte să cheltui.
2. **În aplicație:**
   - Contorul „cereri azi" din colț (devine galben peste 80).
   - Selector adâncime căutare: **Rapid = 1 pagină/zonă**, Mediu = 2, Complet = 3 — e per zonă, nu per căutare (vezi mai jos), așa că numărul real de cereri arătat sub formular ("≈ X cereri / zonă") trebuie înmulțit cu numărul de zone pentru o arie mare.
   - Estimarea exactă de cereri (și câte zone au fost folosite) apare sub rezultate, după fiecare căutare.
   - Baza de date evită re-căutările — leadurile deja salvate sunt marcate „deja salvat" și ascunse automat (toggle „Ascunde cele deja găsite").

> **Despre poze:** fiecare poză încărcată la „Detalii" e o cerere separată către Google (SKU „Photo"). De aceea pozele se încarcă doar când deschizi „Detalii" și sunt limitate la 6 per loc. Harta din „Detalii" e gratuită (embed fără cheie). Harta pentru alegerea zonei folosește OpenStreetMap — complet gratuită, nu consumă nimic din Google.

## Setup (o singură dată)

**1. Google Places API**

1. Intră pe [Google Cloud Console](https://console.cloud.google.com/) și creează un proiect nou.
2. La **APIs & Services → Library**, caută și activează **„Places API (New)"**.
3. La **APIs & Services → Credentials**, apasă **Create credentials → API key**. Copiază cheia.
   - (Recomandat) Apasă pe cheie → **Restrict key** → API restrictions → alege „Places API (New)".
4. Activează **Billing** pe proiect. Google oferă **200$ credit gratuit pe lună**, suficient pentru ~1.500+ căutări. Practic nu plătești nimic.

**2. Supabase (baza de date live)**

1. Intră pe [supabase.com](https://supabase.com), creează un cont (gratuit) și un proiect nou.
2. În proiect, **SQL Editor → New query**, lipește tot conținutul fișierului [`supabase/schema.sql`](supabase/schema.sql) și apasă **Run**. Asta creează tabelele, regulile de securitate și activează Realtime pe `leads`.
3. **Project Settings → API** — copiază: `Project URL`, `anon public` key, `service_role` key (acesta e secret, nu îl pune niciodată în cod sau pe client).

**3. Fișierul `.env.local`**

Copiază `.env.local.example` în `.env.local` și completează toate valorile:

```
GOOGLE_PLACES_API_KEY=cheia_ta_google
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=cheia_anon
SUPABASE_SERVICE_ROLE_KEY=cheia_service_role
```

**4. Dacă vii dintr-o versiune mai veche** (cu date în `data/db.json`), importă-le o singură dată:

```sh
node --env-file=.env.local scripts/migrate-to-supabase.mjs
```

## Rulare

```sh
npm install
npm run dev
```

Deschide [localhost:3000](http://localhost:3000).

## Deploy (Vercel) — ca să folosești aplicația de pe orice laptop/telefon

1. Pe [vercel.com](https://vercel.com), **Add New → Project**, importă acest repo din GitHub (e nevoie să fie pe GitHub — `git push` dacă nu e deja).
2. La pasul de configurare, sub **Environment Variables**, adaugă exact cele 4 variabile din `.env.local` (aceleași nume, aceleași valori).
3. **Deploy**. Vercel îți dă un URL public (`ceva.vercel.app`) — acela e link-ul pe care îl folosești și tu, și ea, de pe orice device.
4. La fiecare `git push` pe `master`, Vercel redeploy-ează automat.

**E gratuit?** Da, pentru acest volum de folosire: planul **Hobby** al Vercel ($0) și planul **Free** al Supabase ($0) sunt amândouă suficiente. Singurul cost real e API-ul Google Places, care e separat și nu se schimbă cu hosting-ul.

> ⚠️ Aplicația deployată e accesibilă oricui are link-ul — nu are încă un ecran de login. E ok pentru tine + ea (link-ul nu e public altundeva), dar nu-l distribui mai departe. Dacă vrei o parolă/login, e un pas separat (Supabase Auth) — nu e implementat momentan.

## Cum caută (important)

Google limitează **fiecare cerere** la maxim 60 de rezultate per căutare după cuvânt (Text Search, 3 pagini de 20) și 20 per căutare după categorie (Nearby) — asta e o limită impusă de Google, nu un setting al aplicației, și nu poate fi „ridicată" dintr-un parametru. Peste limită, Google pur și simplu nu mai trimite restul, indiferent câte pagini ceri.

Ca să vezi totuși mai mult de 60 de locuri într-o zonă densă (ex. în jurul Brașovului), aplicația **împarte automat zona căutată într-o grilă de zone mai mici** ("tiling") și interoghează fiecare zonă separat, apoi combină și elimină duplicatele:

- **Mod „Scrie zona"**: textul scris (ex. „Brașov") e mai întâi localizat pe hartă (geocodare gratuită, OpenStreetMap/Nominatim) pentru a obține un centru + o rază; de aici încolo merge prin același mecanism ca mai jos. Dacă localizarea eșuează, cade înapoi pe o căutare simplă (ca înainte).
- **Mod „Alege pe hartă"**: zona aleasă (centru + rază) e împărțită direct în zone mai mici dacă e prea mare.
- În fiecare zonă rulează: o căutare per tip ales (cuvânt) + o căutare **după categorie** (tip Google: `lodging`, `guest_house`, `cottage`, `bed_and_breakfast`…, redusă la tipurile relevante pentru ce ai bifat — ex. „camping" nu mai aduce hoteluri din centru). Asta prinde și locurile numite „A-Frame", „Mountain Chalet" etc., fără să aducă cazări urbane generice care n-au de ce să vrea un site (gen camere/airbnb-uri random din oraș).
- Numărul de zone e plafonat (momentan 16) ca să nu explodeze costul — pentru o arie foarte mare, zonele devin automat mai mari (mai puțin temeinic per zonă) ca să rămână sub plafon. Pentru control fin, preferă raze mai mici și caută de mai multe ori — căutările repetate nu duplică nimic, leadurile deja salvate sunt marcate și ascunse automat.

## Note

- Unele locuri nu au telefonul completat pe Google Maps — filtrul „doar cu telefon" le ascunde.
- Costul: fiecare cerere ≈ 0,04$ (SKU cu telefon+website). O căutare mică (o singură zonă) costă la fel ca înainte; o zonă mare împărțită în 10-16 zone costă proporțional mai mult — numărul exact apare sub rezultate după fiecare căutare. Cu creditul gratuit lunar de 200$, ai oricum mii de cereri disponibile.
