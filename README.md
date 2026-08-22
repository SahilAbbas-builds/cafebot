# CafeBot

Café web app.

## Structure

- `frontend/` — index.html, styles.css, app.js
- `backend/` — server-side code (Express app that also serves `frontend/` as static files)
- `data/` — data files
- `prompts/` — prompt templates

## Features & Architecture

### White-labeling

The site and chat assistant are re-skinned entirely from one file: `data/brand.config.json`
(`cafeName`, `tagline`, `assistantName`, `logoIcon`, `colors.primary/primaryDark/accent`,
`images.hero`/`heroAlt`). Editing it and restarting the server re-skins the café name, tagline,
logo, accent colors, hero photo, and the AI assistant's own name/persona — no other file needs
to change. The backend serves it at `GET /api/brand`; `frontend/app.js` fetches that endpoint
and applies the values to the page (text via `[data-brand]` attributes, colors via CSS custom
properties), and `frontend/staff.html` does the same for its own title/heading. The assistant's
system prompt (`prompts/system-prompt.md`) uses `{{CAFE_NAME}}`/`{{ASSISTANT_NAME}}` placeholders
that the backend fills in from the same config before each request.

### Chat assistant tools

The chat assistant (`POST /api/chat`) is given the following tools to answer questions and take
orders, each backed by real menu/order data rather than the model's own memory:

- `getMenu` — look up the current menu (available items only)
- `addItemToCart` — add a menu item (with size/options) to the order
- `modifyItem` — change the quantity, size, or options of an item already in the order
- `removeItem` — remove an item, or reduce its quantity
- `viewCart` — summarize the current order's items and state
- `applyPromotion` — check/apply a real promotion code against the order
- `setPickupDetails` — capture pickup name and optional pickup time
- `setDeliveryDetails` — capture delivery name, phone, and address
- `calculateOrderTotal` — compute the exact subtotal/tax/total from real prices
- `getOrderSummary` — build the full structured order summary shown before checkout
- `confirmOrder` — save the confirmed order and return its order ID

### Staff dashboard

`frontend/staff.html` (served at `/staff.html`) is a lightweight, unauthenticated dashboard for
viewing incoming orders and advancing their status (`NEW → PREPARING → READY → COMPLETED`) via
`GET /api/orders` and `PATCH /api/orders/:id/status`.

## Setup

1. Install dependencies:
   ```
   cd backend
   npm install
   ```
2. Copy `.env.example` to `.env` in the project root and fill in real values:
   ```
   ANTHROPIC_API_KEY=your-key-here
   PORT=3000
   ```
   `.env` is git-ignored — never commit it.

## Running locally

From `backend/`:
```
npm start
```
The site (frontend + API) is served at `http://localhost:3000` (or `$PORT` if set). The staff dashboard is at `/staff.html`.

## Deployment notes

- `PORT` is read from the environment; the host's assigned port is used automatically if set.
- `ANTHROPIC_API_KEY` must be set in the deployment environment's own secret/env var store — never bake it into the repo or image.
- Order storage (`data/orders.json`) is plain file-based read/write, meant for development and demos only — it has no locking, concurrency control, or durability guarantee, and will not reliably persist on platforms with an ephemeral or read-only filesystem (e.g. serverless functions). Replace with a real database before running this in production. See the comment above `ORDERS_PATH` in `backend/server.js` for details.
