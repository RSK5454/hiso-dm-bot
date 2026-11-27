# High Society DM Bot — live test version

A web page where anyone with the link can chat with the real AI booking bot and watch bookings,
deposits and handovers land on the staff desk. Built by Akshaara Group.

## What's inside
- `server.js` — the bot server (no extra packages needed)
- `knowledge.js` — prices, tables and everything the bot knows. Edit this to change answers.
- `public/index.html` — the chat page + staff desk
- `public/privacy.html` — privacy policy (also needed later for Meta), served at `/privacy`

## Render settings
| Setting | Value |
|---|---|
| Language | Node |
| Build command | `npm install` |
| Start command | `node server.js` |
| Instance type | Starter (free plan sleeps after 15 min and wipes the test bookings) |

Environment variables:
| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com (required) |
| `DEMO_PIN` | a code testers must type, e.g. `2026` (recommended, protects your API credit) |
| `DAILY_LIMIT` | max AI replies per day, e.g. `400` (optional) |

## Good to know
- Test bookings live in memory. They reset when the server restarts or redeploys.
- Each guest chat stops after 40 messages; start a new guest chat to keep testing.
- The QR code is a test picture and cannot take payment.
