# Lead Finder

Găsește pensiuni, cabane și hoteluri din România care **nu au website** pe Google Maps — ca să le poți contacta și să le vinzi un site.

Folosește **Google Places API (New)**, aceeași sursă de date pe care o vezi în Google Maps.

## Ce face

- Caută după tip (pensiune, cabană, hotel…) + zonă scrisă SAU o **zonă aleasă pe hartă** (apeși un punct + rază în km, ex: 15 km în jurul Brașovului acoperă Moieciu, Poiana Brașov etc.)
- Afișează pentru fiecare loc: nume, telefon, adresă, nr. recenzii, nr. poze, dacă are website, link Google Maps
- Buton **„Detalii"** care deschide, în pagină, poze + telefon + website + recenzii + hartă — fără să mai schimbi tab-ul
- Buton **WhatsApp** cu mesaj pre-completat (editabil, cu `{nume}` înlocuit automat) — la apăsare marchează lead-ul „Contactat"
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
   - Selector adâncime căutare: **Rapid (20) = 1 cerere**, Mediu (40) = 2, Complet (60) = 3.
   - Baza de date evită re-căutările — folosește „Ascunde cele deja găsite".

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

## Note

- Google returnează maxim **60 de rezultate per căutare**. Pentru o regiune mare, caută oraș cu oraș (oricum vrei să țintești local).
- Unele locuri nu au telefonul completat pe Google Maps — filtrul „doar cu telefon" le ascunde.
- Costul: fiecare căutare completă (până la 3 pagini) ≈ 0,10–0,12$. Cu creditul gratuit lunar, faci peste o mie de căutări fără să plătești.
