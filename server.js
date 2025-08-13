// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { fetch } = require("undici");

/* ------------------------- ENV + BASICS ------------------------- */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // sk_...
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ""; // whsec_...
const RESERVATIONS_GAS_URL  = (process.env.RESERVATIONS_GAS_URL || "").replace(/\/$/, "");
const GAS_TOKEN             = process.env.GAS_TOKEN || ""; // optional auth token for GAS

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// Comma-separated list of allowed origins (no trailing slashes)
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
  if (!origin) return cb(null, true); // same-origin / curl / server-to-server
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
// Preflight
app.options("*", cors(corsConfig));

/* ----------------- Stripe webhook (raw body) ------------------ */
/* Mount this BEFORE express.json(). */
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
        case "checkout.session.completed": {
          // Session finished; PI exists & is authorized soon after confirmation
          const session = event.data.object;
          const reservationId = session.client_reference_id || session?.metadata?.reservation_id || "";
          const piId = session.payment_intent || "";
          if (reservationId && piId) {
            await attachPIToReservation(reservationId, piId, "requires_capture");
          }
          break;
        }
        case "payment_intent.amount_capturable_updated": {
          // Authorization placed and capturable
          const pi = event.data.object;
          const reservationId = pi?.metadata?.reservation_id || "";
          if (reservationId) {
            // Ensure attachment (idempotent on GAS side) and mark authorized
            await attachPIToReservation(reservationId, pi.id, "authorized");
          }
          break;
        }
        case "payment_intent.canceled": {
          const pi = event.data.object;
          const reservationId = pi?.metadata?.reservation_id || "";
          if (reservationId) await setPreauthStatus(reservationId, "released");
          break;
        }
        case "payment_intent.succeeded": {
          // Succeeded after capture
          const pi = event.data.object;
          const reservationId = pi?.metadata?.reservation_id || "";
          if (reservationId) await setPreauthStatus(reservationId, "captured");
          break;
        }
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const reservationId = pi?.metadata?.reservation_id || "";
          if (reservationId) await setPreauthStatus(reservationId, "failed");
          break;
        }
        default:
          // noop
          break;
      }
    } catch (err) {
      console.error("Webhook processing error:", err);
      // Return 200 so Stripe doesn't retry forever for non-fatal GAS hiccups
    }
    return res.status(200).send("ok");
  }
);

/* ------------- Now parse JSON for the rest of routes --------- */
app.use(express.json());

/* ------------------------- Health Check ------------------------- */
app.get("/", (req, res) => res.status(200).send("OK"));

