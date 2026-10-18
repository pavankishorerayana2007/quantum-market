# Quantum Market – full-stack project (Vercel + PostgreSQL)

Your original screens and design are unchanged. All demo data was removed. The website starts **completely empty**:
no users, no products, no orders, no fake numbers. Everything shown comes from real sign-ups and real actions.

## How it works (simple version)
- `public/index.html` – your website (same look). It now talks to the server instead of keeping fake data in the browser.
- `api/*.js` – the server code that Vercel runs (login, orders, payments, commission, admin tools).
- `lib/*.js` – shared server code. All money, stock, commission and permission rules are checked **here**, not in the browser.
- `db/schema.sql` – creates the empty database tables.
- `scripts/` – two one-time helper commands (`migrate`, `create-admin`).
- `test/` – automatic tests.

## Files
Created: everything in this folder except `public/index.html`, which is your original file, edited (demo data, fake accounts, fake QR, localStorage and in-browser logic removed; server calls added).

## Step 1 – Install the tools (once)
1. Install Node.js 20 or newer from https://nodejs.org (choose "LTS").
2. Install VS Code and Git if you do not have them. Create a free GitHub account.

## Step 2 – Open the project in VS Code
Unzip the folder, then in VS Code choose File > Open Folder and select `quantum-market`.
Open the terminal (Terminal > New Terminal). Every command below is run in **this folder** (the one containing `package.json`).

## Step 3 – Install and test on your computer
```
npm install
npm test
```
`npm test` runs 17 tests and uses a temporary in-memory database. It does not touch any real data.

## Step 4 – Create the production database (no demo data)
1. Go to https://neon.tech, sign up (free), create a project, and copy the **connection string** (starts with `postgresql://`).
2. Make your local settings file: copy `.env.example` to a new file named `.env` and fill in:
   - `DATABASE_URL` = the Neon connection string
   - `AUTH_SECRET` = a long random text. Make one by running:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `UPI_ID` and `UPI_PAYEE_NAME` = where buyers/owners pay (your real UPI ID)
3. Load the settings and create the empty tables.
   - Mac/Linux: `export $(grep -v '^#' .env | xargs)` then `npm run migrate`
   - Windows PowerShell: set each value, for example `$env:DATABASE_URL="postgresql://..."`, then `npm run migrate`
   You should see: "Database tables are ready. No demo data was added."

## Step 5 – Create YOUR administrator (one time)
There is no default admin and no default password. You create the only admin yourself:
- Mac/Linux: `ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="a-long-password-12+" npm run create-admin`
- Windows PowerShell: `$env:ADMIN_EMAIL="you@example.com"; $env:ADMIN_PASSWORD="a-long-password-12+"; npm run create-admin`
It refuses to run twice. Never add ADMIN_PASSWORD to Vercel or GitHub.

## Step 6 – Put the code on GitHub
Commit everything **except** `.env` and `node_modules` (the included `.gitignore` already excludes them):
```
git init
git add .
git commit -m "Quantum Market"
```
Create an empty repository on GitHub, then run the two commands GitHub shows (`git remote add origin ...` and `git push -u origin main`).
Check on GitHub that there is no `.env` file.

## Step 7 – Deploy on Vercel
1. https://vercel.com > Add New > Project > import your GitHub repository.
2. Framework Preset: **Other**. Leave Build Command and Output Directory empty. Root Directory: the folder with `package.json`.
3. Open "Environment Variables" and add these 4 (same values as in your `.env`):
   `DATABASE_URL`, `AUTH_SECRET`, `UPI_ID`, `UPI_PAYEE_NAME`
4. Click Deploy. Open the URL Vercel gives you.

## Step 8 – Check in Google Chrome
1. Open `https://YOUR-SITE/api/health`. You want `"ready": true` and `"database": "connected"`.
2. Open the site. You should see only the login screen. Log in with the admin you created in Step 5. Dashboards must be empty.
3. Admin > Create Owner > enter an email. A one-time activation link appears. Send it to the owner yourself (no email is sent automatically). The owner opens it and chooses their own name, shop name and password.
4. Register a buyer from the login screen. Add a product as the owner, then buy it as the buyer.
5. Press F12 > Console and Network. There should be no red errors. Test the phone layout with the device icon.

## Step 9 – Troubleshooting
- `/api/health` says database "error": the `DATABASE_URL` in Vercel is wrong. Copy it again from Neon, save, then Deployments > Redeploy.
- Health says AUTH_SECRET false: it is missing or shorter than 32 characters.
- "Server error" on any action: Vercel > your project > Logs > filter "Errors". Messages never contain passwords.
- Login says incorrect: the account must exist in this database. After 5 wrong tries an account locks for 15 minutes.
- Owner link says invalid or expired: Admin > Create Owner > "Get new activation link" (links work once, 7 days).
- Online payment says "not set up": add `UPI_ID` in Vercel and redeploy.
- If a secret was ever pushed to GitHub: rotate it (new Neon password, new `AUTH_SECRET`), update Vercel, redeploy. Changing `AUTH_SECRET` logs everyone out.

## Security summary
Passwords are hashed with scrypt. Login uses a signed HttpOnly, SameSite, Secure cookie. Accounts are re-checked in the database on every request, so suspending an owner or changing a password takes effect immediately. Every action checks the user's role and ownership on the server. Prices, discounts, stock, delivery fee and commission are calculated on the server. Cross-site POSTs are rejected. Payment screenshots are private to the admin, the owner involved and the buyer. Nothing is stored in localStorage.

## Known limits (be aware)
- The cart lives in the browser tab only and is lost on refresh. Orders and everything else are in the database.
- No emails are sent. Owner activation links are copied and sent by the admin.
- Payments are manual: UPI app link + UTR + screenshot, verified by the admin. There is no payment gateway.
- Product and payment images are stored in the database (shrunk to about 1000px in the browser). Fine for a small shop; use object storage (for example Vercel Blob) if you grow.
- Rate limiting is per account (lockout), not per IP.
