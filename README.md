# Willow Market — fictional ecommerce qualification store

A substantial full-stack Next.js/Payload ecommerce application, derived from the official MIT-licensed Payload ecommerce template at v3.80.0. See UPSTREAM-PROVENANCE.json, UPSTREAM-README.md and LICENSE.md.

This is a fictional demonstration store. Only Stripe TEST payments are allowed; no real money is charged and no physical goods are shipped. Customer and order records are synthetic.

## Stack

Next.js 16.2.0, React 19.2.4, Payload 3.80.0 with its ecommerce plugin, Postgres and Stripe TEST. The existing backend owns catalog, carts, customers, addresses, transactions and orders. Vroic adoption must preserve that backend and add its signed operations contract inside this application.

## Run

Use Node 24, copy .env.example into managed development configuration, install with pnpm, create/apply Payload migrations, run `pnpm seed:demo`, then `pnpm dev`. Never seed an existing customer database. See the upstream guide for automated integration/browser tests.

## Deployment prerequisites

Use a newly created isolated Postgres database and Vercel Blob store. Set the names listed in `.env.example` through managed hosting secrets. Generate/apply Payload migrations before running the additive `seed:demo` script. Supply a random admin password of at least 24 characters and genuine Stripe TEST keys/webhook secret. The application rejects live Stripe keys. No repository `.env` file is part of Vroic import.