/* --------------- Create Stripe Checkout Session --------------- */
/** Expects JSON:
 *  {
 *    amount_cents, currency?, location, city, state, email,
 *    hours, arrivalDate, arrivalTime (12h label), reservation_id?
 *  }
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      amount_cents,
      currency = "usd",
      location = "",
      city = "",
      state = "",
      email = "",
      hours = "1",
      arrivalDate = "",
      arrivalTime = "",
      reservation_id = ""
    } = req.body || {};

    // Validate amount (min 50 cents to avoid zero)
    const amount = Number.isFinite(Number(amount_cents))
      ? Math.max(50, Math.floor(Number(amount_cents)))
      : 0;
    if (!amount) return res.status(400).json({ error: "Invalid amount_cents" });

    // Build success/cancel URLs safely
    const successUrlObj = new URL(CONFIRM_URL);
    successUrlObj.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
    if (reservation_id) successUrlObj.searchParams.set("reservation_id", reservation_id);
    if (location)       successUrlObj.searchParams.set("location", location);
    const success_url = successUrlObj.toString();

    const cancelUrlObj = new URL(`${PROFILE_URL_BASE}/${encodeURIComponent(location)}.html`);
    cancelUrlObj.searchParams.set("payment", "cancelled");
    const cancel_url = cancelUrlObj.toString();

    // Idempotency to avoid duplicate sessions on double-clicks
    const options = reservation_id ? { idempotencyKey: `checkout_${reservation_id}` } : {};

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email || undefined,
      client_reference_id: reservation_id || undefined, // helpful in Stripe dashboard
      payment_method_types: ["card"],
      // Authorize now; capture later after host approval
      payment_intent_data: {
        capture_method: "manual",
        metadata: { location, city, state, hours, arrivalDate, arrivalTime, reservation_id }
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amount,
          product_data: {
            name: `Reserved Slip — ${location}`,
            description: `${[city, state].filter(Boolean).join(", ")} — ${arrivalDate} ${arrivalTime} • ${hours} hour(s)`
          }
        }
      }],
      success_url,
      cancel_url
    }, options);

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "create_session_failed" });
  }
});

/* ----------------- Lookup session for confirm page ----------------- */
app.get("/checkout-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent", "customer"]
    });
    const pi = session.payment_intent;

    const out = {
      id: session.id,
      customer_email: session.customer_details?.email || session.customer_email || "",
      amount_total: session.amount_total, // cents
      currency: session.currency,
      payment_status: session.payment_status, // may be "paid" before capture
      pi_status: pi?.status,                 // "requires_capture" means auth-only
      captured: pi?.charges?.data?.[0]?.captured || false,
      authorization_last4: pi?.charges?.data?.[0]?.payment_method_details?.card?.last4 || "",
      location: pi?.metadata?.location || "",
      city: pi?.metadata?.city || "",
      state: pi?.metadata?.state || "",
      hours: pi?.metadata?.hours || "",
      arrivalDate: pi?.metadata?.arrivalDate || "",
      arrivalTime: pi?.metadata?.arrivalTime || "",
      reservation_id: pi?.metadata?.reservation_id || session.client_reference_id || ""
    };

    // Optional: attach PI to the sheet here as a backup (idempotent on GAS)
    if (RESERVATIONS_GAS_URL && out.reservation_id && pi?.id) {
      attachPIToReservation(out.reservation_id, pi.id, pi.status === "requires_capture" ? "authorized" : "pending")
        .catch(err => console.warn("attachPI (from confirm) failed", err.message));
    }

    res.json(out);
  } catch (err) {
    console.error("checkout-session error:", err);
    res.status(500).json({ error: "lookup_failed" });
  }
});

/* ---------------- Optional: capture/release helpers ---------------- */
/** If you prefer the dashboard to call Render for capture/release instead of Apps Script */
app.post("/capture", async (req, res) => {
  try {
    const { payment_intent_id, amount_cents } = req.body || {};
    if (!payment_intent_id) return res.status(400).json({ error: "missing payment_intent_id" });
    const args = {};
    if (Number.isFinite(Number(amount_cents)) && Number(amount_cents) > 0) {
      args.amount_to_capture = Math.floor(Number(amount_cents));
    }
    const pi = await stripe.paymentIntents.capture(payment_intent_id, args);
    // Update sheet (best-effort)
    const reservationId = pi?.metadata?.reservation_id;
    if (RESERVATIONS_GAS_URL && reservationId) {
      setPreauthStatus(reservationId, "captured").catch(()=>{});
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

/* ----------------------- GAS helpers ------------------------- */
function q(obj){
  const u = new URLSearchParams();
  Object.entries(obj).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== "") u.append(k, String(v)); });
  return u.toString();
}

async function attachPIToReservation(reservationId, piId, preauthStatus){
  if (!RESERVATIONS_GAS_URL) return;
  const url = `${RESERVATIONS_GAS_URL}?action=attachpi&${q({
    reservation_id: reservationId,
    payment_intent_id: piId,
    preauth_status: preauthStatus || "requires_capture",
    token: GAS_TOKEN || undefined
  })}`;
  const r = await fetch(url, { method: "GET", redirect: "follow" });
  if (!r.ok) throw new Error(`attachPI http ${r.status}`);
}

async function setPreauthStatus(reservationId, status){
  if (!RESERVATIONS_GAS_URL) return;
  const url = `${RESERVATIONS_GAS_URL}?action=setpreauth&${q({
    reservation_id: reservationId,
    preauth_status: status,
    token: GAS_TOKEN || undefined
  })}`;
  const r = await fetch(url, { method: "GET", redirect: "follow" });
  if (!r.ok) throw new Error(`setPreauth http ${r.status}`);
}
