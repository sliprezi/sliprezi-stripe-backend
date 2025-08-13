// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const fetch = globalThis.fetch; // Node 18+ has fetch built-in

/* ------------------------- ENV + BASICS ------------------------- */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // sk_...
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ""; // whsec_...
const RESERVATIONS_GAS_URL  = (process.env.RESERVATIONS_GAS_URL || "").replace(/\/$/, "");
const GAS_TOKEN             = process.env.GAS_TOKEN || ""; // optional auth token for GAS

// Connect flow + optional fees
const CONNECT_RETURN_URL  = (process.env.CONNECT_RETURN_URL  || "https://dashboard-sliprezi-2.tiiny.site/connect/return").replace(/\/$/, "");
const CONNECT_REFRESH_URL = (process.env.CONNECT_REFRESH_URL || "https://dashboard-sliprezi-2.tiiny.site/connect/refresh").replace(/\/$/, "");
const CONNECT_BUSINESS_TYPE = process.env.CONNECT_BUSINESS_TYPE || ""; // "company" | "individual" | ""
const CONNECT_ACCOUNT_COUNTRY = process.env.CONNECT_ACCOUNT_COUNTRY || ""; // e.g. "US"

// Optional platform fee (choose one or neither)
const APPLICATION_FEE_BPS   = Number(process.env.APPLICATION_FEE_BPS || 0);
const APPLICATION_FEE_CENTS_FIXED = Number(process.env.APPLICATION_FEE_CENTS_FIXED || 0);

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// CORS
const parseOrigins = (s) =>
  (s || "")
    .split(",")
    .map(x => x.trim().replace(/\/$/, ""))
    .filter(Boolean);

const ALLOW_ORIGINS = parseOrigins(process.env.CORS_ORIGINS);
// e.g. CORS_ORIGINS="https://sliprezi-reserve-final.tiiny.site,https://sliprezi-master-final.tiiny.site,https://sliprezi-reservation-confirmation.tiiny.site"

// Where your confirmation page lives (we append query params here)
const CONFIRM_URL = (process.env.CONFIRM_URL || "https://sliprezi-reservation-confirmation.tiiny.site").replace(/\/$/, "");

// Where your profile pages live (for cancel route back)
const PROFILE_URL_BASE = (process.env.PROFILE_URL_BASE || "https://sliprezi-master-final.tiiny.site").replace(/\/$/, "");

const app = express();

/* --------------------------- CORS --------------------------- */
const normalize = (o) => (o || "").replace(/\/$/, "");
const corsOrigin = (origin, cb) => {
  if (!origin) return cb(null, true);
  const ok = ALLOW_ORIGINS.length === 0 || ALLOW_ORIGINS.includes(normalize(origin));
  return ok ? cb(null, true) : cb(new Error("Not allowed by CORS: " + origin));
};

const corsConfig = {
  origin: corsOrigin,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
};

app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

/* ----------------- Stripe webhook (raw body) ------------------ */
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.warn("Webhook received but STRIPE_WEBHOOK_SECRET is not set.");
      return res.status(200).send("ignored");
    }
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verify failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        // 🔹 New: finished Setup (we saved a card, no money moved)
        case "checkout.session.completed": {
          const session = event.data.object;
          if (session.mode === "setup") {
            const reservationId = session.client_reference_id || session?.metadata?.reservation_id || "";
            const setupIntentId = session.setup_intent || "";
            const customerId = session.customer || session.customer_details?.id || session.client_reference_id || "";
            if (reservationId && setupIntentId) {
              // Get the payment_method from the SetupIntent
              const si = await stripe.setupIntents.retrieve(setupIntentId);
              const pmId = si?.payment_method || "";
              await saveSetupForReservation({
                reservationId,
                customerId: si?.customer || customerId || "",
                paymentMethodId: pmId || "",
                connectedAccountId: session?.metadata?.connected_account_id || ""
              });
              // Optional: mark sheet so UI can show “Card on file”
              await setPreauthStatus(reservationId, "card_on_file");
            }
          }
          break;
        }

        // 🔹 Off-session charge outcomes after approval
        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const reservationId = pi?.metadata?.reservation_id || "";
          if (reservationId) await setPreauthStatus(reservationId, "paid");
          break;
        }
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const reservationId = pi?.metadata?.reservation_id || "";
          if (reservationId) await setPreauthStatus(reservationId, "failed");
          break;
        }
        default: break;
      }
    } catch (err) {
      console.error("Webhook processing error:", err);
      // 200 anyway; we don't want infinite retries for transient GAS hiccups
    }
    return res.status(200).send("ok");
  }
);

