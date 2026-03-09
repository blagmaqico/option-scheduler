# Option Chain Scheduler — Instrukcja wdrożenia

## Co to robi
Serwer Node.js działający 24/7 na Render.com (darmowy hosting).
Automatycznie pobiera option chain z Yahoo Finance i wysyła email
o zaplanowanych godzinach (pon–pt), nawet gdy masz zamkniętą przeglądarkę.

---

## Krok 1 — GitHub (wymagany do Render)

1. Załóż konto na https://github.com (jeśli nie masz)
2. Kliknij **New repository** → nazwa: `option-scheduler` → Public → **Create**
3. Wgraj wszystkie pliki z tego folderu do repozytorium
   (możesz przeciągnąć pliki przez interfejs GitHub)

Struktura repozytorium:
```
option-scheduler/
├── package.json
├── render.yaml
├── src/
│   └── server.js
└── public/
    └── index.html
```

---

## Krok 2 — Render.com (darmowy hosting)

1. Idź na https://render.com → **Sign Up** (możesz zalogować się przez GitHub)
2. Kliknij **New +** → **Web Service**
3. Wybierz swoje repozytorium `option-scheduler`
4. Ustawienia:
   - **Name**: option-chain-scheduler
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Kliknij **Create Web Service**
6. Po ~2 minutach dostaniesz adres URL, np. `https://option-chain-scheduler.onrender.com`

---

## Krok 3 — Konfiguracja Gmail App Password

> Standardowe hasło Gmail NIE zadziała — potrzebny jest App Password.

1. Idź na https://myaccount.google.com/security
2. Upewnij się że masz włączone **2-Step Verification**
3. Wyszukaj **App passwords** → wybierz "Mail" i "Other (Custom name)"
4. Wpisz nazwę np. "OptionScheduler" → **Generate**
5. Skopiuj wygenerowane 16-znakowe hasło (np. `abcd efgh ijkl mnop`)

---

## Krok 4 — Konfiguracja na stronie

1. Otwórz swój adres Render, np. `https://option-chain-scheduler.onrender.com`
2. Wypełnij sekcję **Konfiguracja Email**:
   - Serwis: Gmail
   - Login: twoj@gmail.com
   - Hasło: wklej App Password z kroku 3
   - Email odbiorcy: adres na który mają przychodzić maile
   - Data wygasania: wybierz datę expiration opcji
3. Dodaj tickery (np. SPY, QQQ)
4. Ustaw godziny wysyłki
5. Kliknij **Zapisz** → przetestuj **Testowy email**
6. Włącz przełącznik **Scheduler**

---

## Uwagi

- **Free tier Render**: serwer "usypia" po 15 min bezczynności.
  Po przebudzeniu (pierwsze zapytanie) potrzebuje ~30 sek.
  Sam scheduler (cron) działa normalnie nawet gdy strona jest uśpiona —
  godzinowe zadania budzą serwer automatycznie.

- Jeśli chcesz mieć 100% pewność że serwer nie uśnie,
  możesz ustawić darmowy "uptime monitor" na https://uptimerobot.com
  który co 5 minut odpytuje endpoint `/health` Twojego serwera.

- Dane z Yahoo Finance są darmowe i nie wymagają klucza API.
  Działa dla tickerów notowanych na giełdach US (NYSE, NASDAQ).

---

## Zmiana godzin

Wejdź na swoją stronę → zmień godziny w sekcji Harmonogram →
kliknij × przy starej godzinie, dodaj nową → Zapisz.
Serwer natychmiast zaktualizuje crony.
