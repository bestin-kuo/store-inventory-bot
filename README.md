# store-inventory-bot

LINE bot for store inventory management, deployed on Netlify Functions.

## Stack
- Netlify Functions (Node 20)
- LINE Messaging API
- Supabase
- Anthropic Claude API

## Local dev

    npm install
    netlify dev

## Endpoints
- POST /.netlify/functions/webhook — LINE webhook receiver