/* ------------- Now parse JSON for the rest of routes --------- */
app.use(express.json());

/* ------------------------- Health Check ------------------------- */
app.get("/", (req, res) => res.status(200).send("OK"));

/* ----------------------- CONNECT: Get Paid ----------------------- */
app.get("/connect/get-paid", async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: "Missing location" });

    let accountId = await getStripeAccountIdForLocation(location);

    if (!accountId) {
      const acctPayload = {
        type: "express",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      };
      if (CONNECT_BUSINESS_TYPE) acctPayload.business_type = CONNECT_BUSINESS_TYPE;
      if (CONNECT_ACCOUNT_COUNTRY) acctPayload.country = CONNECT_ACCOUNT_COUNTRY;

      const acct = await stripe.accounts.create(acctPayload);
      accountId = acct.id;
      await saveStripeAccountIdForLocation(location, accountId);
    }

    const acct = await stripe.accounts.retrieve(accountId);
    const needsOnboarding =
      !acct.details_submitted ||
      (acct.requirements?.currently_due?.length ?? 0) > 0 ||
      (acct.requirements?.past_due?.length ?? 0) > 0;

    if (needsOnboarding) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        refresh_url: `${CONNECT_REFRESH_URL}?location=${encodeURIComponent(location)}`,
        return_url: `${CONNECT_RETURN_URL}?location=${encodeURIComponent(location)}`
      });
      return res.json({ url: link.url, mode: "onboarding", account_id: accountId });
    }

    const login = await stripe.accounts.createLoginLink(accountId);
    return res.json({ url: login.url, mode: "login", account_id: accountId });
  } catch (e) {
    console.error("GET /connect/get-paid error:", e);
    res.status(500).json({ error: e.message || "connect_get_paid_failed" });
  }
});

app.get("/connect/login", async (req, res) => {
  try {
    const { location } = req.query;
    if (!location) return res.status(400).json({ error: "Missing location" });

    const accountId = await getStripeAccountIdForLocation(location);
    if (!accountId) return res.status(404).json({ error: "No Stripe account for location yet" });

    const login = await stripe.accounts.createLoginLink(accountId);
    return res.json({ url: login.url, mode: "login", account_id: accountId });
  } catch (e) {
    console.error("GET /connect/login error:", e);
    res.status(500).json({ error: e.message || "connect_login_failed" });
  }
});

