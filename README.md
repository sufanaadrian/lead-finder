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
- **Bază de date locală** care reține tot ce ai găsit (`data/db.json`) — nu mai scrii pe nimeni de două ori
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

1. Intră pe [Google Cloud Console](https://console.cloud.google.com/) și creează un proiect nou.
2. La **APIs & Services → Library**, caută și activează **„Places API (New)"**.
3. La **APIs & Services → Credentials**, apasă **Create credentials → API key**. Copiază cheia.
   - (Recomandat) Apasă pe cheie → **Restrict key** → API restrictions → alege „Places API (New)".
4. Activează **Billing** pe proiect. Google oferă **200$ credit gratuit pe lună**, suficient pentru ~1.500+ căutări. Practic nu plătești nimic.
5. În folderul proiectului, copiază `.env.local.example` în `.env.local` și pune cheia:
   ```
   GOOGLE_PLACES_API_KEY=cheia_ta_aici
   ```

## Rulare

```sh
npm install
npm run dev
```

Deschide [localhost:3000](http://localhost:3000).

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
