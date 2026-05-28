# Flag Guess Who 🏳️

A two-player flag guessing game. One player picks a secret flag, the other asks yes/no questions to figure it out.

## Features
- 12 or 24 flag board
- Local (pass the phone) or Online multiplayer
- Yes/No question system — one action per turn (ask OR guess)
- Wrong guess = lose your turn
- Rollback system — both players must agree
- Flag elimination by tapping
- Full turn history log

## Project Structure
```
flag-guess-who/
├── public/
│   └── index.html     ← entire frontend (HTML + CSS + JS)
├── server.js          ← Socket.io backend
├── package.json
└── README.md
```

## Local Development
```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Render (for online multiplayer)

1. Push this folder to a GitHub repo
2. Go to https://render.com → New Web Service
3. Connect your GitHub repo
4. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: Node
5. Deploy — copy the URL (e.g. `https://flag-guess-who.onrender.com`)

## After deploying to Render

Open `public/index.html` and find this line at the bottom of the `<script>` section:
```js
const socket = io();
```
Change it to:
```js
const socket = io('https://YOUR-APP.onrender.com');
```

## Deploy frontend to Vercel (optional)

If you want the frontend on Vercel and backend on Render:
1. Update the `io()` call with your Render URL
2. Deploy just the `public/` folder to Vercel

## Game Rules
- Each turn: ask ONE yes/no question OR make ONE guess
- Wrong guess = you lose your turn (but game continues)
- Correct guess = you win!
- Rollback: request to undo last action — both players must accept
- Eliminate flags by tapping them on the board