/* --------------- CREATE “SETUP” CHECKOUT SESSION --------------- */
/**
 * Front-end calls this for PAID requests (guaranteed):
 *  {
 *    location, city, state, email, hours, arrivalDate, arrivalTime, reservation_id
 *  }
 * We DO NOT charge or place a hold here. We only collect & save a card (SetupIntent).
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      location = "",
      city = "",
      state = "",
      email = "",
      hours = "1",
      arrivalDate = "",
      arrivalTime = "",
      reservation_id = ""
    } = req.body || {};

    if (!email) return res.status(400).json({ error: "email_required" });
    if (!location) return res.status(400).json({ error: "location_required" });

    // Success/cancel
    const successUrlObj = new URL(CONFIRM_URL);
    successUrlObj.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
    if (reservation_id) successUrlObj.searchParams.set("reservation_id", reservation_id);
    if (location)       successUrlObj.searchParams.set("location", location);
    const success_url = successUrlObj.toString();

    const cancelUrlObj = new URL(`${PROFILE_URL_BASE}/${encodeURIComponent(location)}.html`);
    cancelUrlObj.searchParams.set("payment", "cancelled");
    const cancel_url = cancelUrlObj.toString();

    // Get Connect account for this location (if any), to store on metadata for later off-session charge
    const connectedAccountId = location ? (await getStripeAccountIdForLocation(location)) : null;

    // Find or create a platform Customer for this email
    const customer = await findOrCreateCustomerByEmail(email);

    // Idempotency across retries
    const options = reservation_id ? { idempotencyKey: `setup_${reservation_id}` } : {};

    // ✅ Setup-mode Checkout (creates SetupIntent; no money moves)
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customer.id,
      customer_email: email,
      client_reference_id: reservation_id || undefined,
      success_url,
      cancel_url,
      // Store context for later (webhook + /approve)
      metadata: {
        location, city, state, hours, arrivalDate, arrivalTime,
        reservation_id,
        connected_account_id: connectedAccountId || ""
      },
      setup_intent_data: {
        metadata: {
          location, city, state, hours, arrivalDate, arrivalTime,
          reservation_id,
          connected_account_id: connectedAccountId || ""
        }
      },
      payment_method_types: ["card"]
    }, options);

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session (setup) error:", err);
    return res.status(500).json({ error: "create_setup_session_failed" });
  }
});

/* ----------------- LOOKUP session (confirm page) ----------------- */
app.get("/checkout-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["setup_intent", "customer"]
    });

    const out = {
      id: session.id,
      mode: session.mode, // "setup"
      customer_id: session.customer || session.setup_intent?.customer || "",
      customer_email: session.customer_details?.email || session.customer_email || "",
      location: session.metadata?.location || "",
      city: session.metadata?.city || "",
      state: session.metadata?.state || "",
      hours: session.metadata?.hours || "",
      arrivalDate: session.metadata?.arrivalDate || "",
      arrivalTime: session.metadata?.arrivalTime || "",
      reservation_id: session.metadata?.reservation_id || session.client_reference_id || "",
      setup_intent_id: session.setup_intent || "",
      payment_method_id: session.setup_intent && typeof session.setup_intent === "object"
        ? session.setup_intent.payment_method
        : undefined
    };

    // Best-effort: store setup artifacts if not already (idempotent on GAS)
    if (RESERVATIONS_GAS_URL && out.reservation_id && out.setup_intent_id) {
      try {
        const si = await stripe.setupIntents.retrieve(out.setup_intent_id);
        await saveSetupForReservation({
          reservationId: out.reservation_id,
          customerId: si?.customer || out.customer_id || "",
          paymentMethodId: si?.payment_method || "",
          connectedAccountId: session?.metadata?.connected_account_id || ""
        });
        await setPreauthStatus(out.reservation_id, "card_on_file");
      } catch (e) {
        console.warn("confirm saveSetup failed:", e.message);
      }
    }

    res.json(out);
  } catch (err) {
    console.error("checkout-session error:", err);
    res.status(500).json({ error: "lookup_failed" });
  }
});

/* -------------------- APPROVE (charge later) -------------------- */
/**
 * Dashboard calls this when a location APPROVES a paid request.
 * Body:
 *  {
 *    reservation_id, amount_cents, currency?, location
 *  }
 * Server looks up saved customer & payment_method via GAS, then charges off-session.
 * If SCA is needed, returns { status:"action_required", url: <Checkout link> }
 */
