// server.js (CommonJS)
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

/* ------------------------- ENV + BASICS ------------------------- */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // sk_...
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");

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
app.use(express.json());

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
// Make sure OPTIONS preflight always responds
app.options("*", cors(corsConfig));

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
      payment_status: session.payment_status, // can be "paid" before capture
      pi_status: pi?.status,                 // "requires_capture" means auth-only
      captured: pi?.charges?.data?.[0]?.captured || false,
      authorization_last4: pi?.charges?.data?.[0]?.payment_method_details?.card?.last4 || "",
      location: pi?.metadata?.location || "",
      city: pi?.metadata?.city || "",
      state: pi?.metadata?.state || "",
      hours: pi?.metadata?.hours || "",
      arrivalDate: pi?.metadata?.arrivalDate || "",
      arrivalTime: pi?.metadata?.arrivalTime || "",
      reservation_id: pi?.metadata?.reservation_id || ""
    };

    res.json(out);
  } catch (err) {
    console.error("checkout-session error:", err);
    res.status(500).json({ error: "lookup_failed" });
  }
});

/* --------------------------- Start --------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Stripe backend listening on ${PORT}`));