app.post("/approve", async (req, res) => {
  try {
    const { reservation_id, amount_cents, currency = "usd", location = "" } = req.body || {};
    if (!reservation_id) return res.status(400).json({ error: "missing reservation_id" });

    const amount = Number.isFinite(Number(amount_cents))
      ? Math.max(50, Math.floor(Number(amount_cents)))
      : 0;
    if (!amount) return res.status(400).json({ error: "invalid amount_cents" });

    // Fetch saved artifacts from GAS
    const payinfo = await getPaymentInfoForReservation(reservation_id);
    if (!payinfo?.customer_id || !payinfo?.payment_method_id) {
      return res.status(400).json({ error: "missing_customer_or_payment_method" });
    }

    const connectedAccountId = payinfo.connected_account_id || (location ? (await getStripeAccountIdForLocation(location)) : null);
    const applicationFeeAmount = computeApplicationFee(amount);

    // Create & confirm off-session charge
    try {
      const pi = await stripe.paymentIntents.create({
        amount,
        currency,
        customer: payinfo.customer_id,
        payment_method: payinfo.payment_method_id,
        off_session: true,
        confirm: true,
        metadata: { reservation_id, location },
        transfer_data: connectedAccountId ? { destination: connectedAccountId } : undefined,
        application_fee_amount: connectedAccountId && applicationFeeAmount > 0 ? applicationFeeAmount : undefined,
        statement_descriptor_suffix: "SLIPREZI",
        on_behalf_of: connectedAccountId || undefined
      }, {
        idempotencyKey: `approve_${reservation_id}_${amount}`
      });

      // Success
      await setPreauthStatus(reservation_id, "paid");
      return res.json({ status: "succeeded", payment_intent_id: pi.id });
    } catch (e) {
      // SCA required or similar: fall back to hosted Checkout to finish
      const pi = e?.payment_intent;
      if (pi && (e.code === "authentication_required" || pi.status === "requires_action")) {
        const successUrlObj = new URL(CONFIRM_URL);
        successUrlObj.searchParams.set("reservation_id", reservation_id);
        successUrlObj.searchParams.set("payment_intent_id", pi.id);
        const success_url = successUrlObj.toString();

        const cancelUrlObj = new URL(`${PROFILE_URL_BASE}/${encodeURIComponent(location || "")}.html`);
        cancelUrlObj.searchParams.set("payment", "incomplete");
        const cancel_url = cancelUrlObj.toString();

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          payment_intent: pi.id,
          success_url,
          cancel_url
        }, { idempotencyKey: `sca_${reservation_id}_${amount}` });

        await setPreauthStatus(reservation_id, "payment_action_required");
        return res.json({ status: "action_required", url: session.url });
      }
      console.error("approve charge error:", e);
      await setPreauthStatus(reservation_id, "failed").catch(()=>{});
      return res.status(400).json({ status: "failed", error: e.message || "charge_failed" });
    }
  } catch (err) {
    console.error("POST /approve error:", err);
    return res.status(500).json({ error: "approve_failed" });
  }
});

/* ---------------- Optional: legacy capture/release -------------- */
/* Kept for backwards compatibility if you still run auth+capture anywhere */
app.post("/capture", async (req, res) => {
  try {
    const { payment_intent_id, amount_cents } = req.body || {};
    if (!payment_intent_id) return res.status(400).json({ error: "missing payment_intent_id" });
    const args = {};
    if (Number.isFinite(Number(amount_cents)) && Number(amount_cents) > 0) {
      args.amount_to_capture = Math.floor(Number(amount_cents));
    }
    const pi = await stripe.paymentIntents.capture(payment_intent_id, args);
    const reservationId = pi?.metadata?.reservation_id;
    if (RESERVATIONS_GAS_URL && reservationId) {
      setPreauthStatus(reservationId, "paid").catch(()=>{});
    }
    return res.json({ status: "ok", payment_intent: pi.id });
  } catch (err) {
    console.error("capture error:", err);
    return res.status(500).json({ error: "capture_failed" });
  }
});

app.post("/release", async (req, res) => {
  try {
    const { payment_intent_id } = req.body || {};
    if (!payment_intent_id) return res.status(400).json({ error: "missing payment_intent_id" });
    const pi = await stripe.paymentIntents.cancel(payment_intent_id);
    const reservationId = pi?.metadata?.reservation_id;
    if (RESERVATIONS_GAS_URL && reservationId) {
      setPreauthStatus(reservationId, "released").catch(()=>{});
    }
    return res.json({ status: "ok", payment_intent: pi.id });
  } catch (err) {
    console.error("release error:", err);
    return res.status(500).json({ error: "release_failed" });
  }
});

/* --------------------------- Start --------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stripe backend listening on ${PORT}`));

/* ----------------------- Helpers ------------------------- */
function q(obj){
  const u = new URLSearchParams();
  Object.entries(obj).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== "") u.append(k, String(v)); });
  return u.toString();
}

function computeApplicationFee(amountCents){
  let fee = 0;
  if (APPLICATION_FEE_BPS > 0) fee += Math.floor((amountCents * APPLICATION_FEE_BPS) / 10000);
  if (APPLICATION_FEE_CENTS_FIXED > 0) fee += APPLICATION_FEE_CENTS_FIXED;
  return fee;
}

async function fetchJSON(url){
  const r = await fetch(url, { method: "GET", redirect: "follow", headers: { "Accept": "application/json" } });
  if (r.status === 404) return null;
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

// Look up / save the location's Connect account
async function getStripeAccountIdForLocation(locationName){
  if (!RESERVATIONS_GAS_URL) return null;
  const url = `${RESERVATIONS_GAS_URL}?${q({ action: "getacct", location: locationName, token: GAS_TOKEN || undefined })}`;
  try {
    const data = await fetchJSON(url);
    const acct = data && (data.account_id || data.accountId);
    return acct && String(acct).startsWith("acct_") ? String(acct) : null;
  } catch (e) {
    console.warn("getStripeAccountIdForLocation failed:", e.message);
    return null;
  }
}
async function saveStripeAccountIdForLocation(locationName, accountId){
  if (!RESERVATIONS_GAS_URL) return false;
  const url = `${RESERVATIONS_GAS_URL}?${q({ action: "setacct", location: locationName, account_id: accountId, token: GAS_TOKEN || undefined })}`;
  const r = await fetch(url, { method: "GET", redirect: "follow" });
  return r.ok;
}

// Customers
async function findOrCreateCustomerByEmail(email){
  // Try to find an existing Customer by email
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data && existing.data[0]) return existing.data[0];
  return await stripe.customers.create({ email });
}

/** Save Setup artifacts to the reservation row via GAS.
 * GAS should accept:
 *  action=savesetup&reservation_id=...&customer_id=cus_...&payment_method_id=pm_...&account_id=acct_...&token=...
 */
async function saveSetupForReservation({ reservationId, customerId, paymentMethodId, connectedAccountId }){
  if (!RESERVATIONS_GAS_URL || !reservationId) return;
  const url = `${RESERVATIONS_GAS_URL}?${q({
    action: "savesetup",
    reservation_id: reservationId,
    customer_id: customerId || "",
    payment_method_id: paymentMethodId || "",
    account_id: connectedAccountId || "",
    token: GAS_TOKEN || undefined
  })}`;
  const r = await fetch(url, { method: "GET", redirect: "follow" });
  if (!r.ok) throw new Error(`savesetup http ${r.status}`);
}

/** Fetch saved customer/payment method for a reservation.
 * GAS should return JSON:
 *  { customer_id: "cus_...", payment_method_id: "pm_...", connected_account_id: "acct_..." }
 */
async function getPaymentInfoForReservation(reservationId){
  if (!RESERVATIONS_GAS_URL) return null;
  const url = `${RESERVATIONS_GAS_URL}?${q({
    action: "getpayinfo",
    reservation_id: reservationId,
    token: GAS_TOKEN || undefined
  })}`;
  return await fetchJSON(url);
}

// Status helper (reuse your existing column)
async function setPreauthStatus(reservationId, status){
  if (!RESERVATIONS_GAS_URL) return;
  const url = `${RESERVATIONS_GAS_URL}?${q({
    action: "setpreauth",
    reservation_id: reservationId,
    preauth_status: status,
    token: GAS_TOKEN || undefined
  })}`;
  await fetch(url, { method: "GET", redirect: "follow" });
}
